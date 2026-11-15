// Comparaison de deux versions d'une maquette, sur les données du viewer (clés, propriétés, triangles) : quel que soit le
// format. Pur : les deux côtés sont décrits par des fonctions ; rien n'est écrit dans les propriétés. Le résultat sert à
// colorer la vue par un état passager (`statusLayer`) et à exporter un rapport.
//
// 1. Les éléments sont appariés par clé (celle du fichier de chaque version). Une clé portée deux fois d'un même côté est un
//    doublon, signalé à part. Les pièces d'un découpage (`<clé>~n`) d'un côté, dont l'original est de l'autre, sont comparées
//    comme cet original.
// 2. Pour chaque paire, les propriétés ajoutées, retirées et changées, hors motifs ignorés (même syntaxe que `readOnly`) ; quand
//    les deux maquettes n'ont pas le même moteur, celles des chemins verrouillés sont des « écarts de conversion », à part.
// 3. Signature géométrique : boîte au millimètre, volume et surface à 4 chiffres significatifs → même forme au même endroit,
//    déplacée (même forme, boîte translatée) ou modifiée, selon une tolérance (stricte, ou large entre deux moteurs). Le nombre de
//    triangles ne décide rien : seul, il donne « même forme, maillage différent ». Un élément dessiné par sa seule boîte n'est
//    pas comparable.
// 4. Seconde passe sur les éléments sans paire : même catégorie, même nom, même forme, centres à moins de
//    `renameDistance` → « identifiant changé, probablement le même », montré comme tel, jamais fusionné en silence.

import { formatValue, isReadOnly, ownValue, type FlatProps, type PropValue } from './metadata.ts';
import type { ElementAppearance } from './appearanceRules.ts';
import type { MeshPart } from '../engine/meshMath.ts';
import { targetsFor, type QuantityPreset } from '../engine/quantities.ts';
import { MODEL_PROPERTY } from './federation.ts';
import groupPreset from './presets/quantites-groupe.json' with { type: 'json' };
import ifcPreset from './presets/quantites-ifc.json' with { type: 'json' };
import { PART_NUMBER, PART_ORIGIN, PART_SEPARATOR, PART_SEQUENCE, PART_VALID } from './splits.ts';
import { csvCell, integer } from './text.ts';

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
  /** Vrai pour un élément dessiné par sa seule boîte, sa forme n'ayant pas été lue : sa géométrie ne se compare pas. */
  approximate?(element: number): boolean;
}

export interface PropertyChange {
  path: string;
  /** Absente : la propriété n'existait pas avant (ou n'existe plus après). */
  before?: PropValue;
  after?: PropValue;
}

/**
 * `same` : même forme au même endroit ; `remeshed` : de même, mais d'un autre maillage (nombre de triangles) ; `moved` : même
 * forme, boîte déplacée ; `changed` : autre forme ; `approximate` : l'un des deux n'est dessiné que par sa boîte, non comparable.
 */
export type GeometryStatus = 'same' | 'remeshed' | 'moved' | 'changed' | 'approximate';

export interface ComparedPair {
  current: number;
  reference: number;
  changes: PropertyChange[];
  /** Écarts sur les chemins de `CompareOptions.conversionPaths` : ils viennent de la conversion, pas de la maquette. */
  conversion: PropertyChange[];
  geometry: GeometryStatus;
  /** Triangles avant et après, quand les deux ont une géométrie. */
  triangles?: [number, number];
  /** Un original d'un côté, ses pièces de l'autre (`current` ou `reference` est alors la première pièce). */
  pieces?: { side: 'current' | 'reference'; elements: number[] };
}

