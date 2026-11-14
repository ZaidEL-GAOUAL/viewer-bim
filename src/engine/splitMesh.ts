// Découpe d'un solide fermé par des plans, bouché des deux côtés : la seule géométrie que le viewer crée (pièces dérivées,
// voir docs/superpowers/plans/2026-11-14-roadmap/06-quantities-zoning.md, partie B). Calcul pur, sans rendu.
//
// Les sommets sont soudés (`weld`, comme les mesures) puis désignés par leur numéro : un point de coupe est créé une fois
// par arête coupée et partagé par les deux triangles qui la bordent, les contours de la section sont les arêtes de bord du
// côté « dessous », reliées par numéro (sans tolérance), et le bouchon reprend exactement ces sommets. Une pièce issue d'un
// solide fermé est donc fermée elle aussi, ce que `solidProblem` vérifie sur chaque pièce (« maillage valide »).

import { Plane, Vector3 } from 'three';
import { weld, type MeshPart } from './meshMath.ts';
import { fillFaces, planeBasis, type CutLoop } from './sectionCut.ts';

/** Un solide indexé : sommets soudés (x, y, z), trois sommets par triangle, un matériau par triangle (indice choisi par l'appelant). */
export interface Solid {
  positions: number[];
  triangles: number[];
  materials: number[];
}

/** Un plan de coupe, `n·p + c = 0` (convention de three.js). `segment` : la ligne dessinée en plan (x, z) qui le porte. */
export interface CutPlane {
  normal: [number, number, number];
  constant: number;
  segment?: { from: [number, number]; to: [number, number] };
}

export interface SplitPart {
  solid: Solid;
  /** Faux si la pièce n'est pas une enveloppe fermée : ses quantités ne sont qu'indicatives. */
  valid: boolean;
  volume: number;
  /** Côté de chaque plan (−1 dessous, 1 dessus) : deux pièces qui ne diffèrent que d'un plan se touchent par lui. */
  sides: number[];
}

/** Les triangles d'un élément, soudés. `materialOf(part, k)` : le matériau du triangle commençant à l'indice `k` de la partie. */
export function solidFromParts(parts: MeshPart[], materialOf: (part: number, k: number) => number = () => 0): Solid {
  const { ids, vertexCount } = weld(parts);
  const positions = new Array<number>(vertexCount * 3).fill(0);
  const seen = new Uint8Array(vertexCount);
  const triangles: number[] = [], materials: number[] = [];
  let c = 0;
  parts.forEach(({ positions: p, index, start, count }, part) => {
    for (let k = start, end = start + count; k + 2 < end; k += 3, c += 3) {
      for (let j = 0; j < 3; j++) {
        const id = ids[c + j];
        if (seen[id]) continue;
        seen[id] = 1;
        const v = index[k + j] * 3;
        positions[id * 3] = p[v];
        positions[id * 3 + 1] = p[v + 1];
        positions[id * 3 + 2] = p[v + 2];
      }
      const a = ids[c], b = ids[c + 1], d = ids[c + 2];
      if (a === b || b === d || a === d) continue; // triangle réduit à un segment par la soudure
      triangles.push(a, b, d);
      materials.push(materialOf(part, k));
    }
  });
  return { positions, triangles, materials };
}

/** Volume signé (positif pour une enveloppe orientée vers l'extérieur). */
export function signedVolume({ positions: p, triangles: t }: Solid): number {
  let volume = 0;
  const ox = p[0] ?? 0, oy = p[1] ?? 0, oz = p[2] ?? 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    const ax = p[a] - ox, ay = p[a + 1] - oy, az = p[a + 2] - oz;
    const bx = p[b] - ox, by = p[b + 1] - oy, bz = p[b + 2] - oz;
    const cx = p[c] - ox, cy = p[c + 1] - oy, cz = p[c + 2] - oz;
    volume += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return volume / 6;
}

/**
 * Pourquoi ce maillage ne peut pas être découpé, ou null : il doit être une enveloppe fermée, chaque arête bordant exactement
 * deux triangles, parcourue une fois dans chaque sens.
 */
