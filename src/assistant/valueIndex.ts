// Index du modèle chargé pour les commandes sans modèle de langage (intent.ts) : chaque valeur
// distincte de chaque propriété, avec son nombre d'éléments, et les noms des propriétés, réduits
// à des mots comparables (sans accents ni casse, singulier ou pluriel). Aucun vocabulaire BIM :
// « les murs » ne trouve « Catégorie = Murs » que parce que cette valeur existe dans le modèle.

import { ELEMENT_NAME } from '../data/elementFields.ts';
import { matchesCondition, valueAt, type ElementIdentity, type RuleCondition } from '../data/conditions.ts';
import { PATH_SEP, formatValue, type PropValue, type PropertyStore } from '../data/metadata.ts';
import { fold } from '../data/text.ts';

/** Mots sans contenu (articles, prépositions, « éléments »…), ignorés dans une cible. */
export const FILLERS = new Set([
  'le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'de', 'd', 'au', 'aux', 'en', 'sur', 'dans', 'pour', 'avec', 'que', 'qui',
  'tout', 'tous', 'toute', 'toutes', 'element', 'elements', 'objet', 'objets', 'item', 'items', 'ceux', 'celles', 'ce', 'ces', 'cet', 'cette',
  'the', 'of', 'on', 'in', 'at', 'to', 'all', 'every', 'object', 'objects', 'any', 'svp', 'stp', 'please',
]);

/** Au-delà, une propriété ressemble à un identifiant : ses valeurs ne sont pas indexées. */
const MAX_DISTINCT = 500;
/** Une valeur plus longue ne se dicte pas : elle n'est pas indexée. */
const MAX_WORDS = 6;

/**
 * Mots d'un texte, tels qu'on les compare : sans accents ni casse, apostrophes et tirets comme des
 * espaces, « R plus 2 » et « R + 2 » comme « R+2 », « 0.25 » comme « 0,25 ». « à » seul n'est pas la lettre A.
 */
