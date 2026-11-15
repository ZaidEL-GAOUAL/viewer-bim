// Découpage d'éléments en pièces (section `splits` du contrat, voir docs/contrat-metadonnees.md) : le fichier garde la
// définition des coupes, jamais les maillages ; les pièces en sont tirées à l'ouverture et chaque fois que la définition
// change. Une pièce est un élément dérivé ajouté à la fin du modèle (voir `Model.parents`) : clé `<clé d'origine>~<n>`,
// numéros stables (voir `splitSolid`), propriétés de l'original complétées de `Pièce / …` et de ses propres quantités.
// L'original est masqué tant qu'il a des pièces (`ElementState.setReplaced`), jamais modifié ni retiré.
//
// Coordonnées : celles du repère du modèle (mètres, Y vers le haut, voir data/modelFrame.ts), comme les vues et les niveaux.

import { isRecord } from './json.ts';
import type { Level } from './levels.ts';
import { unflattenProperties, ownValue, type FlatProps, type Metadata, type PropertyStore } from './metadata.ts';
import type { PropertyEdits } from './PropertyEdits.ts';
import { openingProps } from './sidecar.ts';
import { toViewerPoint, type Vec3 } from './modelFrame.ts';
import groupPreset from './presets/quantites-groupe.json' with { type: 'json' };
import ifcPreset from './presets/quantites-ifc.json' with { type: 'json' };
import { ModelBuilder } from '../engine/buildModel.ts';
import type { Model } from '../engine/Model.ts';
import { partsToRaw, splitJob, type ElementSplit, type PartGeometry, type SplitRefusal } from '../engine/derivedParts.ts';
import { elementQuantities, reliabilityOf, targetsFor, type QuantityPreset } from '../engine/quantities.ts';
import type { MeshPart } from '../engine/meshMath.ts';
import { mergeSolids, verticalPlane, type CutPlane, type SplitPart } from '../engine/splitMesh.ts';
import { runSliced } from '../engine/sliced.ts';
import type { Color, IUniform } from 'three';

/** Coupes automatiques : aux niveaux nommés, ou le long d'un axe (positions, pas régulier depuis le bord, ou N parts égales). */
export interface SplitReferences {
  levels?: string[];
  axis?: 'x' | 'z';
  positions?: number[];
  interval?: number;
  count?: number;
}

export interface SplitDefinition {
  id: string;
  /** Clés des éléments découpés. */
  elements: string[];
  /**
   * Lignes dessinées en plan : chacune porte un plan de coupe vertical et doit traverser l'élément de part en part. Une coupe
   * droite de la carte est la ligne entière par ses deux clics : elle est enregistrée prolongée à travers toute la sélection
   * (`extendAcross`), si bien qu'une définition plus ancienne se lit et se découpe exactement comme avant.
   */
  lines?: [Vec3, Vec3][];
  references?: SplitReferences;
  /** Pièces réunies : chaque groupe de clés de pièces devient la pièce du plus petit numéro. */
  merged?: string[][];
}

export const PART_SEPARATOR = '~';
// Écrits en toutes lettres : metadata.ts lit ce module (section `splits`), qui ne peut donc rien en utiliser au chargement.
export const PART_ORIGIN = 'Pièce / Origine';
export const PART_NUMBER = 'Pièce / Numéro';
export const PART_SEQUENCE = 'Pièce / Séquence';
export const PART_VALID = 'Pièce / Maillage valide';

export const partKey = (key: string, number: number): string => `${key}${PART_SEPARATOR}${number}`;
const partNumber = (key: string): number => Number(key.slice(key.lastIndexOf(PART_SEPARATOR) + 1));

const isVec3 = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string' && item !== '');

/** Plans de coupe au plus par définition (et parts au plus pour `count`) : au-delà, un fichier pourrait figer l'onglet. */
export const MAX_CUTS = 200;
/** Pas le plus petit accepté pour `interval`, en mètres. */
export const MIN_INTERVAL = 0.01;
/** Pièces au plus par découpage (tous éléments compris), et donc par élément : au-delà, les mettre dans le modèle figerait l'onglet. */
export const MAX_PARTS = 500;
const TOO_MANY = `plus de ${MAX_CUTS} coupes`;
const TOO_SMALL = 'pas de moins de 1 cm';

