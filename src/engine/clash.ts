// Détection des conflits francs entre deux ensembles d'éléments, sur les triangles du viewer : quel que soit le format.
//
// 1. Phase large : tri et balayage des boîtes des éléments le long de X ; une paire n'est candidate que si ses boîtes se
//    recouvrent de plus que la tolérance sur les trois axes (une pénétration plus profonde l'exige). Au-delà de
//    `maxCandidates` paires, le calcul s'arrête là et le dit (`capped`).
// 2. Phase fine : arbre de boîtes (three-mesh-bvh, MIT) de chaque élément, intersections triangle à triangle. Les segments
//    d'intersection donnent la zone de recouvrement ; sa plus petite dimension (dans le recouvrement des deux boîtes) est la
//    profondeur approchée. Les faces coplanaires (deux éléments qui se touchent) ne comptent pas. Sans intersection de
//    surfaces, un élément entièrement dans un solide fermé est en conflit (profondeur : sa plus petite dimension).
//
// Tout est un travail par tranches (voir `runSliced`) : avancement, arrêt. Repère : celui du viewer.

import { Box3, BufferAttribute, BufferGeometry, DoubleSide, Line3, Matrix4, Ray, Vector3 } from 'three';
import { MeshBVH, type ExtendedTriangle } from 'three-mesh-bvh';
import type { MeshPart } from './meshMath.ts';

/** Ce que la détection lit d'un modèle (`Model` convient). */
export interface ClashModel {
  count: number;
  boxes: Float32Array;
  parts(element: number): MeshPart[];
  /** `isOpen` : vrai si le maillage de l'élément n'est pas un solide fermé ; seul un solide fermé peut en contenir un autre. */
  state?: { isOpen(element: number): boolean };
  /** Éléments dessinés par leur seule boîte (`Model.boxOnly`) : exclus, sauf `ClashOptions.includeBoxOnly`. */
  boxOnly?: { has(element: number): boolean };
}

export interface FoundClash {
  a: number;
  b: number;
  /** Profondeur de pénétration approchée, en mètres. */
  depth: number;
  /** Centre de la zone de recouvrement. */
  point: [number, number, number];
  box: { min: [number, number, number]; max: [number, number, number] };
}

export interface ClashOutcome {
  clashes: FoundClash[];
  /** Paires retenues par la phase large (et testées). */
  candidates: number;
  /** Vrai si la phase large a atteint `maxCandidates` : des paires n'ont pas été testées. */
  capped: boolean;
  /** Éléments des deux ensembles écartés parce que seule leur boîte est connue (leur forme n'a pas été lue). */
  boxOnly: number;
}

export interface ClashOptions {
  /** Pénétration tolérée, en mètres (0,01 par défaut). */
  tolerance?: number;
  maxCandidates?: number;
  /** Vrai pour une paire à ne pas tester (même élément, pièce et original, même hôte…). `a < b`. */
  exclude?(a: number, b: number): boolean;
  /** Tester aussi les éléments dessinés par leur seule boîte : leur boîte donnerait de faux conflits, ils sont exclus par défaut. */
  includeBoxOnly?: boolean;
}

export const MAX_CANDIDATES = 20_000;
/** Triangles gardés en arbres d'une paire à l'autre (≈ 36 octets de sommets chacun, plus l'arbre). */
const CACHE_TRIANGLES = 1_500_000;
/** Segments d'intersection au plus par paire : assez pour la zone de recouvrement, borné pour deux copies d'un même élément. */
const MAX_SEGMENTS = 4096;
/** Unités de travail entre deux pauses : comparaisons de boîtes, ou triangles mis en arbre. */
const BUDGET = 40_000;

