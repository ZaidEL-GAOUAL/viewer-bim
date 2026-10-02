// Lecture du fichier de métadonnées (voir docs/contrat-metadonnees.md) et index des propriétés.
// Rien ici ne suppose un nom de propriété : tout est découvert dans le fichier.

export type PropValue = string | number | boolean | null;
export type FlatProps = Record<string, PropValue>;

export interface MetadataEntry {
  label: string | undefined;
  props: FlatProps;
}

export interface Metadata {
  version: number;
  elements: Map<string, MetadataEntry>;
}

export const SUPPORTED_VERSION = 1;
export const PATH_SEP = ' / ';
export const UNDEFINED_LABEL = '(non défini)';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Aplatit des propriétés imbriquées : { A: { B: 1 } } devient { "A / B": 1 }. */
export function flattenProperties(input: Record<string, unknown>, prefix = '', out: FlatProps = {}): FlatProps {
  // Une propriété peut s'appeler « __proto__ » ou « constructor » : elle est définie comme une
  // propriété ordinaire de l'objet, jamais par simple affectation.
  const put = (path: string, value: PropValue) =>
    Object.defineProperty(out, path, { value, enumerable: true, writable: true, configurable: true });
  for (const [key, value] of Object.entries(input)) {
    const path = prefix ? prefix + PATH_SEP + key : key;
    if (value === undefined) continue;
    if (isRecord(value)) {
      flattenProperties(value, path, out);
    } else if (Array.isArray(value)) {
      put(path, value.map((item) => (typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item))).join(', '));
    } else if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      put(path, value);
    } else {
      put(path, String(value));
    }
  }
  return out;
}

/** Valeur d'une propriété propre à l'objet (jamais une méthode héritée comme `toString`). */
export function ownValue(props: FlatProps | undefined, path: string): PropValue | undefined {
  return props !== undefined && Object.hasOwn(props, path) ? props[path] : undefined;
}

export function parseMetadata(json: unknown): Metadata {
  if (!isRecord(json)) throw new Error('Le fichier de métadonnées doit contenir un objet JSON.');

  const version = typeof json.version === 'number' ? json.version : SUPPORTED_VERSION;
  if (version > SUPPORTED_VERSION) {
    throw new Error(`Version ${version} du fichier de métadonnées non prise en charge (maximum : ${SUPPORTED_VERSION}).`);
  }

  const elements = new Map<string, MetadataEntry>();
  const add = (id: string | number, raw: unknown) => {
    if (!isRecord(raw)) return;
    const label = typeof raw.label === 'string' ? raw.label : undefined;
    let source: Record<string, unknown>;
    if (isRecord(raw.properties)) {
      source = raw.properties;
    } else {
      const { label: _label, id: _id, ...rest } = raw;
      source = rest;
    }
    elements.set(String(id), { label, props: flattenProperties(source) });
  };

  if (Array.isArray(json.elements)) {
    for (const item of json.elements) {
      if (isRecord(item) && (typeof item.id === 'string' || typeof item.id === 'number')) add(item.id, item);
    }
  } else if (isRecord(json.elements)) {
    for (const [id, raw] of Object.entries(json.elements)) add(id, raw);
  } else {
    // Forme simplifiée : l'objet racine est directement indexé par identifiant.
    for (const [id, raw] of Object.entries(json)) if (id !== 'version') add(id, raw);
  }

  if (elements.size === 0) throw new Error('Aucun élément trouvé dans le fichier de métadonnées.');
  return { version, elements };
}

// Nombres à la française (virgule décimale), sans séparateur de milliers pour ne pas dénaturer
// un numéro ou une année.
const decimal = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 4, useGrouping: false });

export function formatValue(value: PropValue | undefined): string {
  if (value === undefined || value === null || value === '') return UNDEFINED_LABEL;
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return String(value);
    const text = decimal.format(value);
    return text === '-0' ? '0' : text;
  }
  return value;
}

const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

/** Ordre naturel (« R+2 » avant « R+10 »), les valeurs non définies en dernier. */
export function compareValues(a: string, b: string): number {
  if (a === b) return 0;
  if (a === UNDEFINED_LABEL) return 1;
  if (b === UNDEFINED_LABEL) return -1;
  return collator.compare(a, b);
}

/** Propriétés de tous les éléments d'un modèle, indexées par numéro d'élément. */
export class PropertyStore {
  readonly count: number;
  paths: string[] = [];
  matched = 0;
  private readonly props: (FlatProps | undefined)[];
  private readonly labels: (string | undefined)[];
  private readonly groupCache = new Map<string, Map<string, number[]>>();

  constructor(count: number) {
    this.count = count;
    this.props = new Array<FlatProps | undefined>(count).fill(undefined);
    this.labels = new Array<string | undefined>(count).fill(undefined);
  }

  set(index: number, props: FlatProps, label?: string): void {
    this.props[index] = props;
    this.labels[index] = label;
  }

  /** À appeler une fois toutes les propriétés enregistrées. */
  finalize(): void {
    const paths = new Set<string>();
    this.matched = 0;
    for (const props of this.props) {
      if (!props) continue;
      this.matched++;
      for (const path in props) paths.add(path);
    }
    this.paths = [...paths].sort(collator.compare);
    this.groupCache.clear();
  }

  propsOf(index: number): FlatProps | undefined {
    return this.props[index];
  }

  labelOf(index: number): string | undefined {
    return this.labels[index];
  }

  displayValue(index: number, path: string): string {
    return formatValue(ownValue(this.props[index], path));
  }

  /**
   * Nombre de valeurs distinctes d'une propriété, sans construire les groupes. S'arrête dès que
   * `limit` est dépassé : sert à écarter vite les propriétés presque uniques (noms, identifiants).
   */
  distinctCount(path: string, limit: number): { count: number; undefinedCount: number } {
    const seen = new Set<PropValue>();
    let undefinedCount = 0;
    for (let i = 0; i < this.count; i++) {
      const value = ownValue(this.props[i], path);
      if (value === undefined || value === null || value === '') undefinedCount++;
      else if (seen.add(value).size > limit) break;
    }
    return { count: seen.size, undefinedCount };
  }

  /** Éléments regroupés par valeur d'une propriété, valeurs triées. */
  groups(path: string): Map<string, number[]> {
    let groups = this.groupCache.get(path);
    if (groups) return groups;
    const buckets = new Map<string, number[]>();
    for (let i = 0; i < this.count; i++) {
      const value = this.displayValue(i, path);
      const bucket = buckets.get(value);
      if (bucket) bucket.push(i);
      else buckets.set(value, [i]);
    }
    groups = new Map([...buckets.entries()].sort((a, b) => compareValues(a[0], b[0])));
    this.groupCache.set(path, groups);
    return groups;
  }
}