export function solidProblem({ positions, triangles }: Solid): string | null {
  if (triangles.length === 0) return 'aucune géométrie';
  const n = positions.length / 3;
  const directed = new Map<number, number>();
  for (let i = 0; i < triangles.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const key = triangles[i + j] * n + triangles[i + (j + 1) % 3];
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  for (const [key, count] of directed) {
    if (count > 1) return 'maillage non manifold (une arête borde plus de deux faces, ou des faces sont mal orientées)';
    const a = Math.floor(key / n), b = key - a * n;
    if (!directed.has(b * n + a)) return 'maillage ouvert (il manque des faces)';
  }
  return null;
}

const sideOf = (d: number) => (d > 0 ? 1 : d < 0 ? -1 : 0);

/**
 * Coupe un solide fermé par un plan. Rend les deux pièces bouchées, `'miss'` si le plan ne le traverse pas (il le manque ou
 * ne fait que toucher une face), ou la raison d'un refus. `tolerance` : distance au plan en deçà de laquelle un sommet y est.
 * `segment` : la ligne en plan qui porte le plan ; la section doit tenir entre ses extrémités, sinon la coupe est partielle
 * (refusée) — ou entièrement hors de la ligne : la pièce n'est pas coupée (`'miss'`).
 */
export function splitByPlane(solid: Solid, plane: CutPlane, tolerance: number): { below: Solid; above: Solid } | 'miss' | string {
  const [nx, ny, nz] = plane.normal;
  const p = solid.positions;
  const t = solid.triangles;
  const d: number[] = [];
  let negative = false, positive = false;
  for (let v = 0; v < p.length; v += 3) {
    const value = nx * p[v] + ny * p[v + 1] + nz * p[v + 2] + plane.constant;
    const snapped = Math.abs(value) <= tolerance ? 0 : value;
    d.push(snapped);
    if (snapped < 0) negative = true;
    if (snapped > 0) positive = true;
  }
  if (!negative || !positive) return 'miss';

  const positions = [...p];
  const cuts = new Map<number, number>();
  const n = p.length / 3;
  /** Le point de coupe de l'arête (a, b), créé une fois : les deux triangles qui la bordent partagent le même sommet. */
  const cut = (a: number, b: number): number => {
    const [i, j] = a < b ? [a, b] : [b, a];
    const key = i * n + j;
    let id = cuts.get(key);
    if (id === undefined) {
      const s = d[i] / (d[i] - d[j]);
      id = positions.length / 3;
      positions.push(p[i * 3] + s * (p[j * 3] - p[i * 3]), p[i * 3 + 1] + s * (p[j * 3 + 1] - p[i * 3 + 1]), p[i * 3 + 2] + s * (p[j * 3 + 2] - p[i * 3 + 2]));
      d.push(0);
      cuts.set(key, id);
    }
    return id;
  };
  const below: number[] = [], belowMaterials: number[] = [], above: number[] = [], aboveMaterials: number[] = [];
  const fan = (polygon: number[], material: number, out: number[], materials: number[]) => {
    for (let k = 1; k + 1 < polygon.length; k++) {
      out.push(polygon[0], polygon[k], polygon[k + 1]);
      materials.push(material);
    }
  };
  for (let i = 0; i < t.length; i += 3) {
    const corners = [t[i], t[i + 1], t[i + 2]];
    const s = corners.map((v) => sideOf(d[v]));
    const material = solid.materials[i / 3];
    if (s[0] === 0 && s[1] === 0 && s[2] === 0) {
      // Une face posée sur le plan appartient au côté où est la matière : derrière sa normale.
      const [a, b, c] = corners.map((v) => new Vector3(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]));
      const facing = b.sub(a).cross(c.sub(a)).dot(new Vector3(nx, ny, nz));
      if (facing > 0) fan(corners, material, below, belowMaterials);
      else fan(corners, material, above, aboveMaterials);
    } else if (!s.includes(-1)) fan(corners, material, above, aboveMaterials);
    else if (!s.includes(1)) fan(corners, material, below, belowMaterials);
    else {
      const down: number[] = [], up: number[] = [];
      for (let j = 0; j < 3; j++) {
        const a = corners[j], b = corners[(j + 1) % 3];
        if (s[j] <= 0) down.push(a);
        if (s[j] >= 0) up.push(a);
        if (s[j] * s[(j + 1) % 3] < 0) {
          const x = cut(a, b);
          down.push(x);
          up.push(x);
        }
      }
      fan(down, material, below, belowMaterials);
      fan(up, material, above, aboveMaterials);
    }
  }

  // Les contours de la section : les arêtes du dessous qu'aucun triangle du dessous ne borde dans l'autre sens.
  const m = positions.length / 3;
  const edges = new Set<number>();
  for (let i = 0; i < below.length; i += 3) for (let j = 0; j < 3; j++) edges.add(below[i + j] * m + below[i + (j + 1) % 3]);
  const next = new Map<number, number>();
  const edgeMaterial = new Map<number, number>();
  for (let i = 0; i < below.length; i += 3) {
    for (let j = 0; j < 3; j++) {
      const a = below[i + j], b = below[i + (j + 1) % 3];
      if (edges.has(b * m + a)) continue;
      if (next.has(a) || d[a] !== 0 || d[b] !== 0) return 'section non manifold : le plan passe par une arête ou un sommet que plusieurs parties du solide se partagent';
      next.set(a, b);
      edgeMaterial.set(a, belowMaterials[i / 3]);
    }
  }
  if (next.size === 0) return 'miss';
  const loops: number[][] = [];
  const done = new Set<number>();
  for (const start of next.keys()) {
    if (done.has(start)) continue;
    const loop: number[] = [];
    for (let v: number | undefined = start; v !== undefined && !done.has(v); v = next.get(v)) {
      done.add(v);
      loop.push(v);
    }
    if (next.get(loop[loop.length - 1]) !== start) return 'section ouverte : le contour de coupe ne se referme pas';
    loops.push(loop);
  }

  // La ligne dessinée doit traverser la section de bout en bout.
  if (plane.segment) {
    const { from, to } = plane.segment;
    const dx = to[0] - from[0], dz = to[1] - from[1];
    const length = Math.hypot(dx, dz);
    const margin = 1e-3;
    let within = 0, outside = 0;
    for (const loop of loops) {
      for (const v of loop) {
        const along = ((positions[v * 3] - from[0]) * dx + (positions[v * 3 + 2] - from[1]) * dz) / length;
        if (along >= -margin && along <= length + margin) within++;
        else outside++;
      }
    }
    if (within === 0) return 'miss';
    if (outside > 0) return 'coupe partielle : la ligne doit traverser l’élément de part en part (allongez-la), sans que son prolongement le recoupe ailleurs';
  }

  // Le bouchon : les contours triangulés dans le plan, avec tous leurs sommets (une arête ne doit pas en sauter un).
  const { u, v } = planeBasis(new Plane(new Vector3(nx, ny, nz), plane.constant));
  const ring = loops.flat();
  const flat = ring.map((id) => [positions[id * 3] * u.x + positions[id * 3 + 1] * u.y + positions[id * 3 + 2] * u.z, positions[id * 3] * v.x + positions[id * 3 + 1] * v.y + positions[id * 3 + 2] * v.z]);
  const cutLoops: CutLoop[] = loops.map((loop, i) => {
    const before = loops.slice(0, i).reduce((sum, other) => sum + other.length, 0);
    return { points: Float32Array.from(loop.flatMap((_, k) => flat[before + k])), closed: true };
  });
  const faces = fillFaces(cutLoops);
  insertSkipped(faces, flat);
  const cap = faces.map((k) => ring[k]);
  for (let i = 0; i < cap.length; i += 3) {
    const [a, b, c] = [cap[i], cap[i + 1], cap[i + 2]];
    // Le bouchon du dessous regarde vers le dessus (sa normale est celle du plan), celui du dessus l'inverse.
    const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
    const facing = (uy * vz - uz * vy) * nx + (uz * vx - ux * vz) * ny + (ux * vy - uy * vx) * nz;
    const material = edgeMaterial.get(a) ?? edgeMaterial.get(b) ?? edgeMaterial.get(c) ?? belowMaterials[0];
    if (facing >= 0) below.push(a, b, c), above.push(a, c, b);
    else below.push(a, c, b), above.push(a, b, c);
    belowMaterials.push(material);
    aboveMaterials.push(material);
  }
  return { below: compact(positions, below, belowMaterials), above: compact(positions, above, aboveMaterials) };
}

