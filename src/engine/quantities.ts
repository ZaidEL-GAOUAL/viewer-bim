// Les quantités d'un élément calculées depuis la forme affichée (« calcul des manquants », voir
// docs/superpowers/plans/2026-11-14-roadmap/06-quantities-zoning.md, partie A) : longueur, largeur, hauteur, emprise au sol,
// surface latérale, surface extérieure, volume. Valeurs nettes : les maillages arrivent avec leurs ouvertures déjà percées.
// Où elles s'écrivent est une donnée (les préréglages de data/presets) : aucun nom de propriété n'est connu ici.

import { combineMeasures, measureElement } from './dimensions.ts';
import type { MeshPart } from './meshMath.ts';
import { runSliced } from './sliced.ts';
import { isMissing } from '../data/conditions.ts';
import { ownValue, type FlatProps, type PropValue, type PropertyStore } from '../data/metadata.ts';
import { fold } from '../data/text.ts';

export const QUANTITIES = ['length', 'width', 'height', 'footprint', 'sideArea', 'outerArea', 'volume'] as const;
export type QuantityName = (typeof QUANTITIES)[number];
export const QUANTITY_LABELS: Readonly<Record<QuantityName, string>> = {
  length: 'Longueur', width: 'Largeur', height: 'Hauteur', footprint: 'Emprise au sol', sideArea: 'Surface latérale',
  outerArea: 'Surface extérieure', volume: 'Volume',
};

export type ElementQuantities = Record<QuantityName, number> & {
  /** Vrai pour un solide fermé : `exact` ; sinon `indicatif`. */
  exact: boolean;
};

/** Valeur de `Fiabilité` écrite à côté des quantités. */
export const reliabilityOf = (quantities: ElementQuantities): string => (quantities.exact ? 'exact' : 'indicatif');

/** Au-delà de ce nombre de triangles projetés, l'emprise est la somme des faces vues de dessus (voir `footprintArea`). */
const UNION_LIMIT = 400;

/**
 * Les quantités d'un élément, ou null sans géométrie. Longueur et largeur : rectangle minimal au sol ; hauteur : étendue
 * verticale ; emprise : aire de la projection au sol (son contour réel, pas l'enveloppe convexe) ; surface latérale : l'élément
 * vu de côté, perpendiculairement à sa longueur (un côté de mur, ouvertures déduites) ; surface extérieure : toutes ses faces.
 */
export function elementQuantities(parts: MeshPart[]): ElementQuantities | null {
  const measure = measureElement(parts);
  if (!measure) return null;
  const dims = combineMeasures([measure])!;
  const angle = (dims.angle * Math.PI) / 180;
  // Perpendiculaire à la longueur, dans le plan (x, z) où le rectangle minimal est calculé.
  const sx = -Math.sin(angle), sz = Math.cos(angle);
  let side = 0;
  const projected: number[] = [];
  let upward = 0;
  for (const { positions: p, index, start, count } of parts) {
    for (let k = start, end = start + count; k + 2 < end; k += 3) {
      const a = index[k] * 3, b = index[k + 1] * 3, c = index[k + 2] * 3;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      // Double de l'aire orientée : ses composantes sont les aires projetées sur chaque plan.
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const toward = (nx * sx + nz * sz) / 2;
      if (toward > 0) side += toward;
      // Un solide fermé se projette exactement par ses faces tournées vers le haut ; un maillage ouvert, par toutes.
      if (ny > 0 || (!measure.closed && ny < 0)) {
        projected.push(p[a], p[a + 2], p[b], p[b + 2], p[c], p[c + 2]);
        upward += Math.abs(ny) / 2;
      }
    }
  }
  const footprint = projected.length / 6 <= UNION_LIMIT ? unionArea(projected) : upward;
  return {
    length: dims.length, width: dims.width, height: dims.height, footprint, sideArea: side, outerArea: dims.area, volume: dims.volume,
    exact: measure.closed,
  };
}

