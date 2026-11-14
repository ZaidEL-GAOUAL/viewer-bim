// Les lignes de coupe : là où un plan traverse les triangles du modèle. Calcul pur sur `Model.parts` et les boîtes des
// éléments, sans rendu : le contour affiché, le remplissage par couleur d'élément, et plus tard les exports PDF et DXF
// le lisent. Les points sont donnés dans les coordonnées 2D du plan (voir `planeBasis`).
//
// Tout ce qui grandit avec le modèle (boîtes, triangles, boucles, remplissage, assemblage du dessin) est un générateur
// qui s'arrête après `budget` unités de travail : l'appelant enchaîne les tranches à son rythme (et peut abandonner), pour
// ne jamais bloquer le fil principal sur un gros modèle. Une unité : une boîte ou un triangle testé ; un segment relié et
// rempli en vaut huit ; un élément assemblé, un, plus un par 64 nombres recopiés.

import { ShapeUtils, Vector2, Vector3, type Plane } from 'three';
import type { MeshPart } from './meshMath.ts';

/** Ce que la coupe lit d'un modèle (voir `Model`). */
export interface CutModel {
  count: number;
  /** minX, minY, minZ, maxX, maxY, maxZ par élément. */
  boxes: Float32Array;
  parts(index: number): MeshPart[];
  state: { isRendered(index: number): boolean; isOpen(index: number): boolean };
}

/** Travail par défaut entre deux pauses (de l'ordre de la milliseconde). */
export const CUT_BUDGET = 20_000;

export interface CutOptions {
  /** Les éléments à couper ; par défaut ceux qui sont affichés. */
  filter?: (element: number) => boolean;
  /** Distance au plan, en mètres, en deçà de laquelle un sommet est sur le plan. */
  tolerance?: number;
  /** Unités de travail (boîtes, triangles, segments) entre deux pauses. */
  budget?: number;
}

/** Les segments de coupe d'un élément : x0, y0, x1, y1 par segment, en coordonnées du plan. */
export interface ElementCut {
  element: number;
  points: Float32Array;
}

/** Une polyligne de coupe : x, y par point ; une boucle fermée ne répète pas son premier point. */
export interface CutLoop {
  points: Float32Array;
  closed: boolean;
}

/**
 * Le repère 2D d'un plan (normale unitaire) : un point 3D `p` du plan vaut `origin + x·u + y·v`, avec `x = p·u` et
 * `y = p·v` (l'origine, le point du plan le plus proche de zéro, est perpendiculaire à `u` et `v`).
 */
export function planeBasis(plane: Plane): { origin: Vector3; u: Vector3; v: Vector3 } {
  const n = plane.normal;
  const reference = Math.abs(n.y) < 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const u = new Vector3().crossVectors(reference, n).normalize();
  const v = new Vector3().crossVectors(n, u).normalize();
  return { origin: n.clone().multiplyScalar(-plane.constant), u, v };
}

/** Pas de la grille sur laquelle deux extrémités d'arêtes posées sur le plan sont reconnues comme le même point. */
const EDGE_GRID = 1e-5;

/**
 * La coupe découpée en tranches : à chaque pause, la part des triangles déjà traités (0 à 1). Les éléments terminés sont
 * ajoutés à `out` au fur et à mesure ; arrêter le générateur (`return`) abandonne le reste.
 *
 * Un triangle donne un segment s'il a des sommets de part et d'autre du plan (un sommet posé sur le plan est l'une des
 * extrémités). Une arête posée sur le plan ne compte que si l'élément a des triangles des deux côtés le long d'elle : la
 * matière traverse le plan. Un plan posé sur une face d'un solide ne coupe donc rien.
 */