/**
 * Lit la section `splits` ; une entrée illisible est écartée. Une entrée qui demanderait trop de coupes (plus de `MAX_CUTS`,
 * ou un pas sous `MIN_INTERVAL`) est écartée aussi, et dite dans `refusals`.
 */
export function parseSplits(raw: unknown, refusals: string[] = []): SplitDefinition[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): SplitDefinition[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || !strings(item.elements)) return [];
    const definition: SplitDefinition = { id: item.id, elements: [...item.elements] };
    const refuse = (reason: string): [] => {
      refusals.push(`Découpage « ${item.id} » ignoré : ${reason}.`);
      return [];
    };
    if (Array.isArray(item.lines)) {
      if (item.lines.length > MAX_CUTS) return refuse(TOO_MANY);
      const lines = item.lines.filter((line): line is [Vec3, Vec3] => Array.isArray(line) && line.length === 2 && isVec3(line[0]) && isVec3(line[1]) && Math.hypot(line[1][0] - line[0][0], line[1][2] - line[0][2]) > 0);
      if (lines.length === 0 || lines.length !== item.lines.length) return [];
      definition.lines = lines.map(([a, b]) => [[...a], [...b]] as [Vec3, Vec3]);
    } else if (isRecord(item.references)) {
      const r = item.references;
      const references: SplitReferences = {};
      if (strings(r.levels)) {
        if (r.levels.length > MAX_CUTS) return refuse(TOO_MANY);
        references.levels = [...r.levels];
      } else if (r.axis === 'x' || r.axis === 'z') {
        references.axis = r.axis;
        if (Array.isArray(r.positions) && r.positions.length > 0 && r.positions.every((n) => typeof n === 'number' && Number.isFinite(n))) {
          if (r.positions.length > MAX_CUTS) return refuse(TOO_MANY);
          references.positions = [...r.positions];
        } else if (typeof r.interval === 'number' && r.interval > 0) {
          if (!(r.interval >= MIN_INTERVAL)) return refuse(TOO_SMALL);
          references.interval = r.interval;
        } else if (typeof r.count === 'number' && Number.isInteger(r.count) && r.count >= 2) {
          if (r.count > MAX_CUTS) return refuse(TOO_MANY);
          references.count = r.count;
        } else return [];
      } else return [];
      definition.references = references;
    } else return [];
    if (Array.isArray(item.merged)) definition.merged = item.merged.filter((group): group is string[] => strings(group) && group.length >= 2).map((group) => [...group]);
    return [definition];
  });
}

/** Ce que la lecture des sections `splits` a écarté (voir `parseSplits`), en phrases. */
export const splitRefusalsOf = (metadata: Metadata | null, overlays: readonly Metadata[]): string[] => [metadata, ...overlays].flatMap((source) => source?.splitRefusals ?? []);

export const splitsToJson =(definitions: readonly SplitDefinition[]): SplitDefinition[] => structuredClone([...definitions]);

/** Les définitions de la base et des JSON de modifications, dans cet ordre ; une même définition (`id`) n'est gardée qu'une fois, la plus récente. */
export function splitsOf(metadata: Metadata | null, overlays: readonly Metadata[]): SplitDefinition[] {
  const byId = new Map<string, SplitDefinition>();
  for (const source of [metadata, ...overlays]) for (const definition of source?.splits ?? []) byId.set(definition.id, definition);
  return [...byId.values()];
}

/**
 * Les pièces que des plans verticaux ou horizontaux font au plus d'une boîte (repère du viewer) : (1 + plans verticaux qui la
 * traversent + leurs croisements dedans) × (1 + plans horizontaux qui la traversent), 0 si aucun ne la traverse. Exact
 * pour un élément en boîte ; un élément concave peut en donner plus, que `splitSolid` arrête.
 */
