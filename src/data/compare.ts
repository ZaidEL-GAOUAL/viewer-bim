// Comparaison de deux versions d'une maquette, sur les données du viewer (clés, propriétés, triangles) : quel que soit le
// format. Pur : les deux côtés sont décrits par des fonctions ; rien n'est écrit dans les propriétés. Le résultat sert à
// colorer la vue par un état passager (`statusLayer`) et à exporter un rapport.
//
// 1. Les éléments sont appariés par clé (celle du fichier de chaque version).
// 2. Pour chaque paire, les propriétés ajoutées, retirées et changées, hors motifs ignorés (même syntaxe que `readOnly`).
// 3. Signature géométrique : boîte au millimètre, nombre de triangles, volume et surface à 4 chiffres significatifs →
//    même forme au même endroit, déplacée (même forme, boîte translatée) ou modifiée.
// 4. Seconde passe sur les éléments sans paire : même catégorie, même nom, même forme, centres à moins de
//    `renameDistance` → « identifiant changé, probablement le même », montré comme tel, jamais fusionné en silence.

import { formatValue, isReadOnly, ownValue, type FlatProps, type PropValue } from './metadata.ts';
import type { ElementAppearance } from './appearanceRules.ts';
import type { MeshPart } from '../engine/meshMath.ts';
import { MODEL_PROPERTY } from './federation.ts';
import { csvCell } from './text.ts';

/** Boîte en millimètres (repère du modèle) : minX, minY, minZ, maxX, maxY, maxZ ; volume en m³ et surface en m² arrondis. */
export interface GeometrySignature {
  box: [number, number, number, number, number, number];
  triangles: number;
  volume: number;
  area: number;
}

/** Un côté de la comparaison : ses éléments (numéros dans le modèle) et de quoi les lire. */
export interface CompareSide {
  elements: readonly number[];
  key(element: number): string;
  label(element: number): string;
  props(element: number): FlatProps | undefined;
  /** La valeur qui range l'élément (propriété de regroupement choisie), pour la seconde passe. */
  category?(element: number): string | undefined;
  signature(element: number): GeometrySignature | null;
  /** Coût du calcul de la signature (triangles), pour découper le travail en tranches. */
  cost?(element: number): number;
}

export interface PropertyChange {
  path: string;
  /** Absente : la propriété n'existait pas avant (ou n'existe plus après). */
  before?: PropValue;
  after?: PropValue;
}

export type GeometryStatus = 'same' | 'moved' | 'changed';

export interface ComparedPair {
  current: number;
  reference: number;
  changes: PropertyChange[];
  geometry: GeometryStatus;
}

export interface CompareResult {
  /** Éléments de la version courante sans équivalent dans la référence. */
  added: number[];
  /** Éléments de la référence sans équivalent dans la version courante. */
  removed: number[];
  modified: { properties: ComparedPair[]; geometry: ComparedPair[]; moved: ComparedPair[] };
  unchanged: ComparedPair[];
  /** Sans paire par clé, mais même catégorie, même nom et même forme tout près : probablement le même élément. */
  renamedIds: ComparedPair[];
  /** Part des éléments des deux côtés sans paire par clé (au-delà de 0,5 : identifiants sans doute régénérés). */
  unpairedShare: number;
}

export interface CompareOptions {
  /** Propriétés ignorées : nom exact, catégorie entière, ou préfixe suivi de `*`. `Modèle` l'est toujours. */
  ignore?: readonly string[];
  /** Distance au plus entre les centres de deux éléments « probablement les mêmes », en mètres (0,5 par défaut). */
  renameDistance?: number;
}

const round4 = (value: number): number => (value === 0 ? 0 : Number(value.toPrecision(4)));

/**
 * La signature géométrique d'un élément : `parts` ses triangles (repère du viewer), `boxes` les boîtes des éléments,
 * `offset` le décalage du modèle. Le volume est pris par rapport au coin de la boîte : il ne change pas quand l'élément se
 * déplace, même ouvert. Null pour un élément sans triangle.
 */
export function elementSignature(model: { parts(element: number): MeshPart[]; boxes: Float32Array }, element: number, offset: readonly number[]): GeometrySignature | null {
  const at = element * 6, b = model.boxes;
  if (!(b[at] <= b[at + 3])) return null;
  const ox = b[at], oy = b[at + 1], oz = b[at + 2];
  let volume = 0, area = 0, triangles = 0;
  for (const { positions: p, index, start, count } of model.parts(element)) {
    for (let k = start, end = start + count; k + 2 < end; k += 3) {
      const i = index[k] * 3, j = index[k + 1] * 3, l = index[k + 2] * 3;
      const ax = p[i] - ox, ay = p[i + 1] - oy, az = p[i + 2] - oz;
      const bx = p[j] - ox, by = p[j + 1] - oy, bz = p[j + 2] - oz;
      const cx = p[l] - ox, cy = p[l + 1] - oy, cz = p[l + 2] - oz;
      volume += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      triangles++;
    }
  }
  const mm = (value: number, axis: number) => Math.round((value + offset[axis]) * 1000);
  return {
    box: [mm(b[at], 0), mm(b[at + 1], 1), mm(b[at + 2], 2), mm(b[at + 3], 0), mm(b[at + 4], 1), mm(b[at + 5], 2)],
    triangles, volume: round4(Math.abs(volume)), area: round4(area),
  };
}