export function* cutJob(model: CutModel, plane: Plane, options: CutOptions, out: ElementCut[]): Generator<number, void, unknown> {
  const filter = options.filter ?? ((element: number) => model.state.isRendered(element));
  const tol = options.tolerance ?? 1e-6;
  const budget = options.budget ?? CUT_BUDGET;
  const { x: nx, y: ny, z: nz } = plane.normal;
  const c = plane.constant;
  const { u, v } = planeBasis(plane);

  // 1. Les boîtes d'abord : seuls les éléments dont la boîte traverse le plan sont parcourus.
  const boxes = model.boxes;
  const candidates: number[] = [];
  let total = 0, sinceYield = 0;
  for (let i = 0; i < model.count; i++) {
    if (++sinceYield >= budget) {
      sinceYield = 0;
      yield 0;
    }
    const at = i * 6;
    if (!(boxes[at] <= boxes[at + 3])) continue; // élément sans géométrie
    const centre = nx * (boxes[at] + boxes[at + 3]) / 2 + ny * (boxes[at + 1] + boxes[at + 4]) / 2 + nz * (boxes[at + 2] + boxes[at + 5]) / 2 + c;
    const half = (Math.abs(nx) * (boxes[at + 3] - boxes[at]) + Math.abs(ny) * (boxes[at + 4] - boxes[at + 1]) + Math.abs(nz) * (boxes[at + 5] - boxes[at + 2])) / 2;
    if (centre - half > tol || centre + half < -tol || !filter(i)) continue;
    candidates.push(i);
    for (const part of model.parts(i)) total += part.count / 3;
  }

  // 2. Les triangles des éléments retenus.
  let done = 0;
  const segments: number[] = [];
  const corner = [0, 0, 0, 0, 0, 0];
  const d = [0, 0, 0], s = [0, 0, 0];
  for (const element of candidates) {
    segments.length = 0;
    // Arêtes posées sur le plan : leurs extrémités et les côtés (1 = devant, 2 = derrière) des triangles qui les portent.
    let onPlane: Map<string, { points: number[]; sides: number }> | null = null;
    for (const { positions: p, index, start, count } of model.parts(element)) {
      for (let k = start, end = start + count; k < end; k += 3) {
        done++;
        if (++sinceYield >= budget) {
          sinceYield = 0;
          yield done / total;
        }
        const ia = index[k] * 3, ib = index[k + 1] * 3, ic = index[k + 2] * 3;
        const da = nx * p[ia] + ny * p[ia + 1] + nz * p[ia + 2] + c, db = nx * p[ib] + ny * p[ib + 1] + nz * p[ib + 2] + c, dc = nx * p[ic] + ny * p[ic + 1] + nz * p[ic + 2] + c;
        // La plupart des triangles sont d'un seul côté : rejetés sans rien allouer.
        if ((da > tol && db > tol && dc > tol) || (da < -tol && db < -tol && dc < -tol)) continue;
        // Un triangle qui touche le plan coûte environ huit triangles rejetés.
        sinceYield += 7;
        d[0] = da; d[1] = db; d[2] = dc;
        for (let j = 0; j < 3; j++) s[j] = d[j] > tol ? 1 : d[j] < -tol ? -1 : 0;
        for (let j = 0, at = ia; j < 3; j++, at = j === 1 ? ib : ic) {
          corner[2 * j] = p[at] * u.x + p[at + 1] * u.y + p[at + 2] * u.z;
          corner[2 * j + 1] = p[at] * v.x + p[at + 1] * v.y + p[at + 2] * v.z;
        }
        if (s.includes(1) && s.includes(-1)) {
          // Deux extrémités : un sommet posé sur le plan, ou le croisement d'une arête qui le traverse.
          for (let j = 0; j < 3; j++) {
            const n = (j + 1) % 3;
            if (s[j] === 0) segments.push(corner[2 * j], corner[2 * j + 1]);
            if (s[j] * s[n] < 0) {
              const t = d[j] / (d[j] - d[n]);
              segments.push(corner[2 * j] + t * (corner[2 * n] - corner[2 * j]), corner[2 * j + 1] + t * (corner[2 * n + 1] - corner[2 * j + 1]));
            }
          }
        } else if ((s[0] === 0 ? 1 : 0) + (s[1] === 0 ? 1 : 0) + (s[2] === 0 ? 1 : 0) === 2) {
          const off = s.findIndex((x) => x !== 0);
          const a = (off + 1) % 3, b = (off + 2) % 3;
          const ka = `${Math.round(corner[2 * a] / EDGE_GRID)},${Math.round(corner[2 * a + 1] / EDGE_GRID)}`;
          const kb = `${Math.round(corner[2 * b] / EDGE_GRID)},${Math.round(corner[2 * b + 1] / EDGE_GRID)}`;
          const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
          onPlane ??= new Map();
          const edge = onPlane.get(key);
          if (edge) edge.sides |= s[off] > 0 ? 1 : 2;
          else onPlane.set(key, { points: [corner[2 * a], corner[2 * a + 1], corner[2 * b], corner[2 * b + 1]], sides: s[off] > 0 ? 1 : 2 });
        }
      }
    }
    for (const edge of onPlane?.values() ?? []) if (edge.sides === 3) segments.push(...edge.points);
    if (segments.length > 0) out.push({ element, points: Float32Array.from(segments) });
  }
}