export function estimatedParts(planes: readonly CutPlane[], box: { min: number[]; max: number[] }): number {
  const { min, max } = box;
  const value = (p: CutPlane, x: number, y: number, z: number) => p.normal[0] * x + p.normal[1] * y + p.normal[2] * z + p.constant;
  const crosses = (p: CutPlane) => {
    const signs = [0, 1].flatMap((i) => [0, 1].flatMap((j) => [0, 1].map((k) => Math.sign(value(p, i ? max[0] : min[0], j ? max[1] : min[1], k ? max[2] : min[2])))));
    return signs.includes(1) && signs.includes(-1);
  };
  const across = planes.filter(crosses);
  if (across.length === 0) return 0;
  const vertical = across.filter((p) => p.normal[1] === 0), horizontal = across.length - vertical.length;
  let crossings = 0;
  for (let a = 0; a < vertical.length; a++) {
    for (let b = a + 1; b < vertical.length; b++) {
      const [p, q] = [vertical[a], vertical[b]];
      const det = p.normal[0] * q.normal[2] - p.normal[2] * q.normal[0];
      if (Math.abs(det) < 1e-12) continue;
      const x = (p.normal[2] * q.constant - p.constant * q.normal[2]) / det, z = (p.constant * q.normal[0] - p.normal[0] * q.constant) / det;
      if (x > min[0] && x < max[0] && z > min[2] && z < max[2]) crossings++;
    }
  }
  return (1 + vertical.length + crossings) * (1 + horizontal);
}

/**
 * Les plans de coupe d'un élément (repère du viewer) : `box` est sa boîte dans ce repère, `offset` le décalage du modèle.
 * `missing` : les niveaux nommés que le modèle n'a pas. `error` : plus de `MAX_CUTS` plans, refusés avant d'en calculer un,
 * ou plus de `MAX_PARTS` pièces à prévoir.
 */
export function cutPlanes(definition: SplitDefinition, box: { min: number[]; max: number[] }, levels: readonly Level[], offset: readonly number[]): { planes: CutPlane[]; missing: string[]; error?: string; parts: number } {
  const missing: string[] = [];
  const planes: CutPlane[] = [];
  const references = definition.references;
  // Le nombre de plans d'abord : un pas minuscule ou un nombre énorme ne doit jamais faire tourner une boucle.
  const axis = references?.axis === 'x' ? 0 : 2;
  const span = box.max[axis] - box.min[axis];
  const axisCount = !references?.axis ? 0
    : references.positions ? references.positions.length
      : references.interval ? (references.interval > 0 ? Math.floor(span / references.interval) : Infinity)
        : references.count ? references.count - 1 : 0;
  const total = (definition.lines?.length ?? 0) + (references?.levels?.length ?? 0) + axisCount;
  if (!(total <= MAX_CUTS)) return { planes, missing, error: `${TOO_MANY} pour cet élément (au plus ${MAX_CUTS})`, parts: 0 };
  for (const [a, b] of definition.lines ?? []) {
    const [ax, , az] = toViewerPoint(a, offset), [bx, , bz] = toViewerPoint(b, offset);
    planes.push(verticalPlane([ax, az], [bx, bz]));
  }
  for (const name of references?.levels ?? []) {
    const level = levels.find((item) => item.name === name);
    if (level) planes.push({ normal: [0, 1, 0], constant: -(level.elevation - offset[1]) });
    else missing.push(name);
  }
  if (references?.axis) {
    const normal: [number, number, number] = axis === 0 ? [1, 0, 0] : [0, 0, 1];
    const min = box.min[axis], max = box.max[axis];
    let at: number[] = [];
    if (references.positions) at = references.positions.map((position) => position - offset[axis]);
    else if (references.interval) for (let k = 1; min + k * references.interval < max - 1e-6; k++) at.push(min + k * references.interval);
    else if (references.count) for (let k = 1; k < references.count; k++) at.push(min + (k * (max - min)) / references.count);
    for (const value of at) planes.push({ normal, constant: -value });
  }
  const parts = estimatedParts(planes, box);
  if (parts > MAX_PARTS) return { planes: [], missing, error: `plus de ${MAX_PARTS} pièces pour cet élément`, parts };
  return { planes, missing, parts };
}