/**
 * Aire de la réunion de triangles 2D (x, y × 3 par triangle), par bandes verticales : entre deux abscisses où rien ne se
 * croise, la longueur couverte varie linéairement et se mesure au milieu de la bande.
 * shortcut: comparaison de toutes les arêtes deux à deux, d'où `UNION_LIMIT` ; au-delà, la somme des faces (exacte si aucune
 * verticale ne traverse l'élément deux fois). Passer à un vrai découpage de polygones si de gros éléments le demandent.
 */
export function unionArea(triangles: readonly number[]): number {
  const xs = new Set<number>();
  for (let i = 0; i < triangles.length; i += 2) xs.add(triangles[i]);
  const edges: number[][] = [];
  for (let t = 0; t < triangles.length; t += 6) {
    for (let j = 0; j < 3; j++) {
      const a = t + j * 2, b = t + ((j + 1) % 3) * 2;
      edges.push([triangles[a], triangles[a + 1], triangles[b], triangles[b + 1]]);
    }
  }
  for (let i = 0; i < edges.length; i++) {
    const [ax, ay, bx, by] = edges[i];
    for (let j = i + 1; j < edges.length; j++) {
      const [cx, cy, dx, dy] = edges[j];
      if (Math.max(ax, bx) < Math.min(cx, dx) || Math.max(cx, dx) < Math.min(ax, bx)) continue;
      const denominator = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
      if (denominator === 0) continue;
      const s = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / denominator;
      const t = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / denominator;
      if (s > 0 && s < 1 && t > 0 && t < 1) xs.add(ax + s * (bx - ax));
    }
  }
  const sorted = [...xs].sort((a, b) => a - b);
  let area = 0;
  const intervals: [number, number][] = [];
  for (let k = 0; k + 1 < sorted.length; k++) {
    const width = sorted[k + 1] - sorted[k];
    if (width <= 0) continue;
    const x = (sorted[k] + sorted[k + 1]) / 2;
    intervals.length = 0;
    for (let t = 0; t < triangles.length; t += 6) {
      let low = Infinity, high = -Infinity;
      for (let j = 0; j < 3; j++) {
        const a = t + j * 2, b = t + ((j + 1) % 3) * 2;
        const [x0, y0, x1, y1] = [triangles[a], triangles[a + 1], triangles[b], triangles[b + 1]];
        if (x0 === x1 || x < Math.min(x0, x1) || x > Math.max(x0, x1)) continue;
        const y = y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
        low = Math.min(low, y);
        high = Math.max(high, y);
      }
      if (high > low) intervals.push([low, high]);
    }
    intervals.sort((a, b) => a[0] - b[0]);
    let covered = 0, from = 0, to = -Infinity;
    for (const [low, high] of intervals) {
      if (low > to) {
        if (to > from) covered += to - from;
        from = low;
        to = high;
      } else to = Math.max(to, high);
    }
    if (to > from) covered += to - from;
    area += covered * width;
  }
  return area;
}

/** Ce que le calcul lit d'un modèle (voir `Model`) : les triangles de chaque élément et leurs plages, qui servent de clé au cache. */
export interface QuantityModel {
  parts(index: number): MeshPart[];
  ranges: readonly (readonly unknown[])[];
}

/** Cache par élément : la clé est la liste des plages de l'élément, refaite si l'élément change (pièces régénérées). */
const cache = new WeakMap<object, ElementQuantities | null>();

/** Travail entre deux pauses : des triangles lus. */
const BUDGET = 60_000;

/**
 * Le calcul par tranches : à chaque pause, la part des éléments faits (0 à 1). Les résultats s'ajoutent à `out` au fur et à
 * mesure ; arrêter le générateur abandonne le reste.
 */
export function* quantitiesJob(model: QuantityModel, indices: readonly number[], out: Map<number, ElementQuantities | null>, budget = BUDGET): Generator<number, void, unknown> {
  let work = 0;
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i];
    const key = model.ranges[index];
    if (key && cache.has(key)) {
      out.set(index, cache.get(key)!);
      work++;
    } else {
      const parts = model.parts(index);
      const quantities = elementQuantities(parts);
      if (key) cache.set(key, quantities);
      out.set(index, quantities);
      for (const part of parts) work += part.count / 3;
    }
    if (work >= budget) {
      work = 0;
      yield (i + 1) / indices.length;
    }
  }
}

