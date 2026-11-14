// Les conflits (clash) comme données : les tests (deux ensembles d'éléments, une tolérance, des exclusions), les conflits
// trouvés avec leur statut et leur commentaire, gardés d'un calcul à l'autre en les appariant par leurs deux clés, et les
// sections facultatives `clashTests` et `clashes` du contrat (voir docs/contrat-metadonnees.md). La détection elle-même est
// dans engine/clash.ts. Coordonnées : celles du repère du modèle (mètres, Y vers le haut), comme les vues.

import type { RuleCondition, RuleOp } from './conditions.ts';
import { isRecord } from './json.ts';
import type { Vec3 } from './modelFrame.ts';

export type ClashStatus = 'new' | 'active' | 'resolved' | 'ignored';
export const CLASH_STATUSES: readonly ClashStatus[] = ['new', 'active', 'resolved', 'ignored'];
export const STATUS_LABELS: Readonly<Record<ClashStatus, string>> = { new: 'Nouveau', active: 'Actif', resolved: 'Résolu', ignored: 'Ignoré' };

/** Un élément désigné hors de la session : sa clé dans son fichier, et le nom de ce fichier (sa maquette). */
export interface ElementRef {
  key: string;
  model?: string;
}

export interface ClashRecord {
  /** L'identifiant du test qui l'a trouvé. */
  test?: string;
  a: ElementRef;
  b: ElementRef;
  status: ClashStatus;
  comment: string;
  /** Profondeur de pénétration approchée, en mètres. */
  depth: number;
  /** Centre de la zone de recouvrement, repère du modèle. */
  point: Vec3;
}

/** Un ensemble d'éléments : une maquette (son nom ; absente : toutes) et des conditions (toutes vraies). */
export interface ClashSet {
  model?: string;
  conditions: RuleCondition[];
}

export interface ClashTest {
  id: string;
  name: string;
  a: ClashSet;
  b: ClashSet;
  /** Seuls les conflits francs (pénétration au-delà de la tolérance) sont cherchés pour l'instant. */
  type: 'hard';
  /** Mètres (0,01 par défaut). */
  tolerance: number;
  /** Les éléments qui répondent à ces conditions ne sont dans aucun ensemble. */
  exclude: RuleCondition[];
  /** Ignorer les paires d'une même maquette qui ont la même valeur de cette propriété (un même hôte, un même assemblage). */
  sameValue?: string;
}

/** Une paire, quel que soit son ordre. */
export function pairKey(a: ElementRef, b: ElementRef): string {
  const one = `${a.model ?? ''}\u0000${a.key}`, two = `${b.model ?? ''}\u0000${b.key}`;
  return one < two ? `${one}\u0001${two}` : `${two}\u0001${one}`;
}

/**
 * Les conflits d'un nouveau calcul, rapprochés des précédents par leurs deux clés : un conflit retrouvé garde son statut
 * (`ignored` reste ignoré, le reste devient `active`) et son commentaire ; un nouveau est `new` ; un ancien qui n'est plus
 * trouvé alors que le calcul le couvrait (`inScope`) devient `resolved`, les autres restent tels quels.
 */
export function mergeClashes(previous: readonly ClashRecord[], found: readonly ClashRecord[], inScope: (record: ClashRecord) => boolean): ClashRecord[] {
  const before = new Map(previous.map((record) => [pairKey(record.a, record.b), record]));
  const out: ClashRecord[] = [];
  const seen = new Set<string>();
  for (const record of found) {
    const key = pairKey(record.a, record.b);
    if (seen.has(key)) continue;
    seen.add(key);
    const old = before.get(key);
    out.push(old ? { ...old, test: record.test ?? old.test, depth: record.depth, point: record.point, status: old.status === 'ignored' ? 'ignored' : 'active' } : { ...record, status: 'new' });
  }
  for (const record of previous) {
    if (seen.has(pairKey(record.a, record.b))) continue;
    out.push(inScope(record) && record.status !== 'resolved' ? { ...record, status: 'resolved' } : record);
  }
  return out;
}

// --------------------------------------------------------------------- conditions en texte

const OPS: [string, RuleOp][] = [['!=', 'not_equals'], ['≠', 'not_equals'], ['~', 'contains'], ['=', 'equals']];