/**
 * Pourquoi un trait libre (borné à ses deux points `from` et `to`, x et z du viewer) serait refusé sur ces éléments, ou null :
 * il doit en traverser au moins un, et de part en part chaque élément qu'il touche. Sans calculer la section : les points où
 * les arêtes des triangles passent par son plan vertical disent où elle est (`splitByPlane` refuse de même une coupe
 * partielle). Assez rapide pour suivre le curseur.
 */
export function freeLineProblem(elements: readonly { label: string; parts: readonly MeshPart[] }[], from: readonly [number, number], to: readonly [number, number]): string | null {
  const dx = to[0] - from[0], dz = to[1] - from[1], length = Math.hypot(dx, dz);
  if (length === 0) return null;
  const nx = -dz / length, nz = dx / length, margin = 1e-3;
  let crossed = false;
  for (const { label, parts } of elements) {
    let within = 0, outside = 0;
    for (const { positions: p, index, start, count } of parts) {
      for (let k = start; k + 2 < start + count; k += 3) {
        for (let j = 0; j < 3; j++) {
          const a = index[k + j] * 3, b = index[k + (j + 1) % 3] * 3;
          const da = nx * (p[a] - from[0]) + nz * (p[a + 2] - from[1]), db = nx * (p[b] - from[0]) + nz * (p[b + 2] - from[1]);
          if (da * db > 0) continue;
          const s = da === db ? 0 : da / (da - db);
          const along = ((p[a] + s * (p[b] - p[a]) - from[0]) * dx + (p[a + 2] + s * (p[b + 2] - p[a + 2]) - from[1]) * dz) / length;
          if (along >= -margin && along <= length + margin) within++;
          else outside++;
        }
      }
    }
    if (within > 0 && outside > 0) return `coupe partielle de « ${label} » : le trait doit le traverser de part en part`;
    if (within > 0) crossed = true;
  }
  return crossed ? null : 'le trait ne traverse aucun élément choisi';
}

const QUANTITY_PRESETS = [groupPreset as QuantityPreset, ifcPreset as QuantityPreset];

/** Ce qu'une pièce reprend de son original : ses propriétés et son nom affiché. */
export type OriginalOf = (original: number) => { props: FlatProps | undefined; label: string };

/**
 * Les propriétés d'une pièce : celles de l'original, ses propres quantités (le groupe « Quantités calculées », et chaque
 * quantité de base que l'original porte, recalculée pour la pièce), et `Pièce / …`. La séquence vaut d'abord le numéro.
 */
export function partProperties(original: FlatProps | undefined, origin: string, number: number, part: SplitPart): FlatProps {
  const props: FlatProps = { ...original };
  const set = (path: string, value: string | number | boolean) => Object.defineProperty(props, path, { value, enumerable: true, configurable: true, writable: true });
  const quantities = elementQuantities([{ positions: part.solid.positions, index: part.solid.triangles, start: 0, count: part.solid.triangles.length }]);
  if (quantities) {
    quantities.exact &&= part.valid;
    QUANTITY_PRESETS.forEach((preset, i) => {
      for (const [path, quantity] of targetsFor(preset, original)) {
        if (i === 0 || ownValue(original, path) !== undefined) set(path, Math.round(quantities[quantity] * 1e6) / 1e6);
      }
    });
    set(QUANTITY_PRESETS[0].reliability, reliabilityOf(quantities));
  }
  set(PART_ORIGIN, origin);
  set(PART_NUMBER, number);
  set(PART_SEQUENCE, number);
  set(PART_VALID, part.valid);
  return props;
}

/** Ce que `SplitSet` a changé dans la fin du modèle : le passage des anciens numéros d'élément aux nouveaux, et l'inverse. */
export interface TailChange {
  /** Ancien numéro → nouveau, −1 pour une pièce disparue. */
  next: Int32Array;
  /** Nouveau numéro → ancien, −1 pour une pièce nouvelle. */
  previous: Int32Array;
}

export interface SplitOutcome {
  splits: ElementSplit[];
  refused: SplitRefusal[];
  missingLevels: string[];
}

