// Les chiffres d'une proposition, calculés à chaque changement (purs, sans dépendance) : surface du terrain, emprise
// bâtie (surface couverte, un socle et sa tour ne comptent qu'une fois) et son taux, surface de plancher totale et par
// usage, COS, point le plus haut, pleine terre, logements estimés. Le tableau compare les propositions et se copie en TSV.

import { signedArea } from '../data/zones.ts';
import { useOf, type Proposal, type Study, type StudySettings, type Volume, type XY } from './study.ts';

export interface Figures {
  siteArea: number;
  /** Surface au sol couverte par les volumes (m²). */
  footprint: number;
  /** Emprise / terrain (0 à 1) ; NaN sans limite de terrain. */
  coverage: number;
  /** Surface de plancher : emprise de chaque volume × niveaux. */
  gfa: number;
  gfaByUse: Record<string, number>;
  /** Surface de plancher / terrain ; NaN sans limite. */
  plotRatio: number;
  /** Haut du volume le plus haut (m, repère local) ; NaN sans volume. */
  highestPoint: number;
  /** Terrain non couvert par les volumes (m²) ; NaN sans limite. */
  openGround: number;
  dwellings: number;
  volumes: number;
}

export const polygonArea = (polygon: readonly XY[]): number => Math.abs(signedArea(polygon as XY[]));

/** Ordonnées où la verticale x coupe les côtés du polygone, triées : des paires (entrée, sortie), règle pair-impair. */
function crossings(polygon: readonly XY[], x: number): number[] {
  const ys: number[] = [];
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [x1, y1] = polygon[j], [x2, y2] = polygon[i];
    if ((x1 <= x) !== (x2 <= x)) ys.push(y1 + ((x - x1) * (y2 - y1)) / (x2 - x1));
  }
  return ys.sort((a, b) => a - b);
}

/** Abscisses où deux côtés de polygones différents se croisent. */
function edgeCrossings(polygons: readonly (readonly XY[])[], out: number[]): void {
  const edges: [XY, XY, number][] = [];
  polygons.forEach((polygon, p) => polygon.forEach((point, i) => edges.push([point, polygon[(i + 1) % polygon.length], p])));
  for (let a = 0; a < edges.length; a++) {
    const [[ax, ay], [bx, by], pa] = edges[a];
    for (let b = a + 1; b < edges.length; b++) {
      const [[cx, cy], [dx, dy], pb] = edges[b];
      if (pa === pb) continue;
      const denominator = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
      if (denominator === 0) continue;
      const t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denominator;
      const u = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denominator;
      if (t > 0 && t < 1 && u > 0 && u < 1) out.push(ax + t * (bx - ax));
    }
  }
}

/** Réunion d'intervalles [début, fin] triés par début. */
function union(intervals: [number, number][]): [number, number][] {
  intervals.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [start, end] of intervals) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/**
 * Surface couverte par la réunion des polygones (concaves compris), limitée à `within` s'il est donné. Calcul exact par
 * bandes verticales : entre deux sommets ou croisements de côtés, la longueur coupée par une verticale varie linéairement,
 * sa valeur au milieu de la bande donne donc l'aire exacte de la bande.
 */
export function coveredArea(polygons: readonly (readonly XY[])[], within?: readonly XY[]): number {
  if (polygons.length === 0) return 0;
  const all = within ? [...polygons, within] : polygons;
  const xs: number[] = [];
  for (const polygon of all) for (const [x] of polygon) xs.push(x);
  edgeCrossings(all, xs);
  xs.sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const width = xs[i + 1] - xs[i];
    if (width <= 1e-12) continue;
    const middle = (xs[i] + xs[i + 1]) / 2;
    const spans: [number, number][] = [];
    for (const polygon of polygons) {
      const ys = crossings(polygon, middle);
      for (let k = 0; k + 1 < ys.length; k += 2) spans.push([ys[k], ys[k + 1]]);
    }
    let covered = union(spans);
    if (within) {
      const ys = crossings(within, middle), clipped: [number, number][] = [];
      for (let k = 0; k + 1 < ys.length; k += 2) {
        for (const [start, end] of covered) {
          const low = Math.max(start, ys[k]), high = Math.min(end, ys[k + 1]);
          if (high > low) clipped.push([low, high]);
        }
      }
      covered = clipped;
    }
    for (const [start, end] of covered) area += (end - start) * width;
  }
  return area;
}