/** « Propriété = valeur ; Propriété != valeur ; Propriété ~ texte » → conditions (toutes vraies). Une ligne vide : aucune. */
export function parseConditions(text: string): RuleCondition[] {
  return text.split(/[;\n]/).map((part) => part.trim()).filter(Boolean).map((part) => {
    for (const [symbol, op] of OPS) {
      const at = part.indexOf(symbol);
      if (at > 0) return { property: part.slice(0, at).trim(), op, value: part.slice(at + symbol.length).trim() };
    }
    return { property: part, op: 'present' as const };
  });
}

export function conditionsText(conditions: readonly RuleCondition[]): string {
  return conditions.map((condition) => {
    if (condition.op === 'present') return condition.property;
    const symbol = OPS.find(([, op]) => op === condition.op)?.[0] ?? '=';
    return `${condition.property} ${symbol} ${String(condition.value ?? '')}`;
  }).join(' ; ');
}

// --------------------------------------------------------------------- sections du contrat

const isVec3 = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
const refOf = (value: unknown): ElementRef | null => {
  if (!isRecord(value) || typeof value.key !== 'string' || !value.key) return null;
  return typeof value.model === 'string' ? { key: value.key, model: value.model } : { key: value.key };
};
const conditionsOf = (value: unknown): RuleCondition[] => (Array.isArray(value) ? value.filter((item): item is RuleCondition => isRecord(item) && typeof item.property === 'string' && typeof item.op === 'string') : []);
const setOf = (value: unknown): ClashSet => {
  const set: ClashSet = { conditions: conditionsOf(isRecord(value) ? value.conditions : undefined) };
  if (isRecord(value) && typeof value.model === 'string') set.model = value.model;
  return set;
};

/** Lit la section `clashTests` ; une entrée illisible est écartée. */
export function parseClashTests(raw: unknown): ClashTest[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): ClashTest[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id) return [];
    const tolerance = typeof item.tolerance === 'number' && Number.isFinite(item.tolerance) && item.tolerance >= 0 ? item.tolerance : null;
    if (tolerance === null) return [];
    const test: ClashTest = { id: item.id, name: typeof item.name === 'string' ? item.name : item.id, a: setOf(item.a), b: setOf(item.b), type: 'hard', tolerance, exclude: conditionsOf(item.exclude) };
    if (typeof item.sameValue === 'string' && item.sameValue) test.sameValue = item.sameValue;
    return [test];
  });
}

/** Lit la section `clashes` ; une entrée illisible est écartée. */
export function parseClashes(raw: unknown): ClashRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): ClashRecord[] => {
    if (!isRecord(item)) return [];
    const a = refOf(item.a), b = refOf(item.b);
    if (!a || !b || !isVec3(item.point) || typeof item.depth !== 'number' || !CLASH_STATUSES.includes(item.status as ClashStatus)) return [];
    const record: ClashRecord = { a, b, status: item.status as ClashStatus, comment: typeof item.comment === 'string' ? item.comment : '', depth: item.depth, point: [...item.point] };
    if (typeof item.test === 'string') record.test = item.test;
    return [record];
  });
}

/** Les deux sections, prêtes pour un JSON du contrat (seulement celles qui ont des entrées). */
export function clashesToJson(tests: readonly ClashTest[], records: readonly ClashRecord[]): { clashTests?: ClashTest[]; clashes?: ClashRecord[] } {
  return { ...(tests.length > 0 ? { clashTests: structuredClone([...tests]) } : {}), ...(records.length > 0 ? { clashes: structuredClone([...records]) } : {}) };
}

/**
 * Ce qu'un sujet BCF demande pour un conflit (l'écriture du fichier BCF viendra avec le chantier des exports) : titre,
 * description, statut, commentaire, les clés des deux éléments (GlobalId pour un IFC), le point à viser (repère du modèle).
 */
export function clashTopic(record: ClashRecord, label: (ref: ElementRef) => string = (ref) => ref.key) {
  return {
    title: `${label(record.a)} × ${label(record.b)}`,
    description: `Conflit franc, pénétration ≈ ${(record.depth * 1000).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} mm.`,
    status: record.status,
    comment: record.comment,
    components: [record.a.key, record.b.key],
    point: [...record.point] as Vec3,
  };
}
