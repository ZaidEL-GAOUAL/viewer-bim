// Cotes d'un élément calculées depuis son maillage : longueur et largeur du plus petit rectangle
// qui contient son empreinte au sol (quelle que soit son orientation), hauteur, surface et volume.

import { analyzeSolid, type MeshPart } from './meshMath.ts';

export interface Dimensions {
  /** Plus grande dimension du rectangle minimal au sol. */
  length: number;
  width: number;
  height: number;
  /** Orientation de la longueur dans le plan horizontal, en degrés. */
  angle: number;
  area: number;
  volume: number;
  /** Faux si le maillage n'est pas une enveloppe fermée : surface et volume sont alors approximatifs. */
  closed: boolean;
  triangles: number;
}

/** Enveloppe convexe de points 2D (chaîne monotone d'Andrew), sens antihoraire, sans doublons. */
export function convexHull(points: [number, number][]): [number, number][] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]).filter((p, i, list) => i === 0 || p[0] !== list[i - 1][0] || p[1] !== list[i - 1][1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/** Rectangle d'aire minimale contenant des points : une de ses arêtes est portée par une arête de l'enveloppe. */
export function minimalRectangle(points: [number, number][]): { length: number; width: number; angle: number } {
  const hull = convexHull(points);
  if (hull.length === 0) return { length: 0, width: 0, angle: 0 };
  if (hull.length === 1) return { length: 0, width: 0, angle: 0 };
  if (hull.length === 2) {
    const dx = hull[1][0] - hull[0][0], dy = hull[1][1] - hull[0][1];
    return { length: Math.hypot(dx, dy), width: 0, angle: (Math.atan2(dy, dx) * 180) / Math.PI };
  }
  let best = { area: Infinity, length: 0, width: 0, angle: 0 };
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], b = hull[(i + 1) % hull.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len === 0) continue;
    const ux = ex / len, uy = ey / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const du = maxU - minU, dv = maxV - minV;
    const area = du * dv;
    if (area < best.area - 1e-12) {
      const along = du >= dv;
      best = { area, length: Math.max(du, dv), width: Math.min(du, dv), angle: (Math.atan2(along ? uy : ux, along ? ux : -uy) * 180) / Math.PI };
    }
  }
  return { length: best.length, width: best.width, angle: best.angle };
}

/**
 * Mesure d'un élément, gardée sous une forme combinable : l'enveloppe convexe de son empreinte
 * au sol (quelques points), son étendue verticale, sa surface et son volume.
 */
export interface ElementMeasure {
  hull: [number, number][];
  minY: number;
  maxY: number;
  area: number;
  volume: number;
  closed: boolean;
  triangles: number;
}

export function measureElement(parts: MeshPart[]): ElementMeasure | null {
  const footprint: [number, number][] = [];
  let minY = Infinity, maxY = -Infinity;
  for (const part of parts) {
    const vertices = new Set<number>();
    for (let k = part.start, end = part.start + part.count; k < end; k++) vertices.add(part.index[k]);
    for (const v of vertices) {
      const y = part.positions[v * 3 + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      footprint.push([part.positions[v * 3], part.positions[v * 3 + 2]]);
    }
  }
  if (footprint.length === 0) return null;
  const solid = analyzeSolid(parts);
  return { hull: convexHull(footprint), minY, maxY, area: solid.area, volume: solid.volume, closed: solid.closed, triangles: solid.triangles };
}

/**
 * Cotes d'un ou plusieurs éléments réunis : rectangle minimal de l'empreinte commune, hauteur de
 * l'ensemble, sommes des surfaces et des volumes. Fermé seulement si tous les éléments le sont.
 */
export function combineMeasures(measures: readonly ElementMeasure[]): Dimensions | null {
  if (measures.length === 0) return null;
  const points: [number, number][] = [];
  let minY = Infinity, maxY = -Infinity, area = 0, volume = 0, triangles = 0, closed = true;
  for (const measure of measures) {
    for (const point of measure.hull) points.push(point);
    if (measure.minY < minY) minY = measure.minY;
    if (measure.maxY > maxY) maxY = measure.maxY;
    area += measure.area;
    volume += measure.volume;
    triangles += measure.triangles;
    closed &&= measure.closed;
  }
  return { ...minimalRectangle(points), height: maxY - minY, area, volume, closed, triangles };
}

/** Cotes d'un ensemble de triangles (un élément, ou plusieurs pièces d'un élément). */
export function elementDimensions(parts: MeshPart[]): Dimensions | null {
  const measure = measureElement(parts);
  return measure ? combineMeasures([measure]) : null;
}