/**
 * Les quantités des éléments donnés, par tranches de quelques millisecondes entre deux images. `onProgress` reçoit
 * l'avancement (0 à 1) ; `signal` interrompt (la promesse est alors rejetée).
 */
export async function computeQuantities(model: QuantityModel, indices: readonly number[], onProgress?: (progress: number) => void, signal?: AbortSignal): Promise<Map<number, ElementQuantities | null>> {
  const out = new Map<number, ElementQuantities | null>();
  await runSliced(quantitiesJob(model, indices, out), onProgress, signal);
  return out;
}

// ------------------------------------------------------------------ où écrire

/** Un préréglage (fichier de data/presets) : chemin de chaque quantité, ou par classe d'élément. */
export interface QuantityPreset {
  name: string;
  /** Chemin de la propriété `Fiabilité`. */
  reliability: string;
  /** Chemin de propriété → quantité, pour tous les éléments. */
  targets?: Record<string, QuantityName>;
  /** Propriété qui porte la classe de l'élément, et pour chaque classe son groupe et ses noms (`groupe / nom` → quantité). */
  classProperty?: string;
  classes?: Record<string, { group: string; targets: Record<string, QuantityName> }>;
}

/** Les cibles d'un élément d'après ses propriétés : [chemin, quantité], vides si le préréglage ne le concerne pas (classe inconnue). */
export function targetsFor(preset: QuantityPreset, props: FlatProps | undefined): [string, QuantityName][] {
  if (preset.targets) return Object.entries(preset.targets);
  if (!preset.classProperty || !preset.classes) return [];
  const value = ownValue(props, preset.classProperty);
  if (isMissing(value)) return [];
  const entry = Object.entries(preset.classes).find(([name]) => fold(name) === fold(value));
  return entry ? Object.entries(entry[1].targets).map(([name, quantity]) => [`${entry[1].group} / ${name}`, quantity]) : [];
}

export interface QuantityReport {
  /** Valeurs écrites. */
  filled: number;
  /** Valeurs déjà renseignées, laissées telles quelles. */
  present: number;
  /** Éléments sans géométrie. */
  notComputable: number;
  /** Valeurs que le fichier verrouille (`readOnly`). */
  locked: number;
  /** Éléments que le préréglage ne concerne pas (classe sans quantités de base). */
  unmatched: number;
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * Ce qu'il faut écrire : pour chaque élément calculé et chaque cible, la valeur si la propriété est vide (ou toujours si
 * `overwrite`), et `Fiabilité` dès qu'une valeur de l'élément est écrite. À passer d'un bloc à `PropertyEdits.setMany` :
 * une seule étape annulable.
 */
export function quantityUpdates(store: PropertyStore, results: ReadonlyMap<number, ElementQuantities | null>, preset: QuantityPreset, overwrite: boolean): { updates: [number, string, PropValue][]; report: QuantityReport } {
  const updates: [number, string, PropValue][] = [];
  const report: QuantityReport = { filled: 0, present: 0, notComputable: 0, locked: 0, unmatched: 0 };
  for (const [index, quantities] of results) {
    if (!quantities) {
      report.notComputable++;
      continue;
    }
    const targets = targetsFor(preset, store.propsOf(index));
    if (targets.length === 0) {
      report.unmatched++;
      continue;
    }
    const props = store.propsOf(index);
    let wrote = false;
    for (const [path, quantity] of targets) {
      if (!isMissing(ownValue(props, path)) && !overwrite) report.present++;
      else if (!store.isEditable(path)) report.locked++;
      else {
        updates.push([index, path, round(quantities[quantity])]);
        report.filled++;
        wrote = true;
      }
    }
    if (wrote && store.isEditable(preset.reliability)) updates.push([index, preset.reliability, reliabilityOf(quantities)]);
  }
  return { updates, report };
}