/**
 * Les découpages d'un modèle et leurs pièces, toujours à la fin de la liste des éléments, définition après définition (et
 * dans leurs propres lots) : retirer ou changer une définition retire la fin du modèle à partir de ses pièces et y remet les
 * suivantes, recalculées depuis le cache, sans toucher aux éléments du fichier.
 */
export class SplitSet {
  readonly model: Model;
  definitions: SplitDefinition[] = [];
  private readonly results = new Map<string, ElementSplit[]>();
  /** Premier élément et premier lot des pièces de chaque définition, dans l'ordre des définitions. */
  private readonly spans: { element: number; chunk: number }[] = [];
  private readonly builder: ModelBuilder;

  constructor(model: Model, selectColor: IUniform<Color>) {
    this.model = model;
    this.builder = new ModelBuilder(selectColor, model);
  }

  get hasParts(): boolean {
    return this.model.parents.some((parent) => parent >= 0);
  }

  /** La définition qui découpe cet élément d'origine. */
  definitionOf(element: number): SplitDefinition | undefined {
    const key = this.model.keys[element];
    return this.definitions.find((definition) => definition.elements.includes(key));
  }

  /**
   * Calcule les pièces d'une définition, par tranches (avancement de 0 à 1). Un élément absent du modèle, ou dont le fichier
   * contient déjà les pièces (un GLB exporté avec elles), n'est pas découpé ; seul le premier est signalé (`refused`, −1).
   */
  *compute(definition: SplitDefinition, levels: readonly Level[]): Generator<number, SplitOutcome, unknown> {
    const model = this.model;
    const index = new Map<string, number>(), twice = new Set<string>();
    model.keys.forEach((key, i) => {
      if (index.has(key)) twice.add(key);
      else index.set(key, i);
    });
    // Pièces que le fichier contient déjà (un GLB exporté avec elles), et pièces de cette session ; celles de la définition
    // elle-même (même `id`, qu'on modifie) seront remplacées par `put`.
    const baked = new Set<string>(), split = new Set<string>();
    const own = new Set(this.definitions.find((item) => item.id === definition.id)?.elements);
    model.keys.forEach((key, i) => {
      const original = key.slice(0, key.lastIndexOf(PART_SEPARATOR));
      if (key.includes(PART_SEPARATOR) && !(model.parents[i] >= 0 && own.has(original))) (model.parents[i] >= 0 ? split : baked).add(original);
    });
    const outcome: SplitOutcome = { splits: [], refused: [], missingLevels: [] };
    const elements: number[] = [];
    for (const key of definition.elements) {
      const element = index.get(key);
      if (baked.has(key)) continue;
      // Deux éléments sous la même clé (nœuds glTF sans identifiant, de même nom) : leurs pièces ne seraient pas distinctes.
      if (twice.has(key)) outcome.refused.push({ element: element!, reason: `identifiant en double « ${key} » : plusieurs éléments le portent` });
      else if (element === undefined) outcome.refused.push({ element: -1, reason: `élément d’origine « ${key} » introuvable dans ce modèle` });
      else if (model.parents[element] >= 0) outcome.refused.push({ element, reason: 'c’est déjà une pièce : retirez le découpage de son original pour le refaire' });
      else if (split.has(key)) outcome.refused.push({ element, reason: 'déjà découpé : retirez d’abord son découpage' });
      else elements.push(element);
    }
    const offset = model.offset.toArray();
    const box = { min: [0, 0, 0], max: [0, 0, 0] };
    const missing = new Set<string>();
    // Les pièces prévues de la définition : passé `MAX_PARTS`, les éléments suivants sont refusés sans calcul.
    let estimated = 0;
    yield* splitJob(model, elements, (element) => {
      if (estimated > MAX_PARTS) return `plus de ${MAX_PARTS} pièces pour ce découpage`;
      const at = element * 6;
      box.min = [model.boxes[at], model.boxes[at + 1], model.boxes[at + 2]];
      box.max = [model.boxes[at + 3], model.boxes[at + 4], model.boxes[at + 5]];
      const { planes, missing: absent, error, parts } = cutPlanes(definition, box, levels, offset);
      for (const name of absent) missing.add(name);
      estimated += parts;
      return error ?? (estimated > MAX_PARTS ? `plus de ${MAX_PARTS} pièces pour ce découpage` : planes);
    }, outcome, undefined, MAX_PARTS);
    outcome.missingLevels = [...missing];
    return outcome;
  }