export interface CompareResult {
  /** Éléments de la version courante sans équivalent dans la référence. */
  added: number[];
  /** Éléments de la référence sans équivalent dans la version courante. */
  removed: number[];
  modified: { properties: ComparedPair[]; geometry: ComparedPair[]; moved: ComparedPair[] };
  unchanged: ComparedPair[];
  /** Même forme au même endroit, d'un autre maillage, sans autre changement : estompés comme les inchangés. */
  remeshed: ComparedPair[];
  /** Sans changement de propriétés, mais l'un des deux n'est dessiné que par sa boîte : géométrie non comparable. */
  approximate: ComparedPair[];
  /** Les paires (de tous statuts) qui ont des écarts de conversion. */
  conversion: ComparedPair[];
  /** Sans paire par clé, mais même catégorie, même nom et même forme tout près : probablement le même élément. */
  renamedIds: ComparedPair[];
  /** Éléments dont la clé est déjà portée par un autre élément du même côté : signalés, ni ajoutés ni supprimés. */
  duplicates: { current: number[]; reference: number[] };
  /** Part des éléments des deux côtés sans paire par clé (au-delà de 0,5 : identifiants sans doute régénérés). */
  unpairedShare: number;
}

/** Écarts de forme admis : relatif sur le volume et la surface, en millimètres sur la boîte (taille et position). */
export interface ShapeTolerance {
  relative: number;
  box: number;
}

/** Deux fichiers d'un même moteur : 0,1 % et 1 mm. */
export const STRICT_TOLERANCE: ShapeTolerance = { relative: 0.001, box: 1 };
/** Deux moteurs de conversion différents : 1 % sur le volume et la surface, 2 mm sur la boîte (jamais plus sur la position). */
export const LOOSE_TOLERANCE: ShapeTolerance = { relative: 0.01, box: 2 };

