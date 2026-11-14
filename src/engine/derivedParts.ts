// Les pièces dérivées d'éléments du modèle (découpage, voir data/splits.ts) : le solide d'un élément lu dans ses lots, sa
// découpe par tranches de travail, et les pièces remises au modèle comme un morceau de modèle brut (`ModelBuilder.append`,
// le chemin des morceaux d'un fichier Revit). Les éléments d'origine ne sont jamais modifiés.

import { DEPTH_HOST, DEPTH_OVERLAY, DEPTH_POLYGON_OFFSET, MATERIAL_STRIDE, type RawModel } from './buildModel.ts';
import type { Model } from './Model.ts';
import { solidFromParts, splitSolid, type CutPlane, type Solid, type SplitPart } from './splitMesh.ts';

/** Les pièces d'un élément découpé, dans l'ordre de leurs numéros (1 à n). */
export interface ElementSplit {
  element: number;
  parts: SplitPart[];
  /** Matériaux des triangles des pièces (`MATERIAL_STRIDE` octets par ligne, comme un modèle brut), lus dans les lots de l'élément. */
  materials: Uint8Array;
}

export interface SplitRefusal {
  element: number;
  reason: string;
}

/** Le solide d'un élément, avec pour chaque triangle sa couleur, sa transparence, sa double face et sa priorité de profondeur. */
export function elementSolid(model: Model, element: number): { solid: Solid; materials: Uint8Array } {
  const rows: number[] = [];
  const known = new Map<string, number>();
  const ranges = model.ranges[element];
  const solid = solidFromParts(model.parts(element), (part, k) => {
    const chunk = model.chunks[ranges[part].chunk];
    const colors = chunk.mesh.geometry.getAttribute('color').array as Uint8Array;
    const material = Array.isArray(chunk.mesh.material) ? chunk.mesh.material[0] : chunk.mesh.material;
    const depth = !material.polygonOffset ? 0 : material.polygonOffsetFactor === DEPTH_POLYGON_OFFSET[DEPTH_OVERLAY].factor ? DEPTH_OVERLAY : DEPTH_HOST;
    const v = chunk.index[k] * 4;
    const row = [colors[v], colors[v + 1], colors[v + 2], colors[v + 3], chunk.transparent ? 1 : 0, chunk.doubleSided ? 1 : 0, depth];
    const key = row.join(',');
    let id = known.get(key);
    if (id === undefined) {
      id = known.size;
      known.set(key, id);
      rows.push(...row);
    }
    return id;
  });
  return { solid, materials: Uint8Array.from(rows) };
}

/**
 * Découpe des éléments, élément par élément, avec une pause (avancement de 0 à 1) chaque fois que `budget` triangles ont été
 * traités. `planesOf` : les plans de coupe d'un élément, dans le repère du viewer, ou la raison de leur refus (trop de
 * coupes). Un élément ouvert, une coupe partielle ou aucune coupe donnent aussi un refus motivé, sans pièce.
 */
export function* splitJob(
  model: Model, elements: readonly number[], planesOf: (element: number) => CutPlane[] | string,
  out: { splits: ElementSplit[]; refused: SplitRefusal[] }, budget = 40_000,
): Generator<number, void, unknown> {
  let work = 0;
  for (let i = 0; i < elements.length; i++) {
    const element = elements[i];
    const planes = planesOf(element);
    if (typeof planes === 'string') {
      out.refused.push({ element, reason: planes });
      continue;
    }
    const { solid, materials } = elementSolid(model, element);
    const result = planes.length === 0 ? { parts: [] } : splitSolid(solid, planes);
    if (result.error) out.refused.push({ element, reason: result.error });
    else if (result.parts.length === 0) out.refused.push({ element, reason: 'aucune coupe ne traverse l’élément' });
    else out.splits.push({ element, parts: result.parts, materials });
    work += (solid.triangles.length / 3) * (planes.length + 1);
    if (work >= budget) {
      work = 0;
      yield (i + 1) / elements.length;
    }
  }
}

/** Une pièce à ajouter au modèle : sa clé, son nom, sa géométrie et la table des matériaux de ses triangles. */
export interface PartGeometry {
  key: string;
  name: string;
  solid: Solid;
  materials: Uint8Array;
}

/**
 * Les pièces en modèle brut, un élément par pièce, prêtes pour `ModelBuilder.append`. Les positions des solides sont celles
 * du viewer ; `origin` est donc `Model.offset`. Chaque triangle a ses sommets et sa normale (ombrage à facettes).
 */
export function partsToRaw(parts: readonly PartGeometry[], origin: [number, number, number]): RawModel {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [], primitives: number[] = [], materials: number[] = [];
  parts.forEach(({ solid, materials: table }, element) => {
    const first = materials.length / MATERIAL_STRIDE;
    for (const byte of table) materials.push(byte);
    const p = solid.positions;
    for (let m = 0; m < table.length / MATERIAL_STRIDE; m++) {
      const vertexStart = positions.length / 3, indexStart = indices.length;
      for (let t = 0; t < solid.materials.length; t++) {
        if (solid.materials[t] !== m) continue;
        const [a, b, c] = [solid.triangles[t * 3] * 3, solid.triangles[t * 3 + 1] * 3, solid.triangles[t * 3 + 2] * 3];
        const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
        const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz) || 1;
        for (const v of [a, b, c]) {
          indices.push(positions.length / 3 - vertexStart);
          positions.push(p[v], p[v + 1], p[v + 2]);
          normals.push(nx / length, ny / length, nz / length);
        }
      }
      const vertexCount = positions.length / 3 - vertexStart;
      if (vertexCount > 0) primitives.push(element, vertexStart, vertexCount, indexStart, indices.length - indexStart, first + m);
    }
  });
  return {
    kind: 'raw',
    keys: parts.map((part) => part.key),
    names: parts.map((part) => part.name),
    origin,
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    primitives: Uint32Array.from(primitives),
    materials: Uint8Array.from(materials),
  };
}