/**
 * La triangulation saute les points alignés de ses contours : chaque point sauté est remis dans le triangle dont une arête le
 * porte (ce triangle est coupé en deux), pour que le bouchon s'accroche à tous les sommets des faces coupées.
 */
function insertSkipped(faces: number[], points: number[][]): void {
  const used = new Set(faces);
  for (let k = 0; k < points.length; k++) {
    if (used.has(k)) continue;
    const [px, py] = points[k];
    search: for (let f = 0; f < faces.length; f += 3) {
      for (let j = 0; j < 3; j++) {
        const a = faces[f + j], b = faces[f + (j + 1) % 3], c = faces[f + (j + 2) % 3];
        const [ax, ay] = points[a], [bx, by] = points[b];
        const lx = bx - ax, ly = by - ay, length = lx * lx + ly * ly;
        const along = (px - ax) * lx + (py - ay) * ly;
        if (along <= 0 || along >= length || Math.abs((px - ax) * ly - (py - ay) * lx) > 1e-6 * Math.sqrt(length) * (1 + Math.sqrt(length))) continue;
        faces.splice(f, 3, a, k, c, k, b, c);
        break search;
      }
    }
  }
}

/** Les seuls sommets utilisés, renumérotés. */
function compact(positions: number[], triangles: number[], materials: number[]): Solid {
  const map = new Map<number, number>();
  const out: number[] = [];
  const renumbered = triangles.map((v) => {
    let id = map.get(v);
    if (id === undefined) {
      id = map.size;
      map.set(v, id);
      out.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    }
    return id;
  });
  return { positions: out, triangles: renumbered, materials };
}

/** L'erreur de `splitSolid` quand les pièces dépassent `maxParts`. */
export const TOO_MANY_PARTS = 'trop de pièces';

