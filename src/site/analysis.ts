// Analyses de l'étude de site, en travaux découpés en tranches (voir engine/sliced.ts) : avancement, arrêt.
//
// - Heures de soleil : pour chaque point (au sol ou en façade), la somme des pas de la course du Soleil (sun.ts) où le
//   rayon vers le Soleil ne rencontre ni volume ni voisin ; en façade, seuls comptent les pas où le Soleil est devant.
// - Composante de ciel (VSC) : part de l'éclairement d'un plan horizontal dégagé que reçoit une façade verticale sous le
//   ciel couvert normalisé de la CIE (luminance (1 + 2 sin θ) / 3 à la hauteur θ). Le ciel devant la façade est découpé
//   en carreaux dont le poids est l'intégrale exacte sur le carreau ; un rayon par carreau, en son centre, dit s'il est
//   vu. Sans obstacle, la somme vaut exactement 39,6 %.
//
// Rayons : arbre de boîtes de three-mesh-bvh (MIT) sur les triangles des volumes et des voisins ; le relief n'est pas
// un obstacle (simplification). Repère de la scène : x = est, y = haut, z = −nord.

import { BufferAttribute, BufferGeometry, DoubleSide, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { contains } from '../data/zones.ts';
import { toScene } from './massing.ts';
import type { SunSample } from './sun.ts';
import type { Volume, XY } from './study.ts';

type Vec3 = [number, number, number];

export interface SamplePoint {
  position: Vec3;
  /** Normale horizontale d'un point de façade ; null au sol. */
  normal: Vec3 | null;
}

export type Occluder = MeshBVH;

/** Décalage des points hors de leur surface (m) : un rayon ne part pas de l'intérieur d'un mur. */
const LIFT = 0.05;
/** Rayons lancés entre deux pauses. */
const BUDGET = 20_000;

/** L'arbre de boîtes des triangles donnés (positions à plat, repère de la scène) ; null s'il n'y en a aucun. */
export function buildOccluder(parts: readonly Float32Array[]): Occluder | null {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  if (length < 9) return null;
  const positions = new Float32Array(length);
  let offset = 0;
  for (const part of parts) {
    positions.set(part, offset);
    offset += part.length;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  return new MeshBVH(geometry);
}

const box = (polygon: readonly XY[]) => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of polygon) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  return { minX, minY, maxX, maxY };
};

/** Grille de points au sol (centres de cases de `step` m) dans la limite, hors des emprises des bâtiments. */
export function groundPoints(limit: readonly XY[], step: number, obstacles: readonly (readonly XY[])[], groundAt: (east: number, north: number) => number): SamplePoint[] {
  const bounds = box(limit);
  const blockers = obstacles.map((polygon) => ({ polygon, ...box(polygon) }));
  const points: SamplePoint[] = [];
  for (let y = bounds.minY + step / 2; y < bounds.maxY; y += step) {
    for (let x = bounds.minX + step / 2; x < bounds.maxX; x += step) {
      if (!contains(limit, [x, y])) continue;
      if (blockers.some((b) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && contains(b.polygon, [x, y]))) continue;
      points.push({ position: toScene(x, y, groundAt(x, y) + LIFT), normal: null });
    }
  }
  return points;
}

/** Points de façade : un tous les `spacing` m le long de chaque côté, à mi-hauteur de chaque niveau, tournés vers l'extérieur. */
export function facadePoints(volumes: readonly Volume[], spacing: number): SamplePoint[] {
  const points: SamplePoint[] = [];
  for (const volume of volumes) {
    const footprint = volume.footprint;
    let area = 0;
    for (let i = 0, j = footprint.length - 1; i < footprint.length; j = i++) area += footprint[j][0] * footprint[i][1] - footprint[i][0] * footprint[j][1];
    const sign = area >= 0 ? 1 : -1;
    for (let i = 0; i < footprint.length; i++) {
      const [px, py] = footprint[i], [qx, qy] = footprint[(i + 1) % footprint.length];
      const length = Math.hypot(qx - px, qy - py);
      if (length < 1e-6) continue;
      // Pour un contour trigonométrique, l'extérieur est à droite du côté.
      const [ne, nn] = [(sign * (qy - py)) / length, (sign * -(qx - px)) / length];
      const count = Math.max(1, Math.round(length / spacing));
      for (let k = 0; k < count; k++) {
        const t = (k + 0.5) / count;
        const [e, n] = [px + t * (qx - px) + ne * LIFT, py + t * (qy - py) + nn * LIFT];
        for (let floor = 0; floor < volume.floors; floor++) {
          points.push({ position: toScene(e, n, volume.baseLevel + (floor + 0.5) * volume.floorHeight), normal: toScene(ne, nn, 0) });
        }
      }
    }
  }
  return points;
}