  /**
   * Ajoute une définition calculée (ses pièces vont à la fin), ou remplace celle de même `id` (ses pièces, et celles des
   * définitions suivantes, sont refaites ; `splits` null : les pièces déjà calculées, pour une fusion). Les pièces `renew`
   * (une fusion change leur forme) repartent des propriétés de l'original, comme des pièces nouvelles. `source(original)` : ce que ses pièces reprennent de l'original.
   */
  put(definition: SplitDefinition, splits: ElementSplit[] | null, source: OriginalOf, renew: readonly string[] = []): TailChange {
    let at = this.definitions.findIndex((item) => item.id === definition.id);
    if (at < 0) at = this.definitions.push(definition) - 1;
    else this.definitions[at] = definition;
    if (splits) this.results.set(definition.id, splits);
    return this.rebuild(at, source, renew);
  }

  /** Où commencent les pièces : premier élément et premier lot de la fin du modèle (la fin elle-même s'il n'y en a pas). */
  get tailStart(): { element: number; chunk: number } {
    return this.spans[0] ?? { element: this.model.count, chunk: this.model.chunks.length };
  }

  /**
   * Retire toutes les pièces, laisse `edit` changer la fin des éléments du fichier (ajouter ou retirer une maquette, voir
   * data/federation.ts), puis remet les pièces. `edit` rend où ces éléments ont changé (`cut`) et combien il en a ajouté
   * (`inserted`, à partir de `cut`) : les éléments d'avant `cut` gardent leur numéro, ceux qu'il a retirés disparaissent.
   */
  reshape(edit: () => { cut: number; inserted: number }, source: OriginalOf): TailChange {
    return this.rebuild(0, source, [], edit);
  }

  /** Retire une définition : ses pièces disparaissent, ses originaux reviennent. */
  remove(id: string, source: OriginalOf): TailChange | null {
    const at = this.definitions.findIndex((item) => item.id === id);
    if (at < 0) return null;
    this.definitions.splice(at, 1);
    this.results.delete(id);
    return this.rebuild(at, source);
  }

  /**
   * Réunit deux pièces voisines d'un même original (elles ne diffèrent que d'un côté d'un plan) : rend la nouvelle définition
   * et les pièces à renouveler, à passer à `put`, ou la raison d'un refus.
   */
  mergeDefinition(a: number, b: number): { definition: SplitDefinition; renew: string[] } | string {
    const model = this.model;
    const parent = model.parents[a];
    if (parent < 0 || model.parents[b] !== parent || a === b) return 'choisissez deux pièces d’un même élément d’origine';
    const definition = this.definitionOf(parent);
    const split = definition && this.results.get(definition.id)?.find((item) => item.element === parent);
    if (!definition || !split) return 'découpage introuvable';
    const key = model.keys[parent];
    const mine = (group: string[]) => group.every((member) => member.startsWith(key + PART_SEPARATOR));
    const groups = (definition.merged ?? []).filter(mine).map((group) => group.map(partNumber));
    const groupOf = (number: number) => groups.find((group) => group.includes(number)) ?? [number];
    const ga = groupOf(partNumber(model.keys[a])), gb = groupOf(partNumber(model.keys[b]));
    const adjacent = ga.some((x) => gb.some((y) => {
      const sx = split.parts[x - 1]?.sides, sy = split.parts[y - 1]?.sides;
      return sx && sy && sx.filter((side, k) => side !== sy[k]).length === 1;
    }));
    if (!adjacent) return 'ces pièces ne se touchent pas par une coupe';
    const joined = [...ga, ...gb].sort((x, y) => x - y).map((n) => partKey(key, n));
    const kept = groups.filter((group) => group !== ga && group !== gb).map((group) => group.map((n) => partKey(key, n)));
    const others = (definition.merged ?? []).filter((group) => !mine(group));
    return { definition: { ...definition, merged: [...others, ...kept, joined] }, renew: joined };
  }