/** `splitSolidSteps` jusqu'au bout, d'un seul tenant. */
export function splitSolid(solid: Solid, planes: readonly CutPlane[], maxParts = Infinity): { parts: SplitPart[]; error?: string } {
  const steps = splitSolidSteps(solid, planes, maxParts);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/**
 * Découpe un solide par des plans (dans l'ordre donné ; le résultat n'en dépend pas) et numérote les pièces de bas en haut,
 * puis du sud au nord, puis d'ouest en est (Y, −Z, X du centre de leur boîte, au millimètre). Le solide doit être fermé :
 * sinon `error` dit pourquoi. Un plan qui ne coupe rien ne compte pas ; sans aucune coupe, `parts` est vide. Au-delà de
 * `maxParts` pièces, la découpe s'arrête (`TOO_MANY_PARTS`). Une pause après chaque pièce coupée : les triangles traités.
 */
export function* splitSolidSteps(solid: Solid, planes: readonly CutPlane[], maxParts = Infinity): Generator<number, { parts: SplitPart[]; error?: string }, unknown> {
  const problem = solidProblem(solid);
  if (problem) return { parts: [], error: problem };
  // Une enveloppe tournée vers l'intérieur est retournée d'abord : les bouchons supposent des normales vers l'extérieur.
  if (signedVolume(solid) < 0) {
    const t = solid.triangles;
    solid = { ...solid, triangles: t.map((_, i) => t[i - (i % 3) + [0, 2, 1][i % 3]]) };
  }
  let extent = 0;
  for (let axis = 0; axis < 3; axis++) {
    let min = Infinity, max = -Infinity;
    for (let v = axis; v < solid.positions.length; v += 3) {
      min = Math.min(min, solid.positions[v]);
      max = Math.max(max, solid.positions[v]);
    }
    extent = Math.max(extent, max - min);
  }
  const tolerance = Math.max(1e-6, extent * 1e-7);
  let pieces: { solid: Solid; sides: number[] }[] = [{ solid, sides: [] }];
  let cutAny = false;
  for (const plane of planes) {
    const next: typeof pieces = [];
    for (const piece of pieces) {
      const result = splitByPlane(piece.solid, plane, tolerance);
      yield piece.solid.triangles.length / 3;
      if (typeof result === 'string') {
        if (result !== 'miss') return { parts: [], error: result };
        const [nx, ny, nz] = plane.normal, q = piece.solid.positions;
        let side = 0;
        for (let v = 0; v < q.length && side === 0; v += 3) side = sideOf(nx * q[v] + ny * q[v + 1] + nz * q[v + 2] + plane.constant);
        next.push({ solid: piece.solid, sides: [...piece.sides, side] });
      } else {
        cutAny = true;
        next.push({ solid: result.below, sides: [...piece.sides, -1] }, { solid: result.above, sides: [...piece.sides, 1] });
      }
    }
    pieces = next;
    if (pieces.length > maxParts) return { parts: [], error: TOO_MANY_PARTS };
  }
  if (!cutAny) return { parts: [] };
  const centre = (s: Solid) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < s.positions.length; v++) {
      min[v % 3] = Math.min(min[v % 3], s.positions[v]);
      max[v % 3] = Math.max(max[v % 3], s.positions[v]);
    }
    return [0, 1, 2].map((axis) => Math.round(((min[axis] + max[axis]) / 2) * 1000));
  };
  const keyed = pieces.map((piece) => ({ piece, c: centre(piece.solid) }));
  keyed.sort((a, b) => a.c[1] - b.c[1] || b.c[2] - a.c[2] || a.c[0] - b.c[0]);
  return {
    parts: keyed.map(({ piece }) => ({ solid: piece.solid, sides: piece.sides, valid: solidProblem(piece.solid) === null, volume: Math.abs(signedVolume(piece.solid)) })),
  };
}

/** Le plan vertical qui porte une ligne dessinée en plan (x, z du repère du viewer). */
export function verticalPlane(from: [number, number], to: [number, number]): CutPlane {
  const dx = to[0] - from[0], dz = to[1] - from[1];
  const length = Math.hypot(dx, dz);
  const normal: [number, number, number] = [-dz / length, 0, dx / length];
  return { normal, constant: -(normal[0] * from[0] + normal[2] * from[1]), segment: { from, to } };
}

/** Réunit des pièces voisines (fusion) : leurs triangles mis ensemble, les bouchons communs restent à l'intérieur. */
export function mergeSolids(solids: readonly Solid[]): Solid {
  const out: Solid = { positions: [], triangles: [], materials: [] };
  for (const solid of solids) {
    const base = out.positions.length / 3;
    out.positions.push(...solid.positions);
    for (const v of solid.triangles) out.triangles.push(v + base);
    out.materials.push(...solid.materials);
  }
  return out;
}