const ray = new Ray();
const blocked = (occluder: Occluder | null, origin: Vec3, direction: Vector3): boolean => {
  if (!occluder) return false;
  ray.origin.set(origin[0], origin[1], origin[2]);
  ray.direction.copy(direction);
  return occluder.raycastFirst(ray, DoubleSide) !== null;
};

/** Heures de soleil direct de chaque point sur la course donnée. Rend l'avancement (0 à 1) à chaque pause. */
export function* sunHoursJob(points: readonly SamplePoint[], occluder: Occluder | null, path: readonly SunSample[]): Generator<number, Float32Array, unknown> {
  const directions = path.map((sample) => new Vector3(...toScene(...sample.direction)));
  const out = new Float32Array(points.length);
  let work = 0;
  for (let i = 0; i < points.length; i++) {
    const { position, normal } = points[i];
    let hours = 0;
    for (let k = 0; k < directions.length; k++) {
      const d = directions[k];
      if (normal && normal[0] * d.x + normal[1] * d.y + normal[2] * d.z <= 0) continue;
      if (!blocked(occluder, position, d)) hours += path[k].hours;
    }
    out[i] = hours;
    work += directions.length;
    if (work >= BUDGET) {
      work = 0;
      yield (i + 1) / points.length;
    }
  }
  return out;
}

/** Bandes de hauteur et d'azimut des carreaux du ciel devant une façade (5° × 7,5°). */
const ALTITUDE_BANDS = 18;
const AZIMUTH_BANDS = 24;
/** Rayons lancés par point de façade pour la composante de ciel. */
export const SKY_RAYS = ALTITUDE_BANDS * AZIMUTH_BANDS;
/** Éclairement d'un plan horizontal dégagé sous le ciel couvert CIE (luminance zénithale 1) : 7π/9. */
const HORIZONTAL = (7 * Math.PI) / 9;

/** Carreaux du ciel devant une façade : direction (hauteur θ, azimut φ depuis la normale) et poids exact. */
const SKY_PATCHES = (() => {
  // ∫ (1 + 2 sin θ) cos² θ dθ : intégrale de la luminance × incidence sur un plan vertical × élément d'angle solide.
  const F = (t: number) => t / 2 + Math.sin(2 * t) / 4 - (2 / 3) * Math.cos(t) ** 3;
  const patches: { cosTheta: number; sinTheta: number; cosPhi: number; sinPhi: number; weight: number }[] = [];
  for (let a = 0; a < ALTITUDE_BANDS; a++) {
    const t0 = (a * Math.PI) / 2 / ALTITUDE_BANDS, t1 = ((a + 1) * Math.PI) / 2 / ALTITUDE_BANDS, t = (t0 + t1) / 2;
    for (let b = 0; b < AZIMUTH_BANDS; b++) {
      const p0 = -Math.PI / 2 + (b * Math.PI) / AZIMUTH_BANDS, p1 = p0 + Math.PI / AZIMUTH_BANDS, p = (p0 + p1) / 2;
      const weight = ((Math.sin(p1) - Math.sin(p0)) * (F(t1) - F(t0))) / 3 / HORIZONTAL;
      patches.push({ cosTheta: Math.cos(t), sinTheta: Math.sin(t), cosPhi: Math.cos(p), sinPhi: Math.sin(p), weight });
    }
  }
  return patches;
})();

/** Composante de ciel (%) de chaque point de façade (normale horizontale). Rend l'avancement à chaque pause. */
export function* skyComponentJob(points: readonly SamplePoint[], occluder: Occluder | null): Generator<number, Float32Array, unknown> {
  const out = new Float32Array(points.length);
  const d = new Vector3();
  let work = 0;
  for (let i = 0; i < points.length; i++) {
    const { position, normal } = points[i];
    if (!normal) continue;
    // Repère de la façade : n vers l'extérieur, t horizontal à sa gauche, y vers le haut.
    const [nx, , nz] = normal, [tx, tz] = [-nz, nx];
    let sum = 0;
    for (const patch of SKY_PATCHES) {
      const horizontal = patch.cosTheta;
      d.set(horizontal * (patch.cosPhi * nx + patch.sinPhi * tx), patch.sinTheta, horizontal * (patch.cosPhi * nz + patch.sinPhi * tz));
      if (!blocked(occluder, position, d)) sum += patch.weight;
    }
    out[i] = sum * 100;
    work += SKY_PATCHES.length;
    if (work >= BUDGET) {
      work = 0;
      yield (i + 1) / points.length;
    }
  }
  return out;
}
