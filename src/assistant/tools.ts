// Outils mis à disposition du LLM. Ils tournent dans le navigateur, sur les données déjà
// chargées : le modèle n'en reçoit que les résultats, jamais le fichier entier.

import { PATH_SEP, UNDEFINED_LABEL, ownValue, type PropValue, type PropertyStore } from '../data/metadata.ts';
import { numericValue, validateAppearanceRules, type AppearanceRule } from '../data/appearanceRules.ts';
import { ExpressionError, compileExpression, type Expression, type Value } from './expression.ts';

export type FilterOp = 'equals' | 'not_equals' | 'contains' | 'missing' | 'present' | 'greater' | 'less';

export interface Filter {
  property: string;
  op: FilterOp;
  value?: PropValue;
}

/** Tools can read metadata and change presentation only. No geometry or metadata write access. */
export interface ToolContext {
  store: PropertyStore;
  count: number;
  keys: readonly string[];
  labelOf(index: number): string;
  selection: ReadonlySet<number>;
  select(indices: number[], isolate: boolean): void;
  appearanceRules?: readonly AppearanceRule[];
  setAppearanceRules?(rules: AppearanceRule[]): void;
  grouping?: readonly string[];
  groupBy?(paths: string[]): void;
  isCurrent?(): boolean;
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
    type: 'function', function: {
      name: 'get_view_settings',
      description: 'Règles de couleur/opacité actives et regroupement de l’arborescence, dans leur ordre.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function', function: {
      name: 'update_view',
      description: 'Change seulement la présentation. Ajoute/remplace des règles par id, retire des ids, réordonne la pile et/ou regroupe l’arbre. Dernière règle correspondante prioritaire, séparément pour couleur et opacité. Les propriétés et la géométrie ne changent pas.',
      parameters: {
        type: 'object',
        properties: {
          rules: { type: 'array', description: 'Règles à ajouter/remplacer ; les autres restent.', items: { type: 'object', description: '{id,name?,enabled:true,conditions:[{property,op,value?,numericScale?}],color?:"#rrggbb",opacity?:0..1,opacityBy?:{property,scale:"percent"|"fraction"}}. Conditions ET, vide=tous. op: equals,not_equals,contains,missing,present,greater,less,greater_or_equal,less_or_equal. opacityBy percent:100→1,50→0.5; fraction:1→1,0.5→0.5. Choisir opacity ou opacityBy.' } },
          removeRuleIds: { type: 'array', description: 'Identifiants des règles à retirer.', items: { type: 'string', description: 'Identifiant de règle.' } },
          ruleOrder: { type: 'array', description: 'Tous les ids restants dans l’ordre souhaité ; dernier prioritaire.', items: { type: 'string', description: 'Identifiant de règle.' } },
          groupBy: { type: 'array', description: 'Propriétés formant la hiérarchie de l’arbre, dans l’ordre ; [] pour supprimer le regroupement.', items: { type: 'string', description: 'Nom exact d’une propriété.' } },
        },
      },
    },
  },
];

const DETAIL_LIMIT = 20;
const DETAIL_MAX = 50;
const COUNT_LIMIT = 40;

/** Metadata only: computed geometry is intentionally unavailable to the assistant. */
export function valueOf(context: ToolContext, index: number, path: string): PropValue | undefined {
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
      const a = numericValue(value);
      const b = numericValue(filter.value);
      if (a === undefined || b === undefined) return false;
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
  if (context.isCurrent?.() === false) return { result: { error: 'Le modèle a changé. Relancez votre demande.' }, note: 'Ancien modèle : opération abandonnée' };
  try { return executeTool(name, args, context); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { result: { error: message }, note: message };
  }
}