export function proposalFigures(limit: readonly XY[], volumes: readonly Volume[], settings: StudySettings): Figures {
  const siteArea = limit.length >= 3 ? polygonArea(limit) : 0;
  const footprints = volumes.map((volume) => volume.footprint);
  const gfaByUse: Record<string, number> = {};
  let gfa = 0, highestPoint = volumes.length > 0 ? -Infinity : NaN;
  for (const volume of volumes) {
    const area = polygonArea(volume.footprint);
    for (let floor = 0; floor < volume.floors; floor++) {
      const use = useOf(volume, floor);
      gfaByUse[use] = (gfaByUse[use] ?? 0) + area;
      gfa += area;
    }
    highestPoint = Math.max(highestPoint, volume.baseLevel + volume.floors * volume.floorHeight);
  }
  const housing = settings.uses.filter((use) => use.housing).reduce((sum, use) => sum + (gfaByUse[use.id] ?? 0), 0);
  const footprint = coveredArea(footprints);
  return {
    siteArea,
    footprint,
    coverage: siteArea > 0 ? footprint / siteArea : NaN,
    gfa,
    gfaByUse,
    plotRatio: siteArea > 0 ? gfa / siteArea : NaN,
    highestPoint,
    openGround: siteArea > 0 ? siteArea - coveredArea(footprints, limit) : NaN,
    dwellings: Math.floor((housing * settings.efficiency) / settings.dwellingSize + 1e-9),
    volumes: volumes.length,
  };
}

const SQUARE_FEET = 10.763910416709722;
const format = (digits: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits, useGrouping: false });
const [whole, one, two] = [format(0), format(1), format(2)];
const show = (value: number, formatter: Intl.NumberFormat) => (Number.isFinite(value) ? formatter.format(value) : '—');

/** Le tableau des chiffres : une ligne par indicateur, une colonne par proposition (en tête : leurs noms). */
export function figureRows(study: Study, proposals: readonly Proposal[]): string[][] {
  const { settings } = study;
  const figures = proposals.map((proposal) => proposalFigures(study.site.limit, proposal.volumes, settings));
  const [unit, factor] = settings.units === 'ft2' ? ['ft²', SQUARE_FEET] : ['m²', 1];
  const area = (pick: (f: Figures) => number) => figures.map((f) => show(pick(f) * factor, whole));
  const rows: string[][] = [
    ['Indicateur', ...proposals.map((proposal) => proposal.name)],
    [`Surface du terrain (${unit})`, ...area((f) => f.siteArea)],
    [`Emprise bâtie (${unit})`, ...area((f) => f.footprint)],
    ['Emprise bâtie (%)', ...figures.map((f) => show(f.coverage * 100, one))],
    [`Surface de plancher (${unit})`, ...area((f) => f.gfa)],
  ];
  for (const use of settings.uses) {
    if (figures.some((f) => f.gfaByUse[use.id])) rows.push([`  dont ${use.name} (${unit})`, ...area((f) => f.gfaByUse[use.id] ?? 0)]);
  }
  rows.push(
    ['COS (surface de plancher / terrain)', ...figures.map((f) => show(f.plotRatio, two))],
    ['Point le plus haut (m)', ...figures.map((f) => show(f.highestPoint, one))],
    [`Pleine terre (${unit})`, ...area((f) => f.openGround)],
    ['Logements estimés', ...figures.map((f) => show(f.dwellings, whole))],
    ['Volumes', ...figures.map((f) => show(f.volumes, whole))],
  );
  return rows;
}

/** Texte à coller dans un tableur : tabulations entre les cellules, une ligne par rangée. */
export const toTsv = (rows: readonly (readonly string[])[]): string => rows.map((row) => row.map((cell) => cell.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n');
