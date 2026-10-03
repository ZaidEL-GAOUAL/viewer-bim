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

/** Ce que les outils peuvent lire et faire dans l'application. */
export interface ToolContext {
  store: PropertyStore;
  count: number;
  keys: readonly string[];
  labelOf(index: number): string;
  selection: ReadonlySet<number>;
  select(indices: number[], isolate: boolean): void;
  /** Nombre de valeurs changées, ou 'locked' si la propriété est verrouillée. */
  edit(indices: number[], path: string, value: PropValue): number | 'locked';
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
  const paths = store.paths;
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
  const { store } = context;
  return base.filter((index) => {
    const props = store.propsOf(index);
    return filters.every(({ path, filter }) => matches(ownValue(props, path), filter));
  });
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

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('fr-FR')} ${count > 1 ? pluralForm : singular}`;
}

// ------------------------------------------------------------------- outils

function elementSummary(context: ToolContext, index: number, paths: string[]): Record<string, unknown> {
  const props = context.store.propsOf(index);
  const out: Record<string, unknown> = { label: context.labelOf(index), id: context.keys[index] };
  for (const path of paths) out[path] = ownValue(props, path) ?? null;
  return out;
}

export function runTool(name: string, args: Record<string, unknown>, context: ToolContext): ToolOutcome {
  const { store } = context;
  switch (name) {
    case 'list_properties': {
      const search = typeof args.search === 'string' ? fold(args.search) : '';
      const paths = store.paths.filter((path) => search === '' || fold(path).includes(search));
      const properties = paths.slice(0, 120).map((path) => {
        const { count: distinct, undefinedCount } = store.distinctCount(path, 1000);
        return { property: path, distinct: distinct > 1000 ? '> 1000' : distinct, missing: undefinedCount, locked: !store.isEditable(path) };
      });
      return { result: { total: paths.length, properties }, note: `${plural(paths.length, 'propriété')} listée${paths.length > 1 ? 's' : ''}` };
    }

    case 'count_by': {
      const path = resolveProperty(store, String(args.property ?? ''));
      if (typeof path !== 'string') return { result: path, note: path.error };
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
        const props = store.propsOf(index);
        const lookup = (path: string) => ownValue(props, path);
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

    default:
      return { result: { error: `Outil inconnu : ${name}` }, note: `Outil inconnu : ${name}` };
  }
}