/** Les triangles d'un élément, recopiés à plat, et leur arbre de boîtes. */
function elementBvh(model: ClashModel, element: number): { bvh: MeshBVH; triangles: number } {
  const parts = model.parts(element);
  let triangles = 0;
  for (const part of parts) triangles += Math.floor(part.count / 3);
  const positions = new Float32Array(triangles * 9);
  let o = 0;
  for (const { positions: p, index, start, count } of parts) {
    for (let k = start, end = start + count - (count % 3); k < end; k++) {
      const v = index[k] * 3;
      positions[o++] = p[v];
      positions[o++] = p[v + 1];
      positions[o++] = p[v + 2];
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  return { bvh: new MeshBVH(geometry), triangles };
}

const IDENTITY = new Matrix4();
const n1 = new Vector3(), n2 = new Vector3(), delta = new Vector3();
const line = new Line3();
const RAY_DIRECTION = new Vector3(0.5413, 0.6127, 0.5759).normalize();

/** La signature réelle : le troisième argument tait l'avertissement des triangles coplanaires (absent des types). */
type Intersects = (this: ExtendedTriangle, other: ExtendedTriangle, target: Line3, suppressLog: boolean) => boolean;

/** Deux triangles dans un même plan : un contact, pas une pénétration. */
function coplanar(t1: ExtendedTriangle, t2: ExtendedTriangle): boolean {
  t1.getNormal(n1);
  t2.getNormal(n2);
  if (n1.lengthSq() === 0 || n2.lengthSq() === 0 || Math.abs(n1.dot(n2)) < 1 - 1e-6) return false;
  return Math.abs(n1.dot(delta.subVectors(t2.a, t1.a))) < 1e-6;
}

/** Vrai si `point` est dans le solide fermé de `bvh` : le nombre de traversées d'un rayon est impair (un contact au départ ne compte pas). */
function inside(bvh: MeshBVH, point: Vector3): boolean {
  return bvh.raycast(new Ray(point, RAY_DIRECTION), DoubleSide, 1e-6).length % 2 === 1;
}

/** Sommets testés au plus par élément et par paire, pour étendre la zone de recouvrement. */
const SAMPLES = 128;
const vertex = new Vector3();

/**
 * Étend `zone` des sommets de `from` (au plus `limit`, pris régulièrement) qui sont dans `overlap` et dans le solide fermé
 * `into` : l'intersection de deux surfaces courbes est une ligne plate, ces sommets donnent l'épaisseur. Rend leur nombre.
 */
function expandByInside(from: MeshBVH, into: MeshBVH, overlap: Box3, zone: Box3, limit: number): number {
  const positions = from.geometry.attributes.position.array as Float32Array;
  const candidates: number[] = [];
  for (let v = 0; v < positions.length; v += 3) {
    vertex.set(positions[v], positions[v + 1], positions[v + 2]);
    if (overlap.containsPoint(vertex)) candidates.push(v);
  }
  const step = Math.max(1, Math.ceil(candidates.length / limit));
  let found = 0;
  for (let c = 0; c < candidates.length; c += step) {
    const v = candidates[c];
    vertex.set(positions[v], positions[v + 1], positions[v + 2]);
    if (!inside(into, vertex)) continue;
    zone.expandByPoint(vertex);
    found++;
  }
  return found;
}

const boxOf = (boxes: Float32Array, element: number, target: Box3) => target.set(
  new Vector3(boxes[element * 6], boxes[element * 6 + 1], boxes[element * 6 + 2]),
  new Vector3(boxes[element * 6 + 3], boxes[element * 6 + 4], boxes[element * 6 + 5]),
);
const smallest = (box: Box3) => (box.isEmpty() ? 0 : Math.min(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z));

/**
 * Cherche les conflits francs entre l'ensemble `a` et l'ensemble `b` (numéros d'éléments ; ils peuvent se recouvrir :
 * chaque paire n'est testée qu'une fois). Rend l'avancement de 0 à 1 à chaque pause.
 */
export function* clashJob(model: ClashModel, a: readonly number[], b: readonly number[], options: ClashOptions = {}): Generator<number, ClashOutcome, unknown> {
  const tolerance = options.tolerance ?? 0.01;
  const maxCandidates = options.maxCandidates ?? MAX_CANDIDATES;
  const boxes = model.boxes;
  const inA = new Uint8Array(model.count), inB = new Uint8Array(model.count);
  for (const element of a) inA[element] = 1;
  for (const element of b) inB[element] = 1;
  const items: number[] = [];
  let boxOnly = 0;
  for (let i = 0; i < model.count; i++) {
    if (!(inA[i] || inB[i]) || !(boxes[i * 6] <= boxes[i * 6 + 3])) continue;
    if (!options.includeBoxOnly && model.boxOnly?.has(i)) boxOnly++;
    else items.push(i);
  }
  items.sort((x, y) => boxes[x * 6] - boxes[y * 6]);

  // ------------------------------------------------------------ phase large
  const pairs: [number, number][] = [];
  let capped = false, work = 0;
  const active: number[] = [];
  sweep: for (let n = 0; n < items.length; n++) {
    const i = items[n], at = i * 6, minX = boxes[at];
    let kept = 0;
    for (const j of active) if (boxes[j * 6 + 3] > minX + tolerance) active[kept++] = j;
    active.length = kept;
    for (const j of active) {
      if (++work >= BUDGET) {
        work = 0;
        yield 0.1 * (n / items.length);
      }
      if (!((inA[i] && inB[j]) || (inA[j] && inB[i]))) continue;
      const bt = j * 6;
      if (Math.min(boxes[at + 3], boxes[bt + 3]) - minX <= tolerance) continue;
      if (Math.min(boxes[at + 4], boxes[bt + 4]) - Math.max(boxes[at + 1], boxes[bt + 1]) <= tolerance) continue;
      if (Math.min(boxes[at + 5], boxes[bt + 5]) - Math.max(boxes[at + 2], boxes[bt + 2]) <= tolerance) continue;
      const pair: [number, number] = i < j ? [i, j] : [j, i];
      if (options.exclude?.(pair[0], pair[1])) continue;
      if (pairs.length >= maxCandidates) {
        capped = true;
        break sweep;
      }
      pairs.push(pair);
    }
    active.push(i);
  }
  // Les paires d'un même élément se suivent : son arbre sert plusieurs fois.
  pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1]);

  // ------------------------------------------------------------- phase fine
  const cache = new Map<number, { bvh: MeshBVH; triangles: number }>();
  let cached = 0;
  const treeOf = (element: number) => {
    let entry = cache.get(element);
    if (entry) return entry;
    entry = elementBvh(model, element);
    work += entry.triangles;
    cache.set(element, entry);
    cached += entry.triangles;
    for (const [other, old] of cache) {
      if (cached <= CACHE_TRIANGLES || other === element) break;
      old.bvh.geometry.dispose();
      cache.delete(other);
      cached -= old.triangles;
    }
    return entry;
  };
  const clashes: FoundClash[] = [];
  const overlap = new Box3(), boxA = new Box3(), boxB = new Box3(), segments = new Box3();
  for (let p = 0; p < pairs.length; p++) {
    const [ea, eb] = pairs[p];
    const treeA = treeOf(ea), treeB = treeOf(eb);
    boxOf(boxes, ea, boxA);
    boxOf(boxes, eb, boxB);
    overlap.copy(boxA).intersect(boxB);
    segments.makeEmpty();
    let count = 0;
    treeA.bvh.bvhcast(treeB.bvh, IDENTITY, {
      intersectsTriangles: (t1, t2) => {
        if (coplanar(t1, t2) || !(t1.intersectsTriangle as Intersects).call(t1, t2, line, true)) return false;
        segments.expandByPoint(line.start).expandByPoint(line.end);
        return ++count >= MAX_SEGMENTS;
      },
    });
    // Une paire coûte au moins un parcours des deux arbres ; un rayon lancé compte comme 20 triangles.
    work += 200 + Math.min(treeA.triangles, treeB.triangles);
    // La zone : les segments d'intersection, et les sommets de chacun qui sont dans l'autre (solides fermés). Sans
    // surfaces qui se croisent, un seul sommet suffit : l'un est entièrement dans l'autre (la zone est alors sa boîte), ou pas.
    if (count > 0) {
      if (model.state?.isOpen(eb) === false) expandByInside(treeA.bvh, treeB.bvh, overlap, segments, SAMPLES);
      if (model.state?.isOpen(ea) === false) expandByInside(treeB.bvh, treeA.bvh, overlap, segments, SAMPLES);
      work += SAMPLES * 2 * 20;
    } else if (model.state?.isOpen(eb) === false && expandByInside(treeA.bvh, treeB.bvh, boxA, segments, 1) > 0) {
      segments.copy(boxA);
      count = 1;
    } else if (model.state?.isOpen(ea) === false && expandByInside(treeB.bvh, treeA.bvh, boxB, segments, 1) > 0) {
      segments.copy(boxB);
      count = 1;
    }
    const zone = segments.intersect(overlap);
    if (count > 0 && !zone.isEmpty()) {
      const depth = smallest(zone);
      if (depth > tolerance) {
        const centre = zone.getCenter(new Vector3());
        clashes.push({ a: ea, b: eb, depth, point: centre.toArray(), box: { min: zone.min.toArray(), max: zone.max.toArray() } });
      }
    }
    if (work >= BUDGET) {
      work = 0;
      yield 0.1 + 0.9 * ((p + 1) / pairs.length);
    }
  }
  for (const entry of cache.values()) entry.bvh.geometry.dispose();
  return { clashes, candidates: pairs.length, capped, boxOnly };
}
