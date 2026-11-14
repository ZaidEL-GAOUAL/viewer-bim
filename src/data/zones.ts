// Zones dessinées en plan (section `zones` du contrat, voir docs/contrat-metadonnees.md) : chaque élément est rangé dans la
// zone qui couvre la plus grande part de son emprise, écrite dans une propriété (« Zone » par défaut). Aucune géométrie n'est
// créée. Les points sont dans le repère du modèle (mètres, Y vers le haut) : le polygone est celui de leurs (x, z).

import { isRecord } from './json.ts';

export interface Zone {
  name: string;
  points: [number, number, number][];
}

/** Lit la section `zones` : une entrée sans nom ou avec moins de trois points finis est écartée. */
export function parseZones(raw: unknown): Zone[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): Zone[] => {
    if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim() || !Array.isArray(item.points)) return [];
    const points = item.points.filter((point): point is [number, number, number] => Array.isArray(point) && point.length === 3 && point.every((value) => typeof value === 'number' && Number.isFinite(value)));
    return points.length >= 3 && points.length === item.points.length ? [{ name: item.name, points: points.map((point) => [...point] as [number, number, number]) }] : [];
  });
}

export const zonesToJson = (zones: readonly Zone[]): Zone[] => zones.map(({ name, points }) => ({ name, points: points.map((point) => [...point] as [number, number, number]) }));

type Point = [number, number];

const signedArea = (polygon: readonly Point[]): number => {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) sum += polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1];
  return sum / 2;
};

/** La partie de `subject` (quelconque, concave compris) dans `clip` (convexe) : Sutherland–Hodgman ; seule son aire sert. */
function clipToConvex(subject: readonly Point[], clip: readonly Point[]): Point[] {
  const ccw = signedArea(clip) > 0 ? clip : [...clip].reverse();
  let output: Point[] = [...subject];
  for (let i = 0; i < ccw.length && output.length > 0; i++) {
    const [ax, ay] = ccw[i], [bx, by] = ccw[(i + 1) % ccw.length];
    const side = ([x, y]: Point) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const input = output;
    output = [];
    for (let k = 0; k < input.length; k++) {
      const p = input[k], q = input[(k + 1) % input.length];
      const sp = side(p), sq = side(q);
      if (sp >= 0) output.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        output.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
      }
    }
  }
  return output;
}

function contains(polygon: readonly Point[], [x, y]: Point): boolean {
  let within = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) within = !within;
  }
  return within;
}

/**
 * Pour chaque emprise (polygone convexe en plan, ou null sans géométrie), le rang de la zone qui en couvre la plus grande
 * part, ou −1 hors de toute zone. À parts égales, la première zone de la liste l'emporte. Une emprise sans surface (un
 * élément vu de dessus comme un trait) va à la zone qui contient son centre.
 */
export function assignZones(footprints: readonly (readonly Point[] | null)[], zones: readonly (readonly Point[])[]): number[] {
  return footprints.map((footprint) => {
    if (!footprint || footprint.length === 0) return -1;
    const area = Math.abs(signedArea(footprint));
    if (area < 1e-9) {
      const centre: Point = [footprint.reduce((sum, p) => sum + p[0], 0) / footprint.length, footprint.reduce((sum, p) => sum + p[1], 0) / footprint.length];
      return zones.findIndex((zone) => contains(zone, centre));
    }
    let best = -1, bestShare = 1e-9;
    zones.forEach((zone, index) => {
      const share = Math.abs(signedArea(clipToConvex(zone, footprint))) / area;
      if (share > bestShare + 1e-9) {
        best = index;
        bestShare = share;
      }
    });
    return best;
  });
}

/** Les zones de la base et des JSON de modifications : une zone de même nom n'est gardée qu'une fois, la plus récente. */
export function zonesOf(metadata: { zones?: Zone[] } | null, overlays: readonly { zones?: Zone[] }[]): Zone[] {
  const byName = new Map<string, Zone>();
  for (const source of [metadata, ...overlays]) for (const zone of source?.zones ?? []) byName.set(zone.name, zone);
  return [...byName.values()];
}