export interface CompareOptions {
  /** Propriétés ignorées : nom exact, catégorie entière, ou préfixe suivi de `*`. `Modèle` l'est toujours. */
  ignore?: readonly string[];
  /** Distance au plus entre les centres de deux éléments « probablement les mêmes », en mètres (0,5 par défaut). */
  renameDistance?: number;
  /** Stricte par défaut. */
  tolerance?: ShapeTolerance;
  /** Motifs (syntaxe de `readOnly`) des propriétés dont un écart vient de la conversion : les chemins verrouillés, moteurs différents. */
  conversionPaths?: readonly string[];
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

/** Deux valeurs voisines à `relative` près (et d'un arrondi). */
const near = (a: number, b: number, relative: number) => Math.abs(a - b) <= relative * Math.max(Math.abs(a), Math.abs(b)) + 1e-9;

/** Même volume, même surface (sauf `ignoreArea` : les faces des coupes d'un découpage) et même taille de boîte, à la tolérance près. */
function sameShape(a: GeometrySignature, b: GeometrySignature, tolerance: ShapeTolerance, ignoreArea = false): boolean {
  if (!near(a.volume, b.volume, tolerance.relative) || (!ignoreArea && !near(a.area, b.area, tolerance.relative))) return false;
  for (let axis = 0; axis < 3; axis++) if (Math.abs((a.box[axis + 3] - a.box[axis]) - (b.box[axis + 3] - b.box[axis])) > tolerance.box) return false;
  return true;
}

/** `ignoreArea` : un original et ses pièces (leurs coupes ajoutent des faces, et des triangles). */
export function geometryStatus(a: GeometrySignature | null, b: GeometrySignature | null, tolerance = STRICT_TOLERANCE, ignoreArea = false): GeometryStatus {
  if (!a || !b) return a === b ? 'same' : 'changed';
  if (!sameShape(a, b, tolerance, ignoreArea)) return 'changed';
  if (!a.box.every((value, i) => Math.abs(value - b.box[i]) <= tolerance.box)) return 'moved';
  if (a.triangles === b.triangles || ignoreArea) return 'same';
  // Stricte (un même moteur) : un autre maillage n'explique qu'un volume et une surface égaux à 4 chiffres. Une petite
  // réservation dans une grande dalle (−0,08 % du volume, même boîte) reste une modification.
  return tolerance.relative > STRICT_TOLERANCE.relative || (a.volume === b.volume && a.area === b.area) ? 'remeshed' : 'changed';
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

/** Ce que le découpage écrit sur chaque pièce (voir `partProperties`) : `Pièce / …` et les quantités recalculées. */
function partPaths(original: FlatProps | undefined): Set<string> {
  const paths = new Set([PART_ORIGIN, PART_NUMBER, PART_SEQUENCE, PART_VALID]);
  for (const preset of [groupPreset, ifcPreset] as QuantityPreset[]) {
    paths.add(preset.reliability);
    for (const [path] of targetsFor(preset, original)) paths.add(path);
  }
  return paths;
}

/** Les signatures se calculent par tranches : une pause toutes les `BUDGET` unités (triangles). */
const BUDGET = 60_000;
/** Pas de la grille des tailles de boîte de la seconde passe, en millimètres (bien plus que la tolérance). */
const SIZE_CELL = 10;

/**
 * Compare la version courante à la référence, par tranches (avancement de 0 à 1, voir `runSliced`). Les signatures ne sont
 * calculées qu'une fois par élément.
 */
export function* compareJob(current: CompareSide, reference: CompareSide, options: CompareOptions = {}): Generator<number, CompareResult, unknown> {
  const ignore = options.ignore ?? [];
  const tolerance = options.tolerance ?? STRICT_TOLERANCE;
  const conversionPaths = options.conversionPaths ?? [];
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
  /** La signature de plusieurs éléments réunis (les pièces d'un original) : boîte englobante, volumes, surfaces et triangles sommés. */
  function* merged(side: CompareSide, elements: readonly number[]): Generator<number, GeometrySignature | null, unknown> {
    let out: GeometrySignature | null = null;
    for (const element of elements) {
      const shape = yield* signature(side, element);
      if (!shape) continue;
      if (!out) {
        out = { ...shape, box: [...shape.box] };
        continue;
      }
      for (let axis = 0; axis < 3; axis++) {
        out.box[axis] = Math.min(out.box[axis], shape.box[axis]);
        out.box[axis + 3] = Math.max(out.box[axis + 3], shape.box[axis + 3]);
      }
      out.triangles += shape.triangles;
      out.volume += shape.volume;
      out.area += shape.area;
    }
    return out;
  }
  const withConversion = (changes: PropertyChange[]) => {
    const conversion = conversionPaths.length > 0 ? changes.filter((change) => isReadOnly(change.path, conversionPaths)) : [];
    return { changes: conversion.length > 0 ? changes.filter((change) => !conversion.includes(change)) : changes, conversion };
  };

  const result: CompareResult = {
    added: [], removed: [], modified: { properties: [], geometry: [], moved: [] }, unchanged: [], remeshed: [], approximate: [], conversion: [],
    renamedIds: [], duplicates: { current: [], reference: [] }, unpairedShare: 0,
  };
  const keyed = (side: CompareSide, duplicates: number[]) => {
    const byKey = new Map<string, number>();
    for (const element of side.elements) {
      const key = side.key(element);
      if (byKey.has(key)) duplicates.push(element);
      else byKey.set(key, element);
    }
    return byKey;
  };
  const currentKeys = keyed(current, result.duplicates.current), referenceKeys = keyed(reference, result.duplicates.reference);

  // Les paires : par clé, puis les pièces d'un côté (`<clé>~n`, sans paire) avec leur original de l'autre (sans pièce de ce côté).
  const pairs: { current: number[]; reference: number[]; split?: 'current' | 'reference' }[] = [];
  for (const [key, element] of currentKeys) {
    const match = referenceKeys.get(key);
    if (match !== undefined) pairs.push({ current: [element], reference: [match] });
  }
  const piecesOf = (pieces: Map<string, number>, originals: Map<string, number>) => {
    const byBase = new Map<string, number[]>();
    for (const [key, element] of pieces) {
      const at = key.lastIndexOf(PART_SEPARATOR);
      if (at <= 0 || originals.has(key) || !/^\d+$/.test(key.slice(at + 1))) continue;
      const base = key.slice(0, at);
      if (!originals.has(base) || pieces.has(base)) continue;
      const list = byBase.get(base);
      if (list) list.push(element);
      else byBase.set(base, [element]);
    }
    return byBase;
  };
  for (const [base, elements] of piecesOf(currentKeys, referenceKeys)) pairs.push({ current: elements, reference: [referenceKeys.get(base)!], split: 'current' });
  for (const [base, elements] of piecesOf(referenceKeys, currentKeys)) pairs.push({ current: [currentKeys.get(base)!], reference: elements, split: 'reference' });

  const pairedCurrent = new Set<number>(), pairedReference = new Set<number>();
  for (const pair of pairs) {
    for (const element of pair.current) pairedCurrent.add(element);
    for (const element of pair.reference) pairedReference.add(element);
    const after = yield* merged(current, pair.current), before = yield* merged(reference, pair.reference);
    const approximate = pair.current.some((element) => current.approximate?.(element)) || pair.reference.some((element) => reference.approximate?.(element));
    let changes: PropertyChange[];
    if (!pair.split) changes = propertyChanges(reference.props(pair.reference[0]), current.props(pair.current[0]), ignore);
    else {
      // Ce que le découpage a écrit sur les pièces n'est pas un changement de l'original ; le reste, sur l'une des pièces, l'est.
      const original = pair.split === 'current' ? reference.props(pair.reference[0]) : current.props(pair.current[0]);
      const written = partPaths(original);
      const byPath = new Map<string, PropertyChange>();
      for (const piece of pair.split === 'current' ? pair.current : pair.reference) {
        const found = pair.split === 'current' ? propertyChanges(original, current.props(piece), ignore) : propertyChanges(reference.props(piece), original, ignore);
        for (const change of found) if (!written.has(change.path) && !byPath.has(change.path)) byPath.set(change.path, change);
      }
      changes = [...byPath.values()];
    }
    const compared: ComparedPair = {
      current: pair.current[0], reference: pair.reference[0], ...withConversion(changes),
      geometry: approximate ? 'approximate' : geometryStatus(after, before, tolerance, pair.split !== undefined),
    };
    if (after && before) compared.triangles = [before.triangles, after.triangles];
    if (pair.split) compared.pieces = { side: pair.split, elements: pair.split === 'current' ? pair.current : pair.reference };
    if (compared.changes.length > 0) result.modified.properties.push(compared);
    if (compared.geometry === 'changed') result.modified.geometry.push(compared);
    if (compared.geometry === 'moved') result.modified.moved.push(compared);
    if (compared.conversion.length > 0) result.conversion.push(compared);
    if (compared.changes.length === 0 && compared.geometry === 'same') result.unchanged.push(compared);
    if (compared.changes.length === 0 && compared.geometry === 'remeshed') result.remeshed.push(compared);
    if (compared.changes.length === 0 && compared.geometry === 'approximate') result.approximate.push(compared);
  }
  const duplicate = new Set([...result.duplicates.current, ...result.duplicates.reference]);
  result.added = current.elements.filter((element) => !pairedCurrent.has(element) && !duplicate.has(element));
  result.removed = reference.elements.filter((element) => !pairedReference.has(element) && !duplicate.has(element));
  result.unpairedShare = (result.added.length + result.removed.length) / total;

  // Seconde passe : même catégorie, même nom, même forme, tout près. Rangés par taille de boîte (au centimètre ; la recherche
  // regarde aussi les cases voisines, la tolérance pouvant franchir un arrondi).
  const cells = (shape: GeometrySignature) => [0, 1, 2].map((axis) => Math.round((shape.box[axis + 3] - shape.box[axis]) / SIZE_CELL));
  const bucket = (side: CompareSide, element: number, size: number[]) => `${side.category?.(element) ?? ''}\u0000${side.label(element)}\u0000${size.join(',')}`;
  const candidates = new Map<string, { element: number; shape: GeometrySignature }[]>();
  for (const element of result.removed) {
    const shape = yield* signature(reference, element);
    if (!shape) continue;
    const key = bucket(reference, element, cells(shape));
    const list = candidates.get(key);
    if (list) list.push({ element, shape });
    else candidates.set(key, [{ element, shape }]);
  }
  const centre = (s: GeometrySignature, axis: number) => (s.box[axis] + s.box[axis + 3]) / 2;
  const taken = new Set<number>();
  const stillAdded: number[] = [];
  for (const element of result.added) {
    const shape = yield* signature(current, element);
    let best: { element: number; shape: GeometrySignature } | null = null, bestDistance = Infinity;
    const [x, y, z] = shape ? cells(shape) : [0, 0, 0];
    for (let n = 0; n < 27 && shape; n++) {
      for (const candidate of candidates.get(bucket(current, element, [x + (n % 3) - 1, y + (Math.floor(n / 3) % 3) - 1, z + Math.floor(n / 9) - 1])) ?? []) {
        if (taken.has(candidate.element) || !sameShape(shape, candidate.shape, tolerance)) continue;
        const distance = Math.hypot(centre(shape, 0) - centre(candidate.shape, 0), centre(shape, 1) - centre(candidate.shape, 1), centre(shape, 2) - centre(candidate.shape, 2));
        if (distance <= renameDistance && distance < bestDistance) {
          best = candidate;
          bestDistance = distance;
        }
      }
    }
    if (!best || !shape) {
      stillAdded.push(element);
      continue;
    }
    taken.add(best.element);
    const renamed: ComparedPair = {
      current: element, reference: best.element, ...withConversion(propertyChanges(reference.props(best.element), current.props(element), ignore)),
      geometry: current.approximate?.(element) || reference.approximate?.(best.element) ? 'approximate' : geometryStatus(shape, best.shape, tolerance),
    };
    renamed.triangles = [best.shape.triangles, shape.triangles];
    result.renamedIds.push(renamed);
  }
  result.added = stillAdded;
  result.removed = result.removed.filter((element) => !taken.has(element));
  return result;
}

/** Couleurs de l'état passager : ajouté vert, supprimé rouge translucide (dessiné depuis la référence), modifié orange, inchangé estompé. */
export const COMPARE_COLORS = { added: '#16a34a', removed: '#dc2626', modified: '#f59e0b', unchanged: '#9ca3af', renamed: '#2563eb' } as const;

/** Les éléments d'un côté d'une paire : l'élément, ou toutes les pièces d'un original découpé. */
export const pairElements = (pair: ComparedPair, side: 'current' | 'reference'): number[] => (pair.pieces?.side === side ? pair.pieces.elements : [pair[side]]);

/**
 * L'état passager de chaque élément (numéro → couleur et opacité) : la référence d'une paire n'est pas dessinée (opacité 0),
 * l'élément courant porte le statut. Même forme d'un autre maillage, et forme non comparable sans autre changement : estompés
 * comme les inchangés. Un doublon de la référence n'est pas dessiné.
 */
export function statusLayer(result: CompareResult): Map<number, ElementAppearance> {
  const layer = new Map<number, ElementAppearance>();
  const modified = new Set([...result.modified.properties, ...result.modified.geometry, ...result.modified.moved]);
  const quiet = [...result.unchanged, ...result.remeshed, ...result.approximate];
  const paint = (pairs: Iterable<ComparedPair>, look: ElementAppearance) => {
    for (const pair of pairs) for (const element of pairElements(pair, 'current')) layer.set(element, look);
  };
  for (const element of result.added) layer.set(element, { color: COMPARE_COLORS.added });
  for (const element of result.removed) layer.set(element, { color: COMPARE_COLORS.removed, opacity: 0.45 });
  for (const element of result.duplicates.reference) layer.set(element, { opacity: 0 });
  for (const pair of [...modified, ...quiet, ...result.renamedIds]) for (const element of pairElements(pair, 'reference')) layer.set(element, { opacity: 0 });
  paint(modified, { color: COMPARE_COLORS.modified });
  paint(quiet, { color: COMPARE_COLORS.unchanged, opacity: 0.3 });
  paint(result.renamedIds, { color: COMPARE_COLORS.renamed });
  return layer;
}

export const changeText = (change: PropertyChange): string =>
  `${change.path} : ${change.before === undefined ? '(absente)' : formatValue(change.before)} → ${change.after === undefined ? '(absente)' : formatValue(change.after)}`;

/** Le statut géométrique en mots : « déplacé », « forme modifiée », « même forme, maillage différent (12 → 14 triangles) »… */
export function geometryText(pair: Pick<ComparedPair, 'geometry' | 'triangles'>): string {
  if (pair.geometry === 'remeshed') return `même forme, maillage différent${pair.triangles ? ` (${integer.format(pair.triangles[0])} → ${integer.format(pair.triangles[1])} triangles)` : ''}`;
  return { same: '', moved: 'déplacé', changed: 'forme modifiée', approximate: 'non comparable (forme approchée)' }[pair.geometry];
}

const describe = (pair: ComparedPair): string => [
  ...pair.changes.map(changeText), geometryText(pair), pair.pieces ? `découpé en ${integer.format(pair.pieces.elements.length)} pièces` : '',
].filter(Boolean).join(' · ');

/** Une ligne par élément ajouté, supprimé, modifié, à l'identifiant changé ou dans un statut à part (les inchangés ne sont que comptés). */
function rows(result: CompareResult, current: CompareSide, reference: CompareSide): string[][] {
  const out: string[][] = [];
  const line = (status: string, pair: ComparedPair, detail = describe(pair)) => out.push([status, current.key(pair.current), current.label(pair.current), reference.key(pair.reference), detail]);
  for (const element of result.added) out.push(['ajouté', current.key(element), current.label(element), '', '']);
  for (const element of result.removed) out.push(['supprimé', '', reference.label(element), reference.key(element), '']);
  for (const pair of new Set([...result.modified.properties, ...result.modified.geometry, ...result.modified.moved])) line('modifié', pair);
  for (const pair of result.renamedIds) line('identifiant changé (probablement le même)', pair);
  for (const pair of result.remeshed) line('même forme, maillage différent', pair);
  for (const pair of result.approximate) line('non comparable (forme approchée)', pair);
  for (const pair of result.conversion) line('écart de conversion', pair, pair.conversion.map(changeText).join(' · '));
  for (const element of result.duplicates.current) out.push(['identifiant en double', current.key(element), current.label(element), '', '']);
  for (const element of result.duplicates.reference) out.push(['identifiant en double', '', reference.label(element), reference.key(element), '']);
  return out;
}

/** Le rapport en CSV ; `header` : des lignes d'en-tête (l'origine de chaque maquette, la tolérance), une cellule chacune. */
export function compareCsv(result: CompareResult, current: CompareSide, reference: CompareSide, header: readonly string[] = []): string {
  return [...header.map((text) => [text]), ['Statut', 'Clé', 'Nom', 'Clé avant', 'Détail'], ...rows(result, current, reference)].map((row) => row.map((cell) => csvCell(cell)).join(';')).join('\r\n');
}

/** Le rapport en JSON : clés des éléments, et pour chaque modification ses propriétés et sa géométrie ; `header` comme pour le CSV. */
export function compareReport(result: CompareResult, current: CompareSide, reference: CompareSide, header: readonly string[] = []) {
  const pair = (item: ComparedPair) => ({
    key: current.key(item.current), referenceKey: reference.key(item.reference), name: current.label(item.current), properties: item.changes, geometry: item.geometry,
    ...(item.triangles ? { triangles: item.triangles } : {}), ...(item.pieces ? { pieces: item.pieces.elements.length } : {}),
  });
  return {
    ...(header.length > 0 ? { origins: [...header] } : {}),
    added: result.added.map((element) => current.key(element)),
    removed: result.removed.map((element) => reference.key(element)),
    modified: [...new Set([...result.modified.properties, ...result.modified.geometry, ...result.modified.moved])].map(pair),
    unchanged: result.unchanged.length,
    remeshed: result.remeshed.map(pair),
    approximate: result.approximate.map(pair),
    renamedIds: result.renamedIds.map(pair),
    conversion: result.conversion.map((item) => ({ ...pair(item), properties: item.conversion })),
    duplicates: { current: result.duplicates.current.map((element) => current.key(element)), reference: result.duplicates.reference.map((element) => reference.key(element)) },
  };
}