/** La coupe d'un modèle par un plan, d'un seul tenant. Sur un gros modèle, préférer `cutJob` par tranches. */
export function cutSegments(model: CutModel, plane: Plane, options: CutOptions = {}): ElementCut[] {
  const out: ElementCut[] = [];
  for (const _ of cutJob(model, plane, { ...options, budget: Infinity }, out)) { /* d'un seul tenant */ }
  return out;
}

/** Ce qu'un plan coupe, prêt à dessiner, élément par élément, dans le repère du modèle donné (celui du viewer). */
export interface PlaneCut {
  elements: number[];
  /** Segments (deux points 3D chacun) des boucles fermées d'un solide fermé : le trait plein. */
  closedLines: Float32Array[];
  /** Les autres segments (maillage ouvert, boucle qui ne se ferme pas) : les tirets. */
  openLines: Float32Array[];
  /** Triangles 3D du remplissage, vide pour un maillage ouvert. */
  fills: Float32Array[];
}

export const emptyPlaneCut = (): PlaneCut => ({ elements: [], closedLines: [], openLines: [], fills: [] });

/**
 * La coupe d'un plan prête à dessiner, par tranches : les segments (`cutJob`), puis, élément par élément, ses boucles
 * (`chainLoops`, à `chainTolerance` près) et son remplissage (`fillTriangles`), ajoutés à `out`. Avancement de 0 à 1.
 */
export function* cutPlane(model: CutModel, plane: Plane, out: PlaneCut, options: CutOptions & { chainTolerance?: number } = {}): Generator<number, void, unknown> {
  const budget = options.budget ?? CUT_BUDGET;
  const cuts: ElementCut[] = [];
  for (const progress of cutJob(model, plane, options, cuts)) yield progress * 0.8;
  const { origin, u, v } = planeBasis(plane);
  const to3d = (points: Float32Array, target: Float32Array, at: number) => {
    for (let i = 0; i < points.length; i += 2, at += 3) {
      target[at] = origin.x + points[i] * u.x + points[i + 1] * v.x;
      target[at + 1] = origin.y + points[i] * u.y + points[i + 1] * v.y;
      target[at + 2] = origin.z + points[i] * u.z + points[i + 1] * v.z;
    }
  };
  let work = 0;
  for (let index = 0; index < cuts.length; index++) {
    const { element, points } = cuts[index];
    const loops = chainLoops(points, options.chainTolerance ?? 1e-4);
    const open = model.state.isOpen(element);
    // Trait plein : les boucles fermées d'un solide fermé ; tout le reste en tirets.
    const lines = (solid: boolean) => {
      const chosen = loops.filter((loop) => (!open && loop.closed) === solid);
      const count = chosen.reduce((sum, loop) => sum + loop.points.length / 2 - (loop.closed ? 0 : 1), 0);
      const target = new Float32Array(count * 6);
      let at = 0;
      for (const loop of chosen) {
        const n = loop.points.length / 2;
        for (let i = 0; i < (loop.closed ? n : n - 1); i++, at += 6) {
          const j = (i + 1) % n;
          to3d(loop.points.subarray(2 * i, 2 * i + 2), target, at);
          to3d(loop.points.subarray(2 * j, 2 * j + 2), target, at + 3);
        }
      }
      return target;
    };
    const flat = open ? new Float32Array(0) : fillTriangles(loops);
    const fill = new Float32Array((flat.length / 2) * 3);
    to3d(flat, fill, 0);
    out.elements.push(element);
    out.closedLines.push(lines(true));
    out.openLines.push(lines(false));
    out.fills.push(fill);
    // Relier et remplir un segment coûte environ huit tests de triangle (mesuré sur la « Tour ») ; un élément, une trentaine.
    work += 32 + 2 * points.length;
    if (work >= budget) {
      work = 0;
      yield 0.8 + (0.2 * (index + 1)) / cuts.length;
    }
  }
}

