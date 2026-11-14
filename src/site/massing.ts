// Volumes paramétriques → maillages (pur) : un contour en plan, un niveau bas, des niveaux et une hauteur d'étage. Le
// maillage est un prisme fermé par suite de niveaux de même usage (un commerce en rez-de-chaussée sous des logements
// donne deux prismes empilés), en triangles à plat (sans index) avec leurs normales, faces tournées vers l'extérieur.
// Repère de la scène et du GLB : x = est, y = haut, z = −nord (comme le glTF).

import { ShapeUtils, Vector2 } from 'three';
import { signedArea } from '../data/zones.ts';
import { useOf, type Volume, type XY } from './study.ts';

export const toScene = (east: number, north: number, up: number): [number, number, number] => [east, up, -north];

/** Rectangle d'axes est-nord de diagonale a–b, dans le sens trigonométrique. */
export function rectangle([ax, ay]: XY, [bx, by]: XY): XY[] {
  const [x0, x1, y0, y1] = [Math.min(ax, bx), Math.max(ax, bx), Math.min(ay, by), Math.max(ay, by)];
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

/** Barre de largeur `width` centrée sur le segment a–b, dans le sens trigonométrique. */
export function bar([ax, ay]: XY, [bx, by]: XY, width: number): XY[] {
  const length = Math.hypot(bx - ax, by - ay) || 1;
  const [nx, ny] = [(-(by - ay) / length) * (width / 2), ((bx - ax) / length) * (width / 2)];
  return [[ax - nx, ay - ny], [bx - nx, by - ny], [bx + nx, by + ny], [ax + nx, ay + ny]];
}

export const translate = (footprint: readonly XY[], de: number, dn: number): XY[] => footprint.map(([x, y]) => [x + de, y + dn]);

/** Centre de gravité de la surface (moyenne des sommets si elle est nulle). */
export function centroid(footprint: readonly XY[]): XY {
  let area = 0, cx = 0, cy = 0;
  for (let i = 0, j = footprint.length - 1; i < footprint.length; j = i++) {
    const [x0, y0] = footprint[j], [x1, y1] = footprint[i];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area) < 1e-12) return [footprint.reduce((s, p) => s + p[0], 0) / footprint.length, footprint.reduce((s, p) => s + p[1], 0) / footprint.length];
  return [cx / (3 * area), cy / (3 * area)];
}

export interface Segment {
  use: string;
  bottom: number;
  top: number;
}

/** Les suites de niveaux de même usage, de bas en haut. */
export function segmentsOf(volume: Volume): Segment[] {
  const out: Segment[] = [];
  for (let floor = 0; floor < volume.floors; floor++) {
    const use = useOf(volume, floor);
    const bottom = volume.baseLevel + floor * volume.floorHeight, top = bottom + volume.floorHeight;
    const last = out[out.length - 1];
    if (last && last.use === use) last.top = top;
    else out.push({ use, bottom, top });
  }
  return out;
}

/** Ajoute un prisme fermé (contour en plan, du bas au haut) aux tableaux de positions et de normales (repère de la scène). */
export function addPrism(footprint: readonly XY[], bottom: number, top: number, positions: number[], normals: number[]): void {
  const ring = signedArea(footprint as XY[]) < 0 ? [...footprint].reverse() : footprint;
  const triangle = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-12) return;
    nx /= length; ny /= length; nz /= length;
    positions.push(...a, ...b, ...c);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  };
  // Dessus et dessous : triangulation du contour (concave admis), chaque triangle remis dans le sens voulu.
  for (const [i, j, k] of ShapeUtils.triangulateShape(ring.map(([x, y]) => new Vector2(x, y)), [])) {
    let [a, b, c] = [ring[i], ring[j], ring[k]];
    if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) < 0) [b, c] = [c, b];
    triangle(toScene(a[0], a[1], top), toScene(b[0], b[1], top), toScene(c[0], c[1], top));
    triangle(toScene(a[0], a[1], bottom), toScene(c[0], c[1], bottom), toScene(b[0], b[1], bottom));
  }
  // Murs : pour un contour trigonométrique, l'extérieur est à droite de chaque côté.
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const pb = toScene(p[0], p[1], bottom), qb = toScene(q[0], q[1], bottom), qt = toScene(q[0], q[1], top), pt = toScene(p[0], p[1], top);
    triangle(pb, qb, qt);
    triangle(pb, qt, pt);
  }
}

export interface VolumeMesh {
  positions: Float32Array;
  normals: Float32Array;
  /** Les prismes, chacun avec sa plage de sommets. */
  segments: (Segment & { start: number; count: number })[];
}

export function volumeMesh(volume: Volume): VolumeMesh {
  const positions: number[] = [], normals: number[] = [];
  const segments = segmentsOf(volume).map((segment) => {
    const start = positions.length / 3;
    addPrism(volume.footprint, segment.bottom, segment.top, positions, normals);
    return { ...segment, start, count: positions.length / 3 - start };
  });
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), segments };
}
