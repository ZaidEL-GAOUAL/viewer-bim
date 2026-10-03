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
  /** Nom du fichier d'origine, pour l'affichage. */
  source?: string;
  /** Propriétés que le viewer ne doit pas laisser modifier (voir `isReadOnly`). */
  readOnly?: string[];
  /** Complete snapshots replace embedded properties for matching elements. Older JSON merges. */
  propertiesMode?: 'replace';
}

/**
 * Propriétés issues d'un IFC qui ne se modifient pas en changeant un texte : la classe de
 * l'objet, son type, sa place dans la structure spatiale, ses matériaux (des relations entre
 * objets) et les quantités, calculées à partir de la géométrie. Le convertisseur les écrit dans
 * le JSON, et le viewer les affiche sans champ de saisie.
 */
export const IFC_READ_ONLY = ['Classe IFC', 'Type', 'Type prédéfini', 'Site', 'Bâtiment', 'Niveau', 'Local', 'Matériaux', 'Qto_*'];

/**
 * Vrai si la propriété correspond à l'un des motifs : le nom exact, une catégorie entière
 * (« Qto_WallBaseQuantities » verrouille « Qto_WallBaseQuantities / NetVolume »), ou un préfixe
 * terminé par « * ».
 */
export function isReadOnly(path: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith('*')) {
      if (path.startsWith(pattern.slice(0, -1))) return true;
    } else if (path === pattern || path.startsWith(pattern + PATH_SEP)) {
      return true;
    }
  }
  return false;
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

/**
 * Réunit les propriétés déjà présentes dans le GLB et celles du JSON : celles du GLB d'abord,
 * celles du JSON ensuite. Pour une propriété de même nom, la valeur du JSON l'emporte.
 */
export function mergeProperties(fromModel: FlatProps | undefined, fromMetadata: FlatProps | undefined): FlatProps | undefined {
  if (!fromModel) return fromMetadata;
  if (!fromMetadata) return fromModel;
  return { ...fromModel, ...fromMetadata };
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
  const metadata: Metadata = { version, elements };
  if (Array.isArray(json.readOnly)) metadata.readOnly = json.readOnly.filter((item): item is string => typeof item === 'string');
  if (json.propertiesMode === 'replace') metadata.propertiesMode = 'replace';
  return metadata;
}

/** Reconstruit des propriétés imbriquées à partir des chemins aplatis (« A / B » → { A: { B } }). */
export function unflattenProperties(flat: FlatProps): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split(PATH_SEP);
    let target = out;
    for (const part of parts.slice(0, -1)) {
      // Seules les catégories créées ici comptent : « __proto__ » lu par héritage serait Object.prototype.
      const existing = Object.hasOwn(target, part) ? target[part] : undefined;
      if (isRecord(existing)) target = existing;
      else {
        const next: Record<string, unknown> = {};
        Object.defineProperty(target, part, { value: next, enumerable: true, writable: true, configurable: true });
        target = next;
      }
    }
    Object.defineProperty(target, parts[parts.length - 1], { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
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
  /** Motifs des propriétés non modifiables. */
  readOnly: string[] = [];
  /** Éléments dont l'objet de propriétés a été copié avant modification. */
  private readonly owned = new Set<number>();
  private readonly props: (FlatProps | undefined)[];
  private readonly labels: (string | undefined)[];
  private readonly groupCache = new Map<string, Map<string, number[]>>();
  private coverageCache: Map<string, number> | null = null;

  constructor(count: number) {
    this.count = count;
    this.props = new Array<FlatProps | undefined>(count).fill(undefined);
    this.labels = new Array<string | undefined>(count).fill(undefined);
  }

  set(index: number, props: FlatProps | undefined, label?: string): void {
    this.coverageCache = null;
    this.props[index] = props;
    this.labels[index] = label;
    this.owned.delete(index);
  }

  /** À appeler une fois toutes les propriétés enregistrées. */
  finalize(): void {
    this.coverageCache = null;
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

  isEditable(path: string): boolean {
    return !isReadOnly(path, this.readOnly);
  }

  /** Modifie (ou crée) une propriété d'un élément. Renvoie faux si rien n'a changé. */
  update(index: number, path: string, value: PropValue): boolean {
    let props = this.props[index];
    if (!props) {
      props = {};
      this.props[index] = props;
      this.matched++;
      this.owned.add(index);
    }
    if (Object.hasOwn(props, path) && props[path] === value) return false;
    this.coverageCache = null;
    if (!this.owned.has(index)) {
      // Les propriétés reçues de `set` appartiennent au fichier chargé : on modifie une copie,
      // pour pouvoir y revenir.
      props = { ...props };
      this.props[index] = props;
      this.owned.add(index);
    }
    Object.defineProperty(props, path, { value, enumerable: true, writable: true, configurable: true });
    if (!this.paths.includes(path)) this.paths = [...this.paths, path].sort(collator.compare);
    this.groupCache.delete(path);
    return true;
  }

  setLabel(index: number, label: string | undefined): void {
    this.labels[index] = label;
  }

  /** Les métadonnées courantes, modifications comprises, au format du contrat. */
  export(keys: readonly string[]): Record<string, unknown> {
    const elements: Record<string, unknown> = {};
    for (let i = 0; i < this.count; i++) {
      const props = this.props[i];
      if (!props) continue;
      const entry: Record<string, unknown> = {};
      if (this.labels[i]) entry.label = this.labels[i];
      entry.properties = unflattenProperties(props);
      Object.defineProperty(elements, keys[i], { value: entry, enumerable: true, writable: true, configurable: true });
    }
    const out: Record<string, unknown> = { version: SUPPORTED_VERSION, propertiesMode: 'replace' };
    if (this.readOnly.length > 0) out.readOnly = [...this.readOnly];
    out.elements = elements;
    return out;
  }

  labelOf(index: number): string | undefined {
    return this.labels[index];
  }

  /** One scan of populated fields, shared by all property-picker coverage queries. */
  coverageOf(path: string): number {
    if (!this.coverageCache) {
      this.coverageCache = new Map();
      for (const props of this.props) if (props) for (const [key, value] of Object.entries(props)) {
        if (value !== null && value !== '') this.coverageCache.set(key, (this.coverageCache.get(key) ?? 0) + 1);
      }
    }
    return this.coverageCache.get(path) ?? 0;
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