/** Le dessin d'un plan : traits pleins, tirets (deux points 3D par segment), triangles et leur couleur (r, g, b par sommet). */
export interface CutDrawing {
  solid: Float32Array;
  dashed: Float32Array;
  fill: Float32Array;
  colors: Float32Array;
}

/**
 * Réunit le dessin d'un plan pour les éléments montrés, par tranches : `rendered` dit si l'élément est affiché, `filled`
 * s'il est rempli (opaque), `color` sa couleur de remplissage. Une passe compte, une seconde recopie dans des tableaux
 * alloués une seule fois. Avancement de 0 à 1, le dessin en retour.
 */
export function* assembleCut(
  cut: PlaneCut, rendered: (element: number) => boolean, filled: (element: number) => boolean,
  color: (element: number) => readonly [number, number, number], budget = CUT_BUDGET,
): Generator<number, CutDrawing, unknown> {
  const n = cut.elements.length;
  // 0 : caché, 1 : traits, 2 : traits et remplissage.
  const shown = new Uint8Array(n);
  let solid = 0, dashed = 0, fill = 0, work = 0;
  for (let i = 0; i < n; i++) {
    const element = cut.elements[i];
    if (rendered(element)) {
      shown[i] = cut.fills[i].length > 0 && filled(element) ? 2 : 1;
      solid += cut.closedLines[i].length;
      dashed += cut.openLines[i].length;
      if (shown[i] === 2) fill += cut.fills[i].length;
    }
    if (++work >= budget) {
      work = 0;
      yield (0.5 * (i + 1)) / n;
    }
  }
  const drawing: CutDrawing = { solid: new Float32Array(solid), dashed: new Float32Array(dashed), fill: new Float32Array(fill), colors: new Float32Array(fill) };
  let s = 0, d = 0, f = 0;
  for (let i = 0; i < n; i++) {
    work++;
    if (shown[i]) {
      drawing.solid.set(cut.closedLines[i], s);
      s += cut.closedLines[i].length;
      drawing.dashed.set(cut.openLines[i], d);
      d += cut.openLines[i].length;
      if (shown[i] === 2) {
        const triangles = cut.fills[i];
        drawing.fill.set(triangles, f);
        const [r, g, b] = color(cut.elements[i]);
        for (let j = f; j < f + triangles.length; j += 3) [drawing.colors[j], drawing.colors[j + 1], drawing.colors[j + 2]] = [r, g, b];
        f += triangles.length;
      }
      work += (cut.closedLines[i].length + cut.openLines[i].length + (shown[i] === 2 ? cut.fills[i].length : 0)) / 64;
    }
    if (work >= budget) {
      work = 0;
      yield 0.5 + (0.5 * (i + 1)) / n;
    }
  }
  return drawing;
}