/** Deux valeurs arrondies à 4 chiffres : égales, ou voisines d'un arrondi. */
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-3 * Math.max(Math.abs(a), Math.abs(b)) + 1e-9;

function sameShape(a: GeometrySignature, b: GeometrySignature): boolean {
  if (a.triangles !== b.triangles || !close(a.volume, b.volume) || !close(a.area, b.area)) return false;
  for (let axis = 0; axis < 3; axis++) if (Math.abs((a.box[axis + 3] - a.box[axis]) - (b.box[axis + 3] - b.box[axis])) > 1) return false;
  return true;
}

export function geometryStatus(a: GeometrySignature | null, b: GeometrySignature | null): GeometryStatus {
  if (!a || !b) return a === b ? 'same' : 'changed';
  if (!sameShape(a, b)) return 'changed';
  return a.box.every((value, i) => Math.abs(value - b.box[i]) <= 1) ? 'same' : 'moved';
}

/** Ce qui diffère entre les propriétés de deux éléments, hors motifs ignorés, par chemin. */
export function propertyChanges(before: FlatProps | undefined, after: FlatProps | undefined, ignore: readonly string[]): PropertyChange[] {
  const changes: PropertyChange[] = [];
  for (const path of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    if (path === MODEL_PROPERTY || isReadOnly(path, ignore)) continue;
    const a = ownValue(before, path), b = ownValue(after, path);
    if (a === b) continue;
    const change: PropertyChange = { path };
    if (a !== undefined) change.before = a;
    if (b !== undefined) change.after = b;
    changes.push(change);
  }
  return changes.sort((x, y) => x.path.localeCompare(y.path, 'fr'));
}

/** Les signatures se calculent par tranches : une pause toutes les `BUDGET` unités (triangles). */
const BUDGET = 60_000;

/**
 * Compare la version courante à la référence, par tranches (avancement de 0 à 1, voir `runSliced`). Les signatures ne sont
 * calculées qu'une fois par élément.
 */