export function words(text: string): string[] {
  const folded = fold(` ${String(text).toLocaleLowerCase('fr').replace(/(^|\s)à(?=\s|$)/g, '$1au')} `)
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae')
    .replace(/[’'`´]/g, ' ')
    .replace(/\b([a-z]{1,2})\s+plus\s+(\d+)\b/g, '$1+$2')
    .replace(/\b([a-z]{1,2})\s+moins\s+(\d+)\b/g, '$1 $2')
    .replace(/\s*\+\s*/g, '+')
    .replace(/(\d)\.(\d)/g, '$1,$2');
  return folded.match(/[a-z0-9]+(?:[+.,][a-z0-9]+)*/g) ?? [];
}

/** Forme comparable d'un mot : singulier (« murs », « poteaux », « métaux »/« métal »), chiffres et mots courts intacts. */
export function stem(word: string): string {
  if (word.length <= 3 || /\d/.test(word)) return word;
  let out = word;
  if (out.length > 4 && out.endsWith('ies')) out = `${out.slice(0, -3)}y`;
  else if (out.endsWith('s') || out.endsWith('x')) out = out.slice(0, -1);
  return out.endsWith('al') ? `${out.slice(0, -2)}au` : out;
}

/** Mots d'un texte qui portent du sens, sous leur forme comparable. */
export const contentStems = (text: string): string[] => words(text).filter((word) => !FILLERS.has(word)).map(stem);

export interface ValueEntry {
  path: string;
  /** Valeur telle que l'arborescence l'affiche (« Oui », « 0,25 »). */
  label: string;
  /** Valeur d'origine, pour un filtre exact (un booléen reste un booléen). */
  value: PropValue;
  count: number;
}

export class ValueIndex {
  readonly store: PropertyStore;
  readonly count: number;
  readonly keys: readonly string[];
  private readonly identity: ElementIdentity;
  /** Valeurs par suite de mots comparables (« niveau 1 »). */
  private readonly values = new Map<string, ValueEntry[]>();
  /** Valeurs d'un seul mot par ce mot (« 1f »), pour « 1 F » dicté en deux mots. */
  private readonly joined = new Map<string, ValueEntry[]>();
  /** Propriétés par toute suite contiguë de mots de leur nom (« etage » pour « Code étage »). */
  private readonly names = new Map<string, Set<string>>();
  /** Mots du nom de chaque propriété : dernier segment, puis nom complet. */
  readonly nameStems = new Map<string, string[][]>();
  /** Propriétés dont toutes les valeurs sont des booléens. */
  readonly booleans = new Set<string>();

  constructor(store: PropertyStore, count: number, keys: readonly string[], labelOf: (index: number) => string) {
    this.store = store;
    this.count = count;
    this.keys = keys;
    this.identity = { keys, label: labelOf };
    // Un passage sur les éléments : valeurs distinctes par propriété, arrêt au-delà de MAX_DISTINCT.
    const distinct = new Map<string, Map<PropValue, number>>();
    const wide = new Set<string>();
    const add = (path: string, value: PropValue) => {
      if (wide.has(path)) return;
      let seen = distinct.get(path);
      if (!seen) distinct.set(path, (seen = new Map()));
      seen.set(value, (seen.get(value) ?? 0) + 1);
      if (seen.size > MAX_DISTINCT) { wide.add(path); distinct.delete(path); }
    };
    for (let i = 0; i < count; i++) {
      const props = store.propsOf(i);
      if (props) for (const path in props) {
        const value = props[path];
        if (value !== null && value !== '' && Object.hasOwn(props, path)) add(path, value);
      }
      const label = labelOf(i);
      if (label) add(ELEMENT_NAME, label);
    }
    for (const [path, seen] of distinct) {
      if ([...seen.keys()].every((value) => typeof value === 'boolean')) this.booleans.add(path);
      for (const [value, n] of seen) {
        const label = formatValue(value);
        const list = words(label).filter((word) => !FILLERS.has(word));
        if (list.length === 0 || list.length > MAX_WORDS) continue;
        const entry: ValueEntry = { path, label, value, count: n };
        push(this.values, list.map(stem).join(' '), entry);
        if (list.length === 1) push(this.joined, list[0], entry);
      }
    }
    for (const path of store.paths) {
      const tail = path.slice(path.lastIndexOf(PATH_SEP) + (path.includes(PATH_SEP) ? PATH_SEP.length : 0));
      const forms = [contentStems(tail), contentStems(path)].filter((list, i, all) => list.length > 0 && (i === 0 || list.join(' ') !== all[0].join(' ')));
      this.nameStems.set(path, forms);
      for (const list of forms) {
        for (let a = 0; a < list.length; a++) for (let b = a + 1; b <= list.length; b++) {
          const key = list.slice(a, b).join(' ');
          const set = this.names.get(key) ?? new Set<string>();
          set.add(path);
          this.names.set(key, set);
        }
      }
    }
  }

  /** Valeurs dont les mots sont exactement ces mots (forme comparable), ou, pour plusieurs mots dictés séparément, leur assemblage. */
  valuesFor(span: readonly string[]): ValueEntry[] {
    const found = this.values.get(span.map(stem).join(' ')) ?? [];
    return span.length > 1 ? [...found, ...(this.joined.get(span.join('')) ?? [])] : found;
  }

  /** Propriétés dont le nom contient cette suite de mots. */
  propertiesFor(span: readonly string[]): string[] {
    return [...(this.names.get(span.map(stem).join(' ')) ?? [])];
  }

  /** Propriétés que ce texte nomme : nom exact, puis dernier segment, puis mêmes mots, puis une partie du nom. */
  propertiesNamed(text: string): string[] {
    const wanted = fold(text).replace(/\s+/g, ' ');
    const paths = this.store.paths;
    const exact = paths.filter((path) => fold(path) === wanted);
    if (exact.length > 0) return exact;
    const tail = paths.filter((path) => fold(path.slice(path.lastIndexOf(PATH_SEP) + (path.includes(PATH_SEP) ? PATH_SEP.length : 0))) === wanted);
    if (tail.length > 0) return tail;
    const stems = contentStems(text);
    if (stems.length === 0) return [];
    const key = stems.join(' ');
    const same = paths.filter((path) => (this.nameStems.get(path) ?? []).some((list) => list.join(' ') === key));
    return same.length > 0 ? same : this.propertiesFor(stems);
  }

  /** Éléments qui vérifient toutes les conditions, dans le périmètre donné. */
  matching(conditions: readonly RuleCondition[], within?: Iterable<number>): number[] {
    const out: number[] = [];
    const test = (i: number) => conditions.every((condition) => matchesCondition(valueAt(this.store, this.identity, i, condition.property), condition));
    if (within) { for (const i of within) if (test(i)) out.push(i); }
    else for (let i = 0; i < this.count; i++) if (test(i)) out.push(i);
    return out;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