/**
 * Relie les segments d'un élément (x0, y0, x1, y1…) en polylignes : fermées quand le solide l'est, ouvertes sinon. Deux
 * extrémités à moins de `tolerance` sont le même point ; un point au milieu d'une ligne droite est retiré.
 */
export function chainLoops(segments: Float32Array, tolerance: number): CutLoop[] {
  const xs: number[] = [], ys: number[] = [];
  // Grille de pas `tolerance`, clés numériques : deux cases peuvent partager une clé, la distance tranche.
  const cells = new Map<number, number[]>();
  const cellKey = (cx: number, cy: number) => cx * 1_000_003 + cy;
  const node = (x: number, y: number): number => {
    const cx = Math.floor(x / tolerance), cy = Math.floor(y / tolerance);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const cell = cells.get(cellKey(cx + i, cy + j));
      if (cell) for (const id of cell) if (Math.abs(xs[id] - x) <= tolerance && Math.abs(ys[id] - y) <= tolerance) return id;
    }
    const id = xs.push(x) - 1;
    ys.push(y);
    const key = cellKey(cx, cy);
    const cell = cells.get(key);
    if (cell) cell.push(id); else cells.set(key, [id]);
    return id;
  };
  const ends: number[] = [];
  const seen = new Set<number>();
  for (let i = 0; i + 3 < segments.length; i += 4) {
    const a = node(segments[i], segments[i + 1]), b = node(segments[i + 2], segments[i + 3]);
    const key = a < b ? a * 4_294_967_296 + b : b * 4_294_967_296 + a;
    if (a === b || seen.has(key)) continue; // segment nul, ou déjà donné par une face confondue
    seen.add(key);
    ends.push(a, b);
  }
  const adjacent: number[][] = xs.map(() => []);
  for (let e = 0; e < ends.length / 2; e++) {
    adjacent[ends[2 * e]].push(e);
    adjacent[ends[2 * e + 1]].push(e);
  }
  const used = new Uint8Array(ends.length / 2);
  const walk = (start: number): number[] => {
    const path = [start];
    for (let current = start; ;) {
      const edge = adjacent[current].find((e) => !used[e]);
      if (edge === undefined) return path;
      used[edge] = 1;
      current = ends[2 * edge] === current ? ends[2 * edge + 1] : ends[2 * edge];
      path.push(current);
    }
  };
  const loops: CutLoop[] = [];
  // Les lignes ouvertes partent d'un bout (degré impair) ; ce qui reste forme des boucles.
  for (const odd of [true, false]) {
    for (let n = 0; n < xs.length; n++) {
      if ((adjacent[n].length % 2 === 1) !== odd) continue;
      while (adjacent[n].some((e) => !used[e])) {
        const path = walk(n);
        const closed = path.length > 3 && path[path.length - 1] === path[0];
        if (closed) path.pop();
        loops.push({ points: straighten(path, xs, ys, closed, tolerance), closed });
      }
    }
  }
  return loops;
}

/** Retire les points posés sur la droite de leurs voisins (à `tolerance` près) ; les bouts d'une ligne ouverte restent. */
function straighten(path: number[], xs: number[], ys: number[], closed: boolean, tolerance: number): Float32Array {
  // b est entre a et c, sur leur droite à `tolerance` près.
  const between = (a: number, b: number, c: number) => {
    const lx = xs[c] - xs[a], ly = ys[c] - ys[a];
    const length = Math.hypot(lx, ly);
    const along = (xs[b] - xs[a]) * lx + (ys[b] - ys[a]) * ly;
    return length > 0 && along > 0 && along < length * length && Math.abs((xs[b] - xs[a]) * ly - (ys[b] - ys[a]) * lx) <= tolerance * length;
  };
  // Une seule passe, en pile : linéaire même pour une longue ligne droite faite de nombreux segments.
  const kept: number[] = [];
  for (const id of path) {
    while (kept.length >= 2 && between(kept[kept.length - 2], kept[kept.length - 1], id)) kept.pop();
    kept.push(id);
  }
  // Une boucle se referme : son dernier et son premier point peuvent encore être sur une même droite.
  for (let changed = closed; changed && kept.length > 3;) {
    changed = false;
    if (between(kept[kept.length - 2], kept[kept.length - 1], kept[0])) [changed] = [true, kept.pop()];
    else if (between(kept[kept.length - 1], kept[0], kept[1])) [changed] = [true, kept.shift()];
  }
  return Float32Array.from(kept.flatMap((id) => [xs[id], ys[id]]));
}