  /** Les pièces d'une définition, fusions faites, prêtes pour le modèle. */
  private partsOf(definition: SplitDefinition, source: OriginalOf): (PartGeometry & { parent: number; props: FlatProps })[] {
    const model = this.model;
    const out: (PartGeometry & { parent: number; props: FlatProps })[] = [];
    for (const split of this.results.get(definition.id) ?? []) {
      const key = model.keys[split.element];
      const groups = (definition.merged ?? []).filter((group) => group.every((member) => member.startsWith(key + PART_SEPARATOR))).map((group) => group.map(partNumber));
      const { props: original, label } = source(split.element);
      split.parts.forEach((part, i) => {
        const number = i + 1;
        const group = groups.find((members) => members.includes(number));
        if (group && Math.min(...group) !== number) return; // réunie dans la pièce du plus petit numéro
        const members = group ? group.map((n) => split.parts[n - 1]).filter(Boolean) : [part];
        const merged: SplitPart = members.length === 1 ? part
          : { solid: mergeSolids(members.map((member) => member.solid)), valid: members.every((member) => member.valid), volume: members.reduce((sum, member) => sum + member.volume, 0), sides: part.sides };
        out.push({
          key: partKey(key, number), name: `${label} · pièce ${number}`, solid: merged.solid, materials: split.materials, parent: split.element,
          props: partProperties(original, `${label} (${key})`, number, merged),
        });
      });
    }
    return out;
  }

  /**
   * Refait la fin du modèle à partir des pièces de la définition `from` : retire ces pièces et les suivantes, puis y remet
   * celles de chaque définition depuis `from`. Les propriétés des pièces sont posées dans `extras` (comme celles d'un nœud
   * glTF) : `buildStore` ou `applyTailChange` les lisent.
   */
  private rebuild(from: number, source: OriginalOf, renew: readonly string[] = [], edit?: () => { cut: number; inserted: number }): TailChange {
    const model = this.model;
    const oldCount = model.count;
    const start = this.spans[from]?.element ?? model.count;
    const oldKeys = model.keys.slice(start);
    const visible = oldKeys.map((_, i) => model.state.isVisible(start + i));
    for (const parent of new Set(model.parents.slice(start))) model.state.setReplaced(parent, false);
    model.truncate(start, this.spans[from]?.chunk ?? model.chunks.length);
    this.spans.length = Math.min(this.spans.length, from);
    // Une maquette ajoutée ou retirée (voir `reshape`) : les éléments du fichier changent entre les deux. Si elle échoue,
    // ce qu'elle a commencé d'ajouter est retiré et les pièces sont remises comme avant, puis l'erreur suit son cours.
    const chunkStart = model.chunks.length;
    let failure: { error: unknown } | null = null;
    let edited = { cut: start, inserted: 0 };
    try {
      if (edit) edited = edit();
    } catch (error) {
      model.truncate(start, chunkStart, true);
      failure = { error };
    }
    const { cut, inserted } = edited;
    for (let d = from; d < this.definitions.length; d++) {
      this.spans.push({ element: model.count, chunk: model.chunks.length });
      const parts = this.partsOf(this.definitions[d], source);
      if (parts.length === 0) continue;
      const first = model.count;
      this.builder.append(partsToRaw(parts, model.offset.toArray()));
      parts.forEach((part, i) => {
        model.parents[first + i] = part.parent;
        model.extras[first + i] = unflattenProperties(part.props);
      });
    }
    // Toujours recalculé sur toute la fin : un original peut avoir des pièces dans une définition antérieure à `from`.
    for (let i = 0; i < model.count; i++) if (model.parents[i] >= 0) model.state.setReplaced(model.parents[i], true);
    const previousKey = new Map(oldKeys.map((key, i) => [key, start + i]));
    for (const key of renew) previousKey.delete(key);
    const next = new Int32Array(oldCount).fill(-1);
    const previous = new Int32Array(model.count).fill(-1);
    for (let i = 0; i < model.count; i++) {
      const old = i < cut ? i : i < cut + inserted ? -1 : previousKey.get(model.keys[i]) ?? -1;
      previous[i] = old;
      if (old >= 0) next[old] = i;
    }
    // Une pièce qui reste garde sa visibilité ; une nouvelle est visible.
    for (let i = cut + inserted; i < model.count; i++) if (previous[i] >= 0) model.state.setVisible(i, visible[previous[i] - start]);
    model.state.commit();
    if (failure) throw failure.error;
    return { next, previous };
  }
}

