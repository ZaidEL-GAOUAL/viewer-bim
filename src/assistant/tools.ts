// Outils mis à disposition du LLM. Ils tournent dans le navigateur, sur les données déjà
// chargées : le modèle n'en reçoit que les résultats, jamais le fichier entier.

import { PATH_SEP, UNDEFINED_LABEL, ownValue, type PropValue, type PropertyStore } from '../data/metadata.ts';
import { ExpressionError, compileExpression, type Expression, type Value } from './expression.ts';

export type FilterOp = 'equals' | 'not_equals' | 'contains' | 'missing' | 'present' | 'greater' | 'less';

export interface Filter {
  property: string;
  op: FilterOp;
  value?: PropValue;
}

/** Boîte englobante d'un élément, en mètres, dans le repère du projet (Y vertical). */
export interface ElementBox {
  min: [number, number, number];
  max: [number, number, number];
}

/** Ce que les outils peuvent lire et faire dans l'application. */
export interface ToolContext {
  store: PropertyStore;
  count: number;
  keys: readonly string[];
  labelOf(index: number): string;
  /** Emprise calculée depuis la 3D, ou null pour un élément sans géométrie. */
  geometry(index: number): ElementBox | null;
  selection: ReadonlySet<number>;
  select(indices: number[], isolate: boolean): void;
  /** Nombre de valeurs changées, ou 'locked' si la propriété est verrouillée. */
  edit(indices: number[], path: string, value: PropValue): number | 'locked';
  /** Déplace des éléments (mètres, Y vertical) ; renvoie le nombre déplacé. */
  move(indices: number[], dx: number, dy: number, dz: number): number;
  /** Copie des éléments, décalés ; renvoie les indices des copies. */
  duplicate(indices: number[], dx: number, dy: number, dz: number): number[];
  /** Crée des boîtes avec leur fiche ; renvoie leurs indices. */
  addBoxes(boxes: BoxRequest[]): number[];
}

export interface BoxRequest {
  name: string;
  size: [number, number, number];
  center: [number, number, number];
  rotation?: number;
  color?: [number, number, number];
  properties?: Record<string, PropValue>;
}

export interface ToolOutcome {
  /** Résultat renvoyé au modèle. */
  result: unknown;
  /** Ligne lisible pour l'utilisateur (« 12 éléments trouvés »). */
  note: string;
}