function executeTool(name: string, args: Record<string, unknown>, context: ToolContext): ToolOutcome {
  const { store } = context;
  switch (name) {
    case 'list_properties': {
      const search = typeof args.search === 'string' ? fold(args.search) : '';
      const paths = store.paths.filter((path) => search === '' || fold(path).includes(search));
      const properties: Record<string, unknown>[] = paths.slice(0, 120).map((path) => {
        const { count: distinct, undefinedCount } = store.distinctCount(path, 1000);
        return { property: path, distinct: distinct > 1000 ? '> 1000' : distinct, missing: undefinedCount, locked: !store.isEditable(path) };
      });
      const total = paths.length;
      return { result: { total, properties }, note: `${plural(total, 'propriété')} listée${total > 1 ? 's' : ''}` };
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


    case 'get_view_settings':
      return { result: { rules: context.appearanceRules ?? [], groupBy: context.grouping ?? [] }, note: 'Règles et regroupement actuels' };

    case 'update_view': {
      if (!context.setAppearanceRules || !context.groupBy) throw new Error('Les réglages de vue ne sont pas disponibles dans ce contexte.');
      const rawRules = asList(args.rules ?? []);
      if (!Array.isArray(rawRules)) throw new Error('rules doit être une liste.');
      // Resolve displayed property paths before shared validation; never silently change an ambiguous field.
      const resolve = (name: unknown): string => {
        const path = resolveProperty(store, String(name ?? ''));
        if (typeof path !== 'string') throw new Error(path.error);
        return path;
      };
      const patched = rawRules.map((raw) => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Chaque règle doit être un objet.');
        const rule = structuredClone(raw) as Record<string, unknown>;
        if (Array.isArray(rule.conditions)) rule.conditions = rule.conditions.map((condition: unknown) => {
          if (!condition || typeof condition !== 'object' || Array.isArray(condition)) throw new Error('Condition illisible.');
          const c = condition as Record<string, unknown>;
          return { ...c, property: resolve(c.property) };
        });
        if (rule.opacityBy && typeof rule.opacityBy === 'object' && !Array.isArray(rule.opacityBy)) {
          const opacityBy = rule.opacityBy as Record<string, unknown>;
          rule.opacityBy = { ...opacityBy, property: resolve(opacityBy.property) };
        }
        return rule;
      });
      const updates = validateAppearanceRules(patched, store);
      const removed = asList(args.removeRuleIds ?? []);
      if (!Array.isArray(removed) || !removed.every((id) => typeof id === 'string')) throw new Error('removeRuleIds doit contenir des identifiants.');
      if (updates.some((rule) => removed.includes(rule.id))) throw new Error('Une règle ne peut pas être retirée et remplacée simultanément.');
      let rules = (context.appearanceRules ?? []).filter((rule) => !removed.includes(rule.id)).map((rule) => structuredClone(rule));
      for (const update of updates) {
        const at = rules.findIndex((rule) => rule.id === update.id);
        if (at === -1) rules.push(update);
        else rules[at] = update;
      }
      if (args.ruleOrder !== undefined) {
        const order = asList(args.ruleOrder);
        if (!Array.isArray(order) || !order.every((id) => typeof id === 'string') || new Set(order).size !== rules.length || order.length !== rules.length || order.some((id) => !rules.some((rule) => rule.id === id))) {
          throw new Error('ruleOrder doit contenir chaque identifiant restant exactement une fois.');
        }
        rules = order.map((id) => rules.find((rule) => rule.id === id)!);
      }
      let grouping: string[] | undefined;
      if (args.groupBy !== undefined) {
        const paths = asList(args.groupBy);
        if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string')) throw new Error('groupBy doit être une liste de propriétés.');
        grouping = [...new Set(paths.map(resolve))];
      }
      const changesRules = args.rules !== undefined || args.removeRuleIds !== undefined || args.ruleOrder !== undefined;
      if (!changesRules && grouping === undefined) throw new Error('Indiquez les règles ou le regroupement à modifier.');
      if (changesRules) context.setAppearanceRules(rules);
      if (grouping !== undefined) context.groupBy(grouping);
      return { result: { rules: rules.map((rule) => ({ id: rule.id, enabled: rule.enabled })), groupBy: grouping ?? context.grouping ?? [] }, note: 'Présentation mise à jour : règles et regroupement' };
    }

    default:
      return { result: { error: `Outil inconnu : ${name}` }, note: `Outil inconnu : ${name}` };
  }
}