export function* compareJob(current: CompareSide, reference: CompareSide, options: CompareOptions = {}): Generator<number, CompareResult, unknown> {
  const ignore = options.ignore ?? [];
  const renameDistance = (options.renameDistance ?? 0.5) * 1000;
  const total = current.elements.length + reference.elements.length || 1;
  let done = 0, work = 0;
  const signatures = new Map<CompareSide, Map<number, GeometrySignature | null>>([[current, new Map()], [reference, new Map()]]);
  // Une seule pause possible par appel : l'appelant `yield*` ses avancements.
  function* signature(side: CompareSide, element: number): Generator<number, GeometrySignature | null, unknown> {
    const cache = signatures.get(side)!;
    if (cache.has(element)) return cache.get(element)!;
    const value = side.signature(element);
    cache.set(element, value);
    done++;
    work += side.cost?.(element) ?? value?.triangles ?? 1;
    if (work >= BUDGET) {
      work = 0;
      yield Math.min(1, done / total);
    }
    return value;
  }

  const byKey = new Map<string, number>();
  for (const element of reference.elements) if (!byKey.has(reference.key(element))) byKey.set(reference.key(element), element);
  const result: CompareResult = { added: [], removed: [], modified: { properties: [], geometry: [], moved: [] }, unchanged: [], renamedIds: [], unpairedShare: 0 };
  const paired = new Set<number>();
  for (const element of current.elements) {
    const match = byKey.get(current.key(element));
    if (match === undefined || paired.has(match)) {
      result.added.push(element);
      continue;
    }
    paired.add(match);
    const pair: ComparedPair = {
      current: element, reference: match,
      changes: propertyChanges(reference.props(match), current.props(element), ignore),
      geometry: geometryStatus(yield* signature(current, element), yield* signature(reference, match)),
    };
    if (pair.changes.length > 0) result.modified.properties.push(pair);
    if (pair.geometry === 'changed') result.modified.geometry.push(pair);
    if (pair.geometry === 'moved') result.modified.moved.push(pair);
    if (pair.changes.length === 0 && pair.geometry === 'same') result.unchanged.push(pair);
  }
  result.removed = reference.elements.filter((element) => !paired.has(element));
  result.unpairedShare = (result.added.length + result.removed.length) / total;

  // Seconde passe : même catégorie, même nom, même forme, tout près.
  const bucket = (side: CompareSide, element: number, shape: GeometrySignature | null) => `${side.category?.(element) ?? ''}\u0000${side.label(element)}\u0000${shape?.triangles ?? -1}`;
  const candidates = new Map<string, { element: number; shape: GeometrySignature | null }[]>();
  for (const element of result.removed) {
    const shape = yield* signature(reference, element);
    const key = bucket(reference, element, shape);
    const list = candidates.get(key);
    if (list) list.push({ element, shape });
    else candidates.set(key, [{ element, shape }]);
  }
  const centre = (s: GeometrySignature, axis: number) => (s.box[axis] + s.box[axis + 3]) / 2;
  const taken = new Set<number>();
  const stillAdded: number[] = [];
  for (const element of result.added) {
    const shape = yield* signature(current, element);
    let best: { element: number; shape: GeometrySignature | null } | null = null, bestDistance = Infinity;
    for (const candidate of candidates.get(bucket(current, element, shape)) ?? []) {
      if (taken.has(candidate.element) || !shape || !candidate.shape || !sameShape(shape, candidate.shape)) continue;
      const distance = Math.hypot(centre(shape, 0) - centre(candidate.shape, 0), centre(shape, 1) - centre(candidate.shape, 1), centre(shape, 2) - centre(candidate.shape, 2));
      if (distance <= renameDistance && distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    if (!best) {
      stillAdded.push(element);
      continue;
    }
    taken.add(best.element);
    result.renamedIds.push({ current: element, reference: best.element, changes: propertyChanges(reference.props(best.element), current.props(element), ignore), geometry: geometryStatus(shape, best.shape) });
  }
  result.added = stillAdded;
  result.removed = result.removed.filter((element) => !taken.has(element));
  return result;
}

/** Couleurs de l'état passager : ajouté vert, supprimé rouge translucide (dessiné depuis la référence), modifié orange, inchangé estompé. */
export const COMPARE_COLORS = { added: '#16a34a', removed: '#dc2626', modified: '#f59e0b', unchanged: '#9ca3af', renamed: '#2563eb' } as const;

/**
 * L'état passager de chaque élément (numéro → couleur et opacité) : la référence d'une paire n'est pas dessinée (opacité 0),
 * l'élément courant porte le statut.
 */
export function statusLayer(result: CompareResult): Map<number, ElementAppearance> {
  const layer = new Map<number, ElementAppearance>();
  const modified = new Set([...result.modified.properties, ...result.modified.geometry, ...result.modified.moved]);
  for (const element of result.added) layer.set(element, { color: COMPARE_COLORS.added });
  for (const element of result.removed) layer.set(element, { color: COMPARE_COLORS.removed, opacity: 0.45 });
  for (const pair of [...modified, ...result.unchanged, ...result.renamedIds]) layer.set(pair.reference, { opacity: 0 });
  for (const pair of modified) layer.set(pair.current, { color: COMPARE_COLORS.modified });
  for (const pair of result.unchanged) layer.set(pair.current, { color: COMPARE_COLORS.unchanged, opacity: 0.3 });
  for (const pair of result.renamedIds) layer.set(pair.current, { color: COMPARE_COLORS.renamed });
  return layer;
}

const describe = (pair: ComparedPair): string => [
  ...pair.changes.map((change) => `${change.path} : ${change.before === undefined ? '(absente)' : formatValue(change.before)} → ${change.after === undefined ? '(absente)' : formatValue(change.after)}`),
  pair.geometry === 'moved' ? 'déplacé' : pair.geometry === 'changed' ? 'forme modifiée' : '',
].filter(Boolean).join(' · ');

/** Une ligne par élément ajouté, supprimé, modifié ou à l'identifiant changé (les inchangés ne sont que comptés). */
function rows(result: CompareResult, current: CompareSide, reference: CompareSide): string[][] {
  const out: string[][] = [];
  for (const element of result.added) out.push(['ajouté', current.key(element), current.label(element), '', '']);
  for (const element of result.removed) out.push(['supprimé', '', reference.label(element), reference.key(element), '']);
  const modified = [...new Set([...result.modified.properties, ...result.modified.geometry, ...result.modified.moved])];
  for (const pair of modified) out.push(['modifié', current.key(pair.current), current.label(pair.current), reference.key(pair.reference), describe(pair)]);
  for (const pair of result.renamedIds) out.push(['identifiant changé (probablement le même)', current.key(pair.current), current.label(pair.current), reference.key(pair.reference), describe(pair)]);
  return out;
}

export function compareCsv(result: CompareResult, current: CompareSide, reference: CompareSide): string {
  return [['Statut', 'Clé', 'Nom', 'Clé avant', 'Détail'], ...rows(result, current, reference)].map((row) => row.map((cell) => csvCell(cell)).join(';')).join('\r\n');
}

/** Le rapport en JSON : clés des éléments, et pour chaque modification ses propriétés et sa géométrie. */
export function compareReport(result: CompareResult, current: CompareSide, reference: CompareSide) {
  const pair = (item: ComparedPair) => ({ key: current.key(item.current), referenceKey: reference.key(item.reference), name: current.label(item.current), properties: item.changes, geometry: item.geometry });
  return {
    added: result.added.map((element) => current.key(element)),
    removed: result.removed.map((element) => reference.key(element)),
    modified: [...new Set([...result.modified.properties, ...result.modified.geometry, ...result.modified.moved])].map(pair),
    unchanged: result.unchanged.length,
    renamedIds: result.renamedIds.map(pair),
  };
}