/** Ce qu'un découpage n'a pas pu faire, en phrases : éléments refusés (et pourquoi), niveaux introuvables. */
export function describeOutcome(outcome: SplitOutcome, label: (element: number) => string): string[] {
  // Une même raison pour plusieurs éléments est dite une fois.
  const byReason = new Map<string, number[]>();
  for (const { element, reason } of outcome.refused) byReason.set(reason, [...byReason.get(reason) ?? [], element]);
  const notes = [...byReason].map(([reason, elements]) => {
    const named = elements.filter((element) => element >= 0);
    if (named.length < 2) return named.length === 0 ? `Non découpé : ${reason}.` : `« ${label(named[0])} » non découpé : ${reason}.`;
    const names = named.slice(0, 3).map((element) => `« ${label(element)} »`).join(', ');
    return `${named.length} éléments non découpés (${names}${named.length > 3 ? '…' : ''}) : ${reason}.`;
  });
  if (outcome.missingLevels.length > 0) notes.push(`Niveau${outcome.missingLevels.length > 1 ? 'x' : ''} introuvable${outcome.missingLevels.length > 1 ? 's' : ''} : ${outcome.missingLevels.join(', ')}.`);
  return notes;
}

/**
 * À l'ouverture d'un modèle, avant ses propriétés : les pièces de chaque définition, posées dans `Model.extras` d'après les
 * propriétés d'ouverture de l'original (`buildStore` les lira comme celles de tout élément, puis les JSON de modifications
 * s'appliquent aux pièces comme aux autres). Rend ce qu'il faut dire à l'utilisateur. Sur un modèle déjà ouvert (un JSON
 * déposé), `apply` donne ce que les pièces reprennent (`source`) et reçoit chaque changement de numéros (`onChange`) ; une
 * définition déjà en place n'est pas refaite.
 */
export async function loadSplits(
  set: SplitSet, definitions: readonly SplitDefinition[], metadata: Metadata | null, levels: readonly Level[], onProgress?: (progress: number) => void,
  apply?: { source: OriginalOf; onChange: (change: TailChange) => void },
): Promise<string[]> {
  const model = set.model;
  const source: OriginalOf = apply?.source ?? ((i) => ({ props: openingProps(model.keys[i], model.extras[i], metadata), label: metadata?.elements.get(model.keys[i])?.label || model.names[i] }));
  const notes: string[] = [];
  for (const [d, definition] of definitions.entries()) {
    if (set.definitions.some((item) => item.id === definition.id)) {
      notes.push(`Découpage « ${definition.id} » déjà en place : non repris.`);
      continue;
    }
    const outcome = await runSliced(set.compute(definition, levels), (progress) => onProgress?.((d + progress) / definitions.length));
    const change = set.put(definition, outcome.splits, source);
    apply?.onChange(change);
    notes.push(...describeOutcome(outcome, (i) => source(i).label));
  }
  return notes;
}

/**
 * Reporte un changement de la fin du modèle sur ses propriétés : les pièces restantes gardent les leurs (modifications
 * comprises), les nouvelles prennent celles que `SplitSet` a posées, complétées par le fichier de métadonnées ouvert s'il
 * décrit déjà cette pièce ; l'historique des modifications suit les numéros.
 */
export function applyTailChange(change: TailChange, model: Model, store: PropertyStore, edits: PropertyEdits | null, metadata: Metadata | null): void {
  store.reindex(change.previous);
  for (let i = 0; i < model.count; i++) {
    if (change.previous[i] >= 0) continue;
    const props = openingProps(model.keys[i], model.extras[i], metadata);
    if (props) store.set(i, props, metadata?.elements.get(model.keys[i])?.label);
  }
  store.finalize();
  edits?.reindex(change.next);
}