/** Définitions au format OpenAI (comprises par Workers AI, Groq, Cerebras). Renvoyées à chaque appel : courtes. */
const FILTERS = {
  type: 'array',
  description: 'Filtres combinés par ET : {property, op, value}. op : equals, not_equals, contains, missing, present, greater, less. Liste vide = tous.',
  items: { type: 'object', description: 'Filtre {property, op, value}.' },
};
const SCOPE = { type: 'string', description: '"model" (défaut) ou "selection" (éléments sélectionnés).' };

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'list_properties',
      description: 'Propriétés du modèle avec leur nombre de valeurs distinctes.',
      parameters: { type: 'object', properties: { search: { type: 'string', description: 'Texte cherché dans les noms (facultatif).' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'count_by',
      description: 'Répartition des éléments par valeur d’une propriété.',
      parameters: { type: 'object', properties: { property: { type: 'string', description: 'Nom de la propriété.' }, scope: SCOPE }, required: ['property'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_elements',
      description: 'Éléments vérifiant les filtres : total et premiers éléments avec les propriétés demandées.',
      parameters: {
        type: 'object',
        properties: {
          filters: FILTERS,
          properties: { type: 'array', description: 'Propriétés à renvoyer (facultatif).', items: { type: 'string', description: 'Nom de propriété.' } },
          scope: SCOPE,
          limit: { type: 'number', description: 'Éléments détaillés (défaut 20, max 50).' },
        },
        required: ['filters'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_element',
      description: 'Toutes les propriétés d’un élément, par nom ou identifiant (même partiel).',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Nom ou identifiant.' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'select_elements',
      description: 'Sélectionne et cadre dans la vue 3D les éléments vérifiant les filtres ; isolate=true masque les autres.',
      parameters: { type: 'object', properties: { filters: FILTERS, scope: SCOPE, isolate: { type: 'boolean', description: 'N’afficher que ces éléments.' } }, required: ['filters'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compute',
      description: 'Calcule une formule sur chaque élément vérifiant les filtres (le viewer fait le calcul, pas toi) : somme, moyenne, min, max, et les éléments où une condition est vraie. Propriétés entre crochets : [Qto_WallBaseQuantities / NetVolume] - [Length] * [Height] * 0.2 ; condition : [LoadBearing] == true and [FireRating] == null. Opérateurs : + - * / < <= > >= == != and or not, abs() min() max() round().',
      parameters: {
        type: 'object',
        properties: {
          filters: FILTERS,
          scope: SCOPE,
          expression: { type: 'string', description: 'Formule numérique par élément (facultatif si where est donné).' },
          where: { type: 'string', description: 'Condition par élément ; renvoie les éléments où elle est vraie (facultatif).' },
        },
        required: ['filters'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_elements',
      description: 'Déplace les éléments vérifiant les filtres d’un vecteur en mètres (dy = vertical).',
      parameters: {
        type: 'object',
        properties: {
          filters: FILTERS,
          scope: SCOPE,
          dx: { type: 'number', description: 'Décalage X (m).' },
          dy: { type: 'number', description: 'Décalage vertical (m).' },
          dz: { type: 'number', description: 'Décalage Z (m).' },
        },
        required: ['filters', 'dx', 'dy', 'dz'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'duplicate_elements',
      description: 'Copie les éléments vérifiant les filtres, décalés d’un vecteur en mètres, avec leurs propriétés.',
      parameters: {
        type: 'object',
        properties: {
          filters: FILTERS,
          scope: SCOPE,
          dx: { type: 'number', description: 'Décalage X (m).' },
          dy: { type: 'number', description: 'Décalage vertical (m).' },
          dz: { type: 'number', description: 'Décalage Z (m).' },
        },
        required: ['filters', 'dx', 'dy', 'dz'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_boxes',
      description: 'Crée des boîtes (murs provisoires, réservations, zones, mobilier simplifié) dans le modèle, chacune avec sa fiche. Coordonnées du projet en mètres, Y vertical ; center = centre de la boîte (son bas est à center.y - size.y/2).',
      parameters: {
        type: 'object',
        properties: {
          boxes: {
            type: 'array',
            description: 'Boîtes : {name, size:[x,y,z], center:[x,y,z], rotation (degrés autour de la verticale, facultatif), color:[r,g,b] 0-255 (facultatif), properties:{…} (facultatif, ex. "Classe IFC", "Niveau")}.',
            items: { type: 'object', description: 'Une boîte.' },
          },
        },
        required: ['boxes'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_property',
      description: 'Donne une valeur à une propriété (existante ou nouvelle, "Catégorie / Nom") sur les éléments vérifiant les filtres. Refusé si verrouillée.',
      parameters: {
        type: 'object',
        properties: {
          filters: FILTERS,
          scope: SCOPE,
          property: { type: 'string', description: 'Propriété à modifier ou créer.' },
          value: { type: 'string', description: 'Valeur : texte, nombre, true/false, ou null pour effacer.' },
        },
        required: ['filters', 'property', 'value'],
      },
    },
  },
];

const DETAIL_LIMIT = 20;
const DETAIL_MAX = 50;
const COUNT_LIMIT = 40;

// ------------------------------------------------- propriétés calculées (3D)

export const GEOMETRY_CATEGORY = 'Géométrie';
const GEOMETRY_NAMES = ['Centre X', 'Centre Y', 'Centre Z', 'Emprise X', 'Emprise Y (hauteur)', 'Emprise Z', 'Bas', 'Haut'] as const;
/** Propriétés en lecture seule calculées depuis la géométrie, utilisables dans les filtres et les formules. */
export const GEOMETRY_PATHS: string[] = GEOMETRY_NAMES.map((name) => `${GEOMETRY_CATEGORY}${PATH_SEP}${name}`);
const GEOMETRY_SET = new Set(GEOMETRY_PATHS);

function geometryValue(box: ElementBox, path: string): number {
  const name = path.slice(GEOMETRY_CATEGORY.length + PATH_SEP.length);
  const round = (value: number) => Number(value.toFixed(3));
  switch (name) {
    case 'Centre X':
      return round((box.min[0] + box.max[0]) / 2);
    case 'Centre Y':
      return round((box.min[1] + box.max[1]) / 2);
    case 'Centre Z':
      return round((box.min[2] + box.max[2]) / 2);
    case 'Emprise X':
      return round(box.max[0] - box.min[0]);
    case 'Emprise Y (hauteur)':
      return round(box.max[1] - box.min[1]);
    case 'Emprise Z':
      return round(box.max[2] - box.min[2]);
    case 'Bas':
      return round(box.min[1]);
    case 'Haut':
      return round(box.max[1]);
    default:
      return NaN;
  }
}

/** Valeur d'une propriété d'un élément : celle des métadonnées, ou calculée depuis la 3D. */
export function valueOf(context: ToolContext, index: number, path: string): PropValue | undefined {
  if (GEOMETRY_SET.has(path)) {
    const box = context.geometry(index);
    return box ? geometryValue(box, path) : undefined;
  }
  return ownValue(context.store.propsOf(index), path);
}

// ------------------------------------------------------------- résolution

function fold(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('fr').trim();
}

/**
 * Retrouve le chemin exact d'une propriété à partir d'un nom approximatif : nom complet, puis
 * sans tenir compte de la casse et des accents, puis dernier segment (« FireRating » pour
 * « Pset_WallCommon / FireRating ») s'il est unique.
 */
export function resolveProperty(store: PropertyStore, name: string): string | { error: string } {
  const paths = [...store.paths, ...GEOMETRY_PATHS];
  if (paths.includes(name)) return name;
  const wanted = fold(name.replace(/\s*\/\s*/g, PATH_SEP));
  const exact = paths.filter((path) => fold(path) === wanted);
  if (exact.length === 1) return exact[0];
  const tails = paths.filter((path) => fold(path.slice(path.lastIndexOf(PATH_SEP) + PATH_SEP.length)) === wanted);
  if (tails.length === 1) return tails[0];
  const partial = tails.length > 1 ? tails : paths.filter((path) => fold(path).includes(wanted));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) return { error: `Propriété « ${name} » ambiguë : ${partial.slice(0, 8).join(' ; ')}` };
  return { error: `Propriété « ${name} » introuvable. Utilisez list_properties pour voir les noms exacts.` };
}

function isMissing(value: PropValue | undefined): boolean {
  return value === undefined || value === null || value === '';
}

function sameValue(value: PropValue, wanted: PropValue): boolean {
  if (typeof value === 'number' || typeof wanted === 'number') {
    const a = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
    const b = typeof wanted === 'number' ? wanted : Number(String(wanted).replace(',', '.'));
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  }
  if (typeof value === 'boolean' || typeof wanted === 'boolean') return String(value) === String(wanted).toLowerCase();
  return fold(String(value)) === fold(String(wanted));
}

function matches(value: PropValue | undefined, filter: Filter): boolean {
  switch (filter.op) {
    case 'missing':
      return isMissing(value);
    case 'present':
      return !isMissing(value);
    case 'equals':
      return !isMissing(value) && filter.value !== undefined && sameValue(value!, filter.value);
    case 'not_equals':
      return isMissing(value) || filter.value === undefined || !sameValue(value!, filter.value);
    case 'contains':
      return !isMissing(value) && fold(String(value)).includes(fold(String(filter.value ?? '')));
    case 'greater':
    case 'less': {
      const a = Number(String(value ?? '').replace(',', '.'));
      const b = Number(String(filter.value ?? '').replace(',', '.'));
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return filter.op === 'greater' ? a > b : a < b;
    }
    default:
      return false;
  }
}

interface ResolvedFilter {
  path: string;
  filter: Filter;
}

/** Certains modèles renvoient une liste sous forme de texte JSON : on la relit. */
function asList(raw: unknown): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function parseFilters(store: PropertyStore, rawFilters: unknown): ResolvedFilter[] | { error: string } {
  const raw = asList(rawFilters);
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw)) return { error: 'filters doit être une liste.' };
  const out: ResolvedFilter[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return { error: 'Chaque filtre doit être un objet {property, op, value}.' };
    const record = item as Record<string, unknown>;
    const property = typeof record.property === 'string' ? record.property : '';
    const op = String(record.op ?? 'equals') as FilterOp;
    if (!['equals', 'not_equals', 'contains', 'missing', 'present', 'greater', 'less'].includes(op)) return { error: `Opérateur inconnu : ${op}` };
    const path = resolveProperty(store, property);
    if (typeof path !== 'string') return path;
    const value = record.value;
    out.push({ path, filter: { property, op, value: value === undefined || value === null ? undefined : (value as PropValue) } });
  }
  return out;
}

/** Indices des éléments du périmètre qui vérifient tous les filtres. */
export function selectIndices(context: ToolContext, filters: ResolvedFilter[], scope: unknown): number[] {
  const base = scope === 'selection' ? [...context.selection] : Array.from({ length: context.count }, (_, i) => i);
  if (filters.length === 0) return base;
  return base.filter((index) => filters.every(({ path, filter }) => matches(valueOf(context, index, path), filter)));
}

function parseValue(raw: unknown): PropValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  const text = String(raw).trim();
  if (text === '' || text === 'null') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(?:[.,]\d+)?$/.test(text)) return Number(text.replace(',', '.'));
  return text;
}

function triple(raw: unknown, what: string): [number, number, number] | { error: string } {
  const list = asList(raw);
  if (!Array.isArray(list) || list.length !== 3) return { error: `${what} doit être [x, y, z] en mètres.` };
  const values = list.map((item) => Number(String(item).replace(',', '.')));
  if (!values.every(Number.isFinite)) return { error: `${what} doit contenir trois nombres.` };
  return values as [number, number, number];
}

function parseBox(item: unknown): BoxRequest | { error: string } {
  if (typeof item !== 'object' || item === null) return { error: 'Chaque boîte doit être un objet {name, size, center}.' };
  const record = item as Record<string, unknown>;
  const name = String(record.name ?? '').trim() || 'Boîte';
  const size = triple(record.size, 'size');
  if ('error' in size) return size;
  if (size.some((value) => value <= 0)) return { error: 'size : les trois dimensions doivent être positives.' };
  const center = triple(record.center, 'center');
  if ('error' in center) return center;
  const rotation = record.rotation === undefined ? 0 : Number(String(record.rotation).replace(',', '.'));
  if (!Number.isFinite(rotation)) return { error: 'rotation doit être un nombre de degrés.' };
  let color: [number, number, number] | undefined;
  if (record.color !== undefined) {
    const parsed = triple(record.color, 'color');
    if ('error' in parsed) return parsed;
    color = parsed.map((value) => Math.max(0, Math.min(255, Math.round(value)))) as [number, number, number];
  }
  const properties: Record<string, PropValue> = {};
  const rawProps = typeof record.properties === 'string' ? asList(record.properties) : record.properties;
  if (rawProps && typeof rawProps === 'object' && !Array.isArray(rawProps)) {
    for (const [key, value] of Object.entries(rawProps as Record<string, unknown>)) {
      const path = key.split('/').map((part) => part.trim()).filter(Boolean).join(PATH_SEP);
      if (path) Object.defineProperty(properties, path, { value: parseValue(value), enumerable: true, writable: true, configurable: true });
    }
  }
  return { name, size, center, rotation, color, properties };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('fr-FR')} ${count > 1 ? pluralForm : singular}`;
}

// ------------------------------------------------------------------- outils

function elementSummary(context: ToolContext, index: number, paths: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { label: context.labelOf(index), id: context.keys[index] };
  for (const path of paths) out[path] = valueOf(context, index, path) ?? null;
  return out;
}

export function runTool(name: string, args: Record<string, unknown>, context: ToolContext): ToolOutcome {
  const { store } = context;
  switch (name) {
    case 'list_properties': {
      const search = typeof args.search === 'string' ? fold(args.search) : '';
      const paths = store.paths.filter((path) => search === '' || fold(path).includes(search));
      const properties: Record<string, unknown>[] = paths.slice(0, 120).map((path) => {
        const { count: distinct, undefinedCount } = store.distinctCount(path, 1000);
        return { property: path, distinct: distinct > 1000 ? '> 1000' : distinct, missing: undefinedCount, locked: !store.isEditable(path) };
      });
      const computed = GEOMETRY_PATHS.filter((path) => search === '' || fold(path).includes(search));
      for (const path of computed) properties.push({ property: path, computed: true, locked: true, unit: 'm' });
      const total = paths.length + computed.length;
      return { result: { total, properties }, note: `${plural(total, 'propriété')} listée${total > 1 ? 's' : ''}` };
    }

    case 'count_by': {
      const path = resolveProperty(store, String(args.property ?? ''));
      if (typeof path !== 'string') return { result: path, note: path.error };
      if (GEOMETRY_SET.has(path)) {
        return { result: { error: `« ${path} » est une valeur continue calculée : utilisez compute (somme, min, max) ou find_elements avec greater/less.` }, note: 'Propriété calculée : pas de répartition' };
      }
      const scope = args.scope === 'selection' ? context.selection : null;
      const counts = new Map<string, number>();
      for (const [label, members] of store.groups(path)) {
        const count = scope ? members.filter((index) => scope.has(index)).length : members.length;
        if (count > 0) counts.set(label, count);
      }
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const values = sorted.slice(0, COUNT_LIMIT).map(([value, count]) => ({ value: value === UNDEFINED_LABEL ? null : value, count }));
      const total = sorted.reduce((sum, [, count]) => sum + count, 0);
      return {
        result: { property: path, total, distinct: sorted.length, values, truncated: sorted.length > COUNT_LIMIT },
        note: `Répartition par « ${path} » : ${plural(sorted.length, 'valeur')}`,
      };
    }

    case 'find_elements': {
      const filters = parseFilters(store, args.filters);
      if (!Array.isArray(filters)) return { result: filters, note: filters.error };
      const wanted: string[] = [];
      const requested = asList(args.properties);
      if (Array.isArray(requested)) {
        for (const item of requested) {
          const path = resolveProperty(store, String(item));
          if (typeof path === 'string') wanted.push(path);
        }
      }
      for (const { path } of filters) if (!wanted.includes(path)) wanted.push(path);
      const indices = selectIndices(context, filters, args.scope);
      const limit = Math.min(DETAIL_MAX, Math.max(1, Number(args.limit) || DETAIL_LIMIT));
      const elements = indices.slice(0, limit).map((index) => elementSummary(context, index, wanted));
      return { result: { count: indices.length, shown: elements.length, elements }, note: `${plural(indices.length, 'élément')} trouvé${indices.length > 1 ? 's' : ''}` };
    }

    case 'get_element': {
      const query = fold(String(args.query ?? ''));
      if (!query) return { result: { error: 'query vide' }, note: 'Nom manquant' };
      const found: number[] = [];
      for (let index = 0; index < context.count && found.length < 3; index++) {
        if (fold(context.labelOf(index)).includes(query) || fold(context.keys[index]) === query) found.push(index);
      }
      if (found.length === 0) return { result: { error: `Aucun élément dont le nom ou l’identifiant contient « ${args.query} ».` }, note: 'Élément introuvable' };
      const elements = found.map((index) => ({ label: context.labelOf(index), id: context.keys[index], properties: store.propsOf(index) ?? {} }));
      return { result: { elements }, note: `Fiche de « ${context.labelOf(found[0])} »${found.length > 1 ? ` (+${found.length - 1})` : ''}` };
    }

    case 'select_elements': {
      const filters = parseFilters(store, args.filters);
      if (!Array.isArray(filters)) return { result: filters, note: filters.error };
      const indices = selectIndices(context, filters, args.scope);
      const isolate = args.isolate === true;
      context.select(indices, isolate);
      return { result: { count: indices.length, isolated: isolate }, note: `${plural(indices.length, 'élément')} ${isolate ? 'isolé' : 'sélectionné'}${indices.length > 1 ? 's' : ''}` };
    }

    case 'compute': {
      const filters = parseFilters(store, args.filters);
      if (!Array.isArray(filters)) return { result: filters, note: filters.error };
      const compile = (text: unknown): Expression | null | { error: string } => {
        if (typeof text !== 'string' || text.trim() === '') return null;
        try {
          return compileExpression(text, (name) => {
            const path = resolveProperty(store, name);
            if (typeof path !== 'string') throw new ExpressionError(path.error);
            return path;
          });
        } catch (error) {
          return { error: `Formule illisible : ${error instanceof Error ? error.message : String(error)}` };
        }
      };
      const expression = compile(args.expression);
      const where = compile(args.where);
      if (expression && 'error' in expression) return { result: expression, note: expression.error };
      if (where && 'error' in where) return { result: where, note: where.error };
      if (!expression && !where) return { result: { error: 'Donnez expression et/ou where.' }, note: 'Formule manquante' };

      const indices = selectIndices(context, filters, args.scope);
      const stats = { elements: indices.length, computed: 0, skipped: 0, sum: 0, min: Infinity, max: -Infinity };
      const matching: number[] = [];
      const values = new Map<number, number>();
      for (const index of indices) {
        const lookup = (path: string) => valueOf(context, index, path);
        if (where) {
          const ok: Value = where.evaluate(lookup);
          if (ok !== true) continue;
          matching.push(index);
        }
        if (expression) {
          const value = expression.evaluate(lookup);
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            stats.skipped++;
            continue;
          }
          stats.computed++;
          stats.sum += value;
          stats.min = Math.min(stats.min, value);
          stats.max = Math.max(stats.max, value);
          values.set(index, value);
        }
      }
      const paths = [...new Set([...(expression?.paths ?? []), ...(where?.paths ?? [])])];
      const shown = (where ? matching : [...values.keys()]).slice(0, DETAIL_LIMIT);
      const examples = shown.map((index) => {
        const summary = elementSummary(context, index, paths);
        if (values.has(index)) summary.value = Number(values.get(index)!.toPrecision(10));
        return summary;
      });
      const result: Record<string, unknown> = { elements: indices.length, shown: examples.length, examples };
      if (where) result.matching = matching.length;
      if (expression) {
        Object.assign(result, {
          computed: stats.computed,
          skipped: stats.skipped,
          sum: Number(stats.sum.toPrecision(10)),
          mean: stats.computed > 0 ? Number((stats.sum / stats.computed).toPrecision(10)) : null,
          min: stats.computed > 0 ? stats.min : null,
          max: stats.computed > 0 ? stats.max : null,
        });
        if (stats.skipped > 0) result.note = `${stats.skipped} éléments ignorés : propriété absente ou non numérique.`;
      }
      const note = where
        ? `Condition vraie pour ${plural(matching.length, 'élément')} sur ${indices.length}`
        : `Calcul sur ${plural(stats.computed, 'élément')} : somme ${Number(stats.sum.toPrecision(6)).toLocaleString('fr-FR')}`;
      return { result, note };
    }

    case 'set_property': {
      const filters = parseFilters(store, args.filters);
      if (!Array.isArray(filters)) return { result: filters, note: filters.error };
      const name = String(args.property ?? '').trim();
      if (!name) return { result: { error: 'property manquante' }, note: 'Propriété manquante' };
      const resolved = resolveProperty(store, name);
      // Une propriété inconnue est créée sous le nom donné (avec « / » pour la catégorie).
      const path = typeof resolved === 'string' ? resolved : name.split('/').map((part) => part.trim()).filter(Boolean).join(PATH_SEP);
      if (GEOMETRY_SET.has(path) || path.startsWith(GEOMETRY_CATEGORY + PATH_SEP)) {
        return { result: { changed: 0, error: `« ${path} » est calculée depuis la 3D : elle ne se modifie pas.` }, note: `« ${path} » est calculée` };
      }
      const value = parseValue(args.value);
      const indices = selectIndices(context, filters, args.scope);
      if (indices.length === 0) return { result: { changed: 0, error: 'Aucun élément ne vérifie ces filtres.' }, note: 'Aucun élément concerné' };
      const changed = context.edit(indices, path, value);
      if (changed === 'locked') {
        return { result: { changed: 0, error: `« ${path} » est une propriété verrouillée : elle ne peut pas être modifiée.` }, note: `« ${path} » est verrouillée` };
      }
      return {
        result: { property: path, value, elements: indices.length, changed },
        note: `« ${path} » = ${value === null ? '(effacé)' : String(value)} sur ${plural(indices.length, 'élément')}`,
      };
    }

    case 'move_elements':
    case 'duplicate_elements': {
      const filters = parseFilters(store, args.filters);
      if (!Array.isArray(filters)) return { result: filters, note: filters.error };
      const [dx, dy, dz] = ['dx', 'dy', 'dz'].map((key) => Number(String(args[key] ?? 0).replace(',', '.')));
      if (![dx, dy, dz].every(Number.isFinite)) return { result: { error: 'dx, dy, dz doivent être des nombres (mètres).' }, note: 'Décalage illisible' };
      const indices = selectIndices(context, filters, args.scope);
      if (indices.length === 0) return { result: { moved: 0, error: 'Aucun élément ne vérifie ces filtres.' }, note: 'Aucun élément concerné' };
      if (indices.length > 500) return { result: { error: `${indices.length} éléments : trop pour une seule opération (maximum 500). Précisez les filtres.` }, note: 'Trop d’éléments' };
      if (name === 'move_elements') {
        const moved = context.move(indices, dx, dy, dz);
        return { result: { moved, delta: [dx, dy, dz] }, note: `${plural(moved, 'élément')} déplacé${moved > 1 ? 's' : ''} de (${dx}, ${dy}, ${dz}) m` };
      }
      const created = context.duplicate(indices, dx, dy, dz);
      return {
        result: { created: created.length, elements: created.slice(0, DETAIL_LIMIT).map((index) => elementSummary(context, index, [])) },
        note: `${plural(created.length, 'copie')} créée${created.length > 1 ? 's' : ''}, décalée${created.length > 1 ? 's' : ''} de (${dx}, ${dy}, ${dz}) m`,
      };
    }

    case 'add_boxes': {
      const raw = asList(args.boxes);
      if (!Array.isArray(raw) || raw.length === 0) return { result: { error: 'boxes doit être une liste de boîtes.' }, note: 'Aucune boîte' };
      if (raw.length > 100) return { result: { error: 'Au plus 100 boîtes par appel.' }, note: 'Trop de boîtes' };
      const boxes: BoxRequest[] = [];
      for (const item of raw) {
        const box = parseBox(item);
        if ('error' in box) return { result: box, note: box.error };
        boxes.push(box);
      }
      const created = context.addBoxes(boxes);
      return {
        result: { created: created.length, elements: created.slice(0, DETAIL_LIMIT).map((index) => elementSummary(context, index, [])) },
        note: `${plural(created.length, 'boîte')} créée${created.length > 1 ? 's' : ''} : ${boxes.slice(0, 4).map((box) => box.name).join(', ')}${boxes.length > 4 ? '…' : ''}`,
      };
    }

    default:
      return { result: { error: `Outil inconnu : ${name}` }, note: `Outil inconnu : ${name}` };
  }
}