/** Vrai si le point (x, y) est à l'intérieur de la boucle (règle pair-impair). */
function inside(x: number, y: number, loop: Float32Array): boolean {
  let within = false;
  for (let i = 0, j = loop.length - 2; i < loop.length; j = i, i += 2) {
    const yi = loop[i + 1], yj = loop[j + 1];
    if ((yi > y) !== (yj > y) && x < ((loop[j] - loop[i]) * (y - yi)) / (yj - yi) + loop[i]) within = !within;
  }
  return within;
}

const signedArea = (loop: Float32Array): number => {
  let sum = 0;
  for (let i = 0, j = loop.length - 2; i < loop.length; j = i, i += 2) sum += loop[j] * loop[i + 1] - loop[i] * loop[j + 1];
  return sum / 2;
};

/**
 * Les triangles qui remplissent les boucles fermées d'un élément (x, y par sommet, trois sommets par triangle) : une boucle
 * contenue dans une autre est un trou (un mur et sa fenêtre), une boucle dans un trou redevient pleine. Les lignes ouvertes
 * ne sont pas remplies.
 */
export function fillTriangles(loops: readonly CutLoop[]): Float32Array {
  const points = loops.flatMap((loop) => Array.from(loop.points));
  return Float32Array.from(fillFaces(loops).flatMap((k) => [points[2 * k], points[2 * k + 1]]));
}

/**
 * Comme `fillTriangles`, en indices de points (trois par triangle) : le point `k` de la boucle `i` a l'indice
 * `k + (nombre de points des boucles d'avant i)`. Sert au bouchage des pièces découpées (splitMesh), qui garde ses sommets.
 */
export function fillFaces(loops: readonly CutLoop[]): number[] {
  let total = 0;
  const offsets = loops.map((loop) => (total += loop.points.length / 2) - loop.points.length / 2);
  const closed = loops.map((loop, at) => ({ points: loop.points, at })).filter((_, i) => loops[i].closed && loops[i].points.length >= 6)
    .sort((a, b) => Math.abs(signedArea(b.points)) - Math.abs(signedArea(a.points)));
  // Profondeur d'imbrication et boucle englobante la plus proche (les plus grandes viennent d'abord).
  const depth = closed.map(() => 0), parent = closed.map(() => -1);
  closed.forEach((loop, i) => {
    for (let j = 0; j < i; j++) {
      if (inside(loop.points[0], loop.points[1], closed[j].points)) {
        depth[i]++;
        parent[i] = j;
      }
    }
  });
  const toVectors = (points: Float32Array) => Array.from({ length: points.length / 2 }, (_, k) => new Vector2(points[2 * k], points[2 * k + 1]));
  const out: number[] = [];
  closed.forEach((loop, i) => {
    if (depth[i] % 2 === 1) return;
    const contour = toVectors(loop.points);
    const rings = closed.filter((_, j) => parent[j] === i && depth[j] % 2 === 1);
    const holes = rings.map((hole) => toVectors(hole.points));
    const faces = ShapeUtils.triangulateShape(contour, holes);
    // Les indices sont lus après la triangulation : elle retire un dernier point égal au premier.
    const ids = [contour, ...holes].flatMap((ring, r) => ring.map((_, k) => offsets[r === 0 ? loop.at : rings[r - 1].at] + k));
    for (const face of faces) for (const k of face) out.push(ids[k]);
  });
  return out;
}
