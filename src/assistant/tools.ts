// Outils mis à disposition du LLM. Ils tournent dans le navigateur, sur les données déjà
// chargées : le modèle n'en reçoit que les résultats, jamais le fichier entier.

import { PATH_SEP, UNDEFINED_LABEL, coerceTo, compareValues, formatValue, ownValue, rankedValues, toPropertyPath, type PropValue, type PropertyStore } from '../data/metadata.ts';
import { formatScheduleDate, parseScheduleDate } from '../data/schedule.ts';
import { validateAppearanceRules, type AppearanceRule } from '../data/appearanceRules.ts';
import { isMissing, matchesCondition, valueAt, type ElementIdentity, type RuleCondition, type RuleOp } from '../data/conditions.ts';
import { fold, plural, s } from '../data/text.ts';
import { ELEMENT_ID, ELEMENT_NAME, isElementField } from '../data/elementFields.ts';
import { ExpressionError, compileExpression, type Expression, type Value } from './expression.ts';
import { coerceArgs } from './schema.ts';

export { TOOL_DEFINITIONS } from './schema.ts';

/**
 * Tools read metadata, change presentation and write properties (undoable). They never write geometry, and
 * geometry never reaches the model: code may use it to order things (`heightOf`, for plan_dates) but only
 * properties, names and identifiers go into a tool result.
 */
export interface ToolContext {
  store: PropertyStore;
  count: number;
  keys: readonly string[];
  labelOf(index: number): string;
  selection: ReadonlySet<number>;
  /** Éléments dont l'identifiant figure mot pour mot dans la demande en cours. */
  mentioned?: ReadonlySet<number>;
  select(indices: number[], isolate: boolean): void;
  /** Affiche ou masque des éléments sans toucher à la sélection. */
  setVisible?(indices: number[], visible: boolean): void;
  showAll?(): void;
  appearanceRules?: readonly AppearanceRule[];
  setAppearanceRules?(rules: AppearanceRule[]): void;
  grouping?: readonly string[];
  groupBy?(paths: string[]): void;
  /** Écrit des valeurs (élément, propriété, valeur) en une seule étape annulable. Faux si rien n'a changé. */
  writeProperties?(updates: readonly (readonly [number, string, PropValue])[]): boolean;
  /** Ouvre le Planning 4D à partir de deux propriétés de dates ; renvoie le nombre de tâches. */
  openPlanning?(startProperty: string, endProperty: string): number;
  /** Bas de l'élément sur l'axe vertical de la maquette (undefined sans géométrie). Sert à ranger un planning, jamais renvoyé au modèle. */
  heightOf?(index: number): number | undefined;
  isCurrent?(): boolean;
}

export interface ToolOutcome {
  /** Résultat renvoyé au modèle. */
  result: unknown;
  /** Ligne lisible pour l'utilisateur (« 12 éléments trouvés »). */
  note: string;
}

/** Règles posées par « mettre en évidence », dans cet ordre : atténuation générale, puis les éléments visés. */
const HIGHLIGHT_IDS: readonly string[] = ['assistant-dim-others', 'assistant-highlight'];
const isHighlightRule = (id: string) => id === HIGHLIGHT_IDS[0] || id.startsWith(HIGHLIGHT_IDS[1]);

/**
 * L'identifiant tapé par l'utilisateur l'emporte : si le modèle élargit la cible par un filtre qui
 * attrape aussi des homonymes de l'élément cité (même nom, autre niveau), on revient à lui seul.
 * Une cible volontairement plus large (un niveau entier, une catégorie) n'est pas touchée.
 */
function narrowToMentioned(context: ToolContext, filters: ResolvedFilter[], indices: number[]): { indices: number[]; narrowed: number } {
  const mentioned = context.mentioned;
  if (!mentioned || mentioned.size === 0 || filters.some(({ path }) => path === ELEMENT_ID)) return { indices, narrowed: 0 };
  const kept = indices.filter((index) => mentioned.has(index));
  if (kept.length === 0 || kept.length === indices.length) return { indices, narrowed: 0 };
  const names = new Set(kept.map((index) => context.labelOf(index)));
  const homonymsOnly = indices.every((index) => mentioned.has(index) || names.has(context.labelOf(index)));
  return homonymsOnly ? { indices: kept, narrowed: indices.length - kept.length } : { indices, narrowed: 0 };
}

/** Fin d'action : le modèle a ce qu'il faut pour répondre ; une seconde action remplacerait la première. */
const DONE = 'Action faite, le viewer en rend compte. Termine sans autre appel ({"answer": ""}), sauf si la demande comporte une autre action distincte.';

const DETAIL_LIMIT = 20;
/** Éléments montrés dans un aperçu d'écriture (dryRun). */
const PREVIEW_SAMPLE = 5;
/** Mise en évidence d'une cible hors filtres : une règle par élément, donc bornée. */
const HIGHLIGHT_MAX = 50;
const DETAIL_MAX = 50;
const COUNT_LIMIT = 40;

const identities = new WeakMap<ToolContext, ElementIdentity>();
/** What the model can read about an element: its properties, name and identifier, never computed geometry. */
export function valueOf(context: ToolContext, index: number, path: string): PropValue | undefined {
  let identity = identities.get(context);
  if (!identity) {
    identity = { get keys() { return context.keys; }, label: (i) => context.labelOf(i) };
    identities.set(context, identity);
  }
  return valueAt(context.store, identity, index, path);
}

/** Mots par lesquels on désigne le nom ou l'identifiant d'un élément, quand aucune propriété ne porte ce nom. */
const NAME_WORDS = new Set(['nom', 'name', 'label', 'libelle', 'nom de l’element', "nom de l'element", 'nom affiche', 'element']);
const ID_WORDS = new Set(['id', 'identifiant', 'globalid', 'global id', 'guid', 'cle', 'key', 'ifc id']);

// ------------------------------------------------------------- résolution

/**
 * Retrouve le chemin exact d'une propriété à partir d'un nom approximatif : nom complet, puis
 * sans tenir compte de la casse et des accents, puis dernier segment (« FireRating » pour
 * « Pset_WallCommon / FireRating ») s'il est unique.
 */
export function resolveProperty(store: PropertyStore, name: string): string | { error: string } {
  const paths = store.paths;
  if (paths.includes(name) || isElementField(name)) return name;
  const wanted = fold(toPropertyPath(name));
  const exact = paths.filter((path) => fold(path) === wanted);
  if (exact.length === 1) return exact[0];
  const tails = paths.filter((path) => fold(path.slice(path.lastIndexOf(PATH_SEP) + PATH_SEP.length)) === wanted);
  if (tails.length === 1) return tails[0];
  // Une propriété réelle l'emporte toujours ; sinon « nom » ou « identifiant » désignent l'élément lui-même.
  if (tails.length === 0 && NAME_WORDS.has(wanted)) return ELEMENT_NAME;
  if (tails.length === 0 && ID_WORDS.has(wanted)) return ELEMENT_ID;
  const partial = tails.length > 1 ? tails : paths.filter((path) => fold(path).includes(wanted));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) return { error: `Propriété « ${name} » ambiguë : ${partial.slice(0, 8).join(' ; ')}` };
  return { error: `Propriété « ${name} » introuvable. Utilisez list_properties pour voir les noms exacts ; pour viser un élément par son nom ou son identifiant, utilisez "#nom" ou "#id".` };
}

/** Noms des premiers éléments visés : le modèle vérifie qu'il a pris les bons. */
function namesOf(context: ToolContext, indices: number[], limit = 10): { elements: string[]; more?: number } {
  const elements = indices.slice(0, limit).map((index) => context.labelOf(index));
  return indices.length > limit ? { elements, more: indices.length - limit } : { elements };
}

const NO_MATCH = 'Aucun élément ne vérifie ces filtres. existingValues donne les valeurs présentes des propriétés filtrées : corrige la valeur et réessaie. Un nom d’élément se filtre sur "#nom", un identifiant sur "#id".';
const EXISTING_VALUES = 15;

/**
 * Valeurs présentes des propriétés filtrées, les plus fréquentes d'abord. Renvoyées quand rien ne
 * correspond : le modèle corrige sa valeur (« R1 » au lieu de « Niveau R1 ») sans dépenser un
 * appel de plus en count_by.
 */
function existingValues(store: PropertyStore, filters: ResolvedFilter[]): { existingValues?: Record<string, string[]> } {
  const out: Record<string, string[]> = {};
  for (const { path } of filters) {
    if (isElementField(path) || path in out) continue;
    out[path] = rankedValues(store, path)
      .slice(0, EXISTING_VALUES)
      .map(([label]) => label);
  }
  return Object.keys(out).length > 0 ? { existingValues: out } : {};
}

interface ResolvedFilter {
  path: string;
  filter: RuleCondition;
}

/** Filtres déjà ramenés au schéma par `coerceArgs` : seules les propriétés restent à résoudre. */
function parseFilters(store: PropertyStore, raw: unknown): ResolvedFilter[] | { error: string } {
  const out: ResolvedFilter[] = [];
  for (const { property, op, value } of (raw ?? []) as { property: string; op: RuleOp; value?: PropValue }[]) {
    const path = resolveProperty(store, property);
    if (typeof path !== 'string') return path;
    out.push({ path, filter: { property, op, value: value ?? undefined } });
  }
  return out;
}

/** Formule par élément (compute, set_property) ; null si absente. */
function compileFormula(store: PropertyStore, text: unknown): Expression | null | { error: string } {
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
}

/**
 * Chemin d'une propriété à écrire. Seuls le nom complet (casse et accents ignorés) ou un dernier
 * segment unique désignent une propriété existante, jamais un rapprochement partiel qui écrirait
 * dans un autre champ. Sinon la propriété est créée sous ce nom.
 */
function writablePath(store: PropertyStore, raw: unknown): string | { error: string } {
  const name = toPropertyPath(String(raw ?? ''));
  if (!name) return { error: 'Nom de propriété manquant.' };
  if (isElementField(name)) return { error: `${name} n’est pas une propriété : le nom affiché et l’identifiant ne s’écrivent pas.` };
  let path = name;
  if (!store.paths.includes(name)) {
    const wanted = fold(name);
    const exact = store.paths.filter((candidate) => fold(candidate) === wanted);
    const tails = name.includes(PATH_SEP) ? [] : store.paths.filter((candidate) => candidate.includes(PATH_SEP) && fold(candidate.slice(candidate.lastIndexOf(PATH_SEP) + PATH_SEP.length)) === wanted);
    const found = exact.length > 0 ? exact : tails;
    if (found.length > 1) return { error: `Propriété « ${name} » ambiguë : ${found.slice(0, 8).join(' ; ')}` };
    if (found.length === 1) path = found[0];
  }
  return store.isEditable(path) ? path : { error: `La propriété « ${path} » est verrouillée : elle ne se modifie pas.` };
}

function dayCount(value: unknown, label: string): number {
  if (typeof value !== 'number' || value < 1) throw new Error(`${label} doit être un nombre de jours, au moins 1.`);
  return Math.round(value);
}

/** Nombre tiré de l'identifiant (FNV-1a) : relancer donne les mêmes durées. */
function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

const NO_WRITE = 'La modification des propriétés n’est pas disponible dans ce contexte.';

/**
 * Éléments du périmètre qui vérifient tous les filtres, ramenés aux éléments cités par l'utilisateur
 * quand le filtre attrape aussi leurs homonymes (tous les outils qui prennent des filtres).
 */
function targets(context: ToolContext, filters: ResolvedFilter[], scope: unknown): { indices: number[]; narrowed: number } {
  const base = scope === 'selection' ? [...context.selection] : Array.from({ length: context.count }, (_, i) => i);
  const indices = filters.length === 0 ? base : base.filter((index) => filters.every(({ path, filter }) => matchesCondition(valueOf(context, index, path), filter)));
  return narrowToMentioned(context, filters, indices);
}
const narrowedNote = (narrowed: number) => (narrowed > 0 ? { narrowed: `Réduit à l’identifiant cité par l’utilisateur : ${narrowed} homonyme(s) écarté(s).` } : {});

// ------------------------------------------------------------------- outils

function elementSummary(context: ToolContext, index: number, paths: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { label: context.labelOf(index), id: context.keys[index] };
  for (const path of paths) out[path] = valueOf(context, index, path) ?? null;
  return out;
}

/** Exécute un outil. Les arguments passent d'abord par le schéma (`coerceArgs`) : chat, commandes et agents ont la même tolérance. */
export function runTool(name: string, raw: unknown, context: ToolContext): ToolOutcome {
  if (context.isCurrent?.() === false) return { result: { error: 'Le modèle a changé. Relancez votre demande.' }, note: 'Ancien modèle : opération abandonnée' };
  const checked = coerceArgs(name, raw);
  if ('error' in checked) return { result: { error: checked.error }, note: checked.error };
  try { return executeTool(name, checked.args, context); }
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
      // Le nom et l'identifiant de chaque élément se filtrent aussi : on les rappelle à chaque liste.
      const elementFields = { '#nom': 'nom affiché de l’élément', '#id': 'identifiant de l’élément' };
      return { result: { total, properties, elementFields }, note: `${plural(total, 'propriété')} listée${s(total)}` };
    }

    case 'count_by': {
      const path = resolveProperty(store, String(args.property ?? ''));
      if (typeof path !== 'string') return { result: path, note: path.error };
      if (isElementField(path)) return { result: { error: `${path} distingue chaque élément : utilisez find_elements avec un filtre sur ${path}.` }, note: 'Répartition impossible sur le nom ou l’identifiant' };
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
      for (const item of (args.properties ?? []) as string[]) {
        const path = resolveProperty(store, item);
        if (typeof path === 'string') wanted.push(path);
      }
      for (const { path } of filters) if (!wanted.includes(path)) wanted.push(path);
      const { indices, narrowed } = targets(context, filters, args.scope);
      const limit = Math.min(DETAIL_MAX, Math.max(1, Number(args.limit) || DETAIL_LIMIT));
      const elements = indices.slice(0, limit).map((index) => elementSummary(context, index, wanted));
      return { result: { count: indices.length, shown: elements.length, elements, ...narrowedNote(narrowed), ...(indices.length === 0 ? existingValues(store, filters) : {}) }, note: `${plural(indices.length, 'élément')} trouvé${s(indices.length)}` };
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
      const { indices, narrowed } = targets(context, filters, args.scope);
      const isolate = args.isolate === true;
      if (indices.length === 0) return { result: { count: 0, error: NO_MATCH, ...existingValues(store, filters) }, note: 'Aucun élément concerné' };
      context.select(indices, isolate);
      // Mise en évidence : tout est atténué, puis les éléments visés reprennent leur opacité. Deux règles
      // empilées, reconnaissables à leur identifiant pour pouvoir les retirer. Une cible que les filtres
      // n'expriment pas (éléments cités, sélection) devient une règle par identifiant, au plus HIGHLIGHT_MAX.
      const byId = narrowed > 0 || args.scope === 'selection';
      const highlight = args.highlight === true && context.setAppearanceRules !== undefined && (!byId || indices.length <= HIGHLIGHT_MAX);
      if (highlight) {
        const conditions: RuleCondition[][] = byId
          ? indices.map((index) => [{ property: ELEMENT_ID, op: 'equals', value: context.keys[index] }])
          : [filters.map(({ path, filter }) => ({ property: path, op: filter.op, ...(filter.value !== undefined ? { value: filter.value } : {}) }))];
        const kept = (context.appearanceRules ?? []).filter((rule) => !isHighlightRule(rule.id)).map((rule) => structuredClone(rule));
        context.setAppearanceRules!([
          ...kept,
          { id: HIGHLIGHT_IDS[0], name: 'Mise en évidence : reste atténué', enabled: true, conditions: [], opacity: 0.15 },
          ...conditions.map((list, i): AppearanceRule => ({ id: i === 0 ? HIGHLIGHT_IDS[1] : `${HIGHLIGHT_IDS[1]}-${i + 1}`, name: 'Mise en évidence', enabled: true, conditions: list, opacity: 1 })),
        ]);
      }
      const many = indices.length > 1;
      const verb = isolate ? (many ? 'isolés' : 'isolé') : highlight ? 'mis en évidence' : many ? 'sélectionnés' : 'sélectionné';
      return {
        result: {
          count: indices.length,
          ...namesOf(context, indices),
          isolated: isolate,
          highlighted: highlight,
          ...(highlight ? { rules: (context.appearanceRules ?? []).filter((rule) => isHighlightRule(rule.id)).map((rule) => rule.id) } : {}),
          ...(args.highlight === true && !highlight ? { notHighlighted: `Mise en évidence impossible ici (plus de ${HIGHLIGHT_MAX} éléments hors filtres, ou règles indisponibles) : les éléments sont seulement sélectionnés.` } : {}),
          ...narrowedNote(narrowed),
          next: DONE,
        },
        note: `${plural(indices.length, 'élément')} ${verb}`,
      };
    }

    case 'set_visibility': {
      if (!context.setVisible || !context.showAll) throw new Error('La visibilité n’est pas réglable dans ce contexte.');
      if (args.showAll === true) {
        context.showAll();
        return { result: { shown: context.count }, note: 'Toute la maquette est réaffichée' };
      }
      // Sans visible, « masquer » ou « réafficher » serait deviné : on demande.
      if (typeof args.visible !== 'boolean') return { result: { error: 'Indiquez visible (false pour masquer, true pour réafficher) ou showAll: true.' }, note: 'Masquer ou réafficher ? Non précisé' };
      const filters = parseFilters(store, args.filters);
      if (!Array.isArray(filters)) return { result: filters, note: filters.error };
      const visible = args.visible;
      const { indices, narrowed } = targets(context, filters, args.scope);
      if (indices.length === 0) return { result: { changed: 0, error: NO_MATCH, ...existingValues(store, filters) }, note: 'Aucun élément concerné' };
      context.setVisible(indices, visible);
      return { result: { changed: indices.length, ...namesOf(context, indices), visible, ...narrowedNote(narrowed), next: DONE }, note: `${plural(indices.length, 'élément')} ${visible ? 'réaffiché' : 'masqué'}${s(indices.length)}` };
    }

    case 'compute': {
      const filters = parseFilters(store, args.filters);
      if (!Array.isArray(filters)) return { result: filters, note: filters.error };
      const expression = compileFormula(store, args.expression);
      const where = compileFormula(store, args.where);
      if (expression && 'error' in expression) return { result: expression, note: expression.error };
      if (where && 'error' in where) return { result: where, note: where.error };
      if (!expression && !where) return { result: { error: 'Donnez expression et/ou where.' }, note: 'Formule manquante' };

      const { indices, narrowed } = targets(context, filters, args.scope);
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
      const result: Record<string, unknown> = { elements: indices.length, shown: examples.length, examples, ...narrowedNote(narrowed) };
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
      // Resolve displayed property paths before shared validation; never silently change an ambiguous field.
      const resolve = (name: string): string => {
        const path = resolveProperty(store, name);
        if (typeof path !== 'string') throw new Error(path.error);
        return path;
      };
      // Types, listes et opérateurs sont déjà ramenés au schéma ; restent les noms de propriétés.
      const patched = ((args.rules ?? []) as Record<string, unknown>[]).map((rule) => ({
        ...rule,
        conditions: ((rule.conditions ?? []) as { property: string }[]).map((condition) => ({ ...condition, property: resolve(condition.property) })),
        ...(rule.opacityBy ? { opacityBy: { ...(rule.opacityBy as { property: string }), property: resolve((rule.opacityBy as { property: string }).property) } } : {}),
      }));
      const updates = validateAppearanceRules(patched, store);
      const removed = (args.removeRuleIds ?? []) as string[];
      if (updates.some((rule) => removed.includes(rule.id))) throw new Error('Une règle ne peut pas être retirée et remplacée simultanément.');
      let rules = (context.appearanceRules ?? []).filter((rule) => !removed.includes(rule.id)).map((rule) => structuredClone(rule));
      for (const update of updates) {
        const at = rules.findIndex((rule) => rule.id === update.id);
        if (at === -1) rules.push(update);
        else rules[at] = update;
      }
      if (args.ruleOrder !== undefined) {
        const order = args.ruleOrder as string[];
        if (new Set(order).size !== rules.length || order.length !== rules.length || order.some((id) => !rules.some((rule) => rule.id === id))) {
          throw new Error('ruleOrder doit contenir chaque identifiant restant exactement une fois.');
        }
        rules = order.map((id) => rules.find((rule) => rule.id === id)!);
      }
      let grouping: string[] | undefined;
      if (args.groupBy !== undefined) {
        grouping = [...new Set((args.groupBy as string[]).map(resolve))];
      }
      const changesRules = args.rules !== undefined || args.removeRuleIds !== undefined || args.ruleOrder !== undefined;
      if (!changesRules && grouping === undefined) throw new Error('Indiquez les règles ou le regroupement à modifier.');
      if (changesRules) context.setAppearanceRules(rules);
      if (grouping !== undefined) context.groupBy(grouping);
      return { result: { rules: rules.map((rule) => ({ id: rule.id, enabled: rule.enabled })), groupBy: grouping ?? context.grouping ?? [], next: DONE }, note: 'Présentation mise à jour : règles et regroupement' };
    }

    case 'set_property': {
      if (!context.writeProperties) throw new Error(NO_WRITE);
      const filters = parseFilters(store, args.filters);
      if (!Array.isArray(filters)) return { result: filters, note: filters.error };
      const path = writablePath(store, args.property);
      if (typeof path !== 'string') return { result: path, note: path.error };
      const formula = compileFormula(store, args.expression);
      if (formula && 'error' in formula) return { result: formula, note: formula.error };
      const constant = args.value;
      if (!formula && (constant === undefined || (constant !== null && typeof constant === 'object'))) return { result: { error: 'Donnez value ou expression.' }, note: 'Valeur manquante' };
      const { indices, narrowed } = targets(context, filters, args.scope);
      if (indices.length === 0) return { result: { changed: 0, error: NO_MATCH, ...existingValues(store, filters) }, note: 'Aucun élément concerné' };
      const created = !store.paths.includes(path);
      const updates: [number, string, PropValue][] = [];
      for (const index of indices) {
        // Le type de la propriété en place est gardé : « 12,5 » écrit sur un nombre est un nombre (une valeur inconvertible lève une erreur).
        if (!formula) { updates.push([index, path, coerceTo(ownValue(store.propsOf(index), path), constant as PropValue)]); continue; }
        const value = formula.evaluate((name) => valueOf(context, index, name));
        if (value === null || (typeof value === 'number' && !Number.isFinite(value))) continue;
        updates.push([index, path, typeof value === 'number' ? Number(value.toPrecision(12)) : value]);
      }
      if (updates.length === 0) return { result: { changed: 0, error: 'La formule ne donne aucune valeur pour ces éléments (propriétés absentes ?).' }, note: 'Aucune valeur calculée' };
      const skipped = indices.length - updates.length;
      if (args.dryRun === true) {
        const sample = updates.slice(0, PREVIEW_SAMPLE).map(([index, , value]) => ({ element: context.labelOf(index), before: ownValue(store.propsOf(index), path) ?? null, after: value }));
        return { result: { dryRun: true, property: path, created, count: updates.length, ...(skipped > 0 ? { skipped } : {}), sample, ...narrowedNote(narrowed) }, note: `Aperçu : « ${path} » sur ${plural(updates.length, 'élément')}, rien n’est écrit` };
      }
      const changed = context.writeProperties(updates);
      return {
        result: { property: path, created, count: updates.length, ...(skipped > 0 ? { skipped } : {}), ...(changed ? {} : { unchanged: 'Ces éléments avaient déjà cette valeur.' }), ...namesOf(context, updates.map(([index]) => index)), ...narrowedNote(narrowed), next: DONE },
        note: `« ${path} » ${created ? 'ajoutée' : 'modifiée'} sur ${plural(updates.length, 'élément')}`,
      };
    }

    case 'plan_dates': {
      if (!context.writeProperties) throw new Error(NO_WRITE);
      const filters = parseFilters(store, args.filters);
      if (!Array.isArray(filters)) return { result: filters, note: filters.error };
      const first = parseScheduleDate(args.start);
      const last = parseScheduleDate(args.end);
      if (last < first) throw new Error('La fin du chantier précède son début.');
      const total = last - first + 1;
      const shortest = dayCount(args.minDays, 'minDays');
      const longest = dayCount(args.maxDays, 'maxDays');
      const [minDays, maxDays] = shortest <= longest ? [shortest, longest] : [longest, shortest];
      if (maxDays > total) throw new Error(`maxDays (${maxDays} j) dépasse la durée du chantier (${total} j).`);
      const startPath = writablePath(store, args.startProperty ?? 'Planning / Date début');
      if (typeof startPath !== 'string') return { result: startPath, note: startPath.error };
      const endPath = writablePath(store, args.endProperty ?? 'Planning / Date fin');
      if (typeof endPath !== 'string') return { result: endPath, note: endPath.error };
      if (startPath === endPath) throw new Error('Les propriétés de début et de fin doivent être différentes.');
      const orderBy: string[] = [];
      for (const name of (args.orderBy ?? []) as string[]) {
        const path = resolveProperty(store, name);
        if (typeof path !== 'string') return { result: path, note: path.error };
        orderBy.push(path);
      }
      const rank = new Map<string, number>();
      for (const value of (args.order ?? []) as string[]) if (!rank.has(fold(value))) rank.set(fold(value), rank.size);

      const { indices, narrowed } = targets(context, filters, args.scope);
      indices.sort((a, b) => a - b);
      if (indices.length === 0) return { result: { elements: 0, error: NO_MATCH, ...existingValues(store, filters) }, note: 'Aucun élément concerné' };

      // On construit du bas vers le haut : un étage se place à la hauteur médiane du bas de ses
      // éléments (une fondation ou une poutre isolée ne le déplace pas), quel que soit son nom
      // (GF, 1F, F.G.L, RDC, R+1, L00…). Les éléments d'un même groupe aussi, du plus bas au plus haut.
      const bottom = new Map<number, number>();
      const heightOf = context.heightOf;
      if (heightOf) {
        for (const index of indices) {
          const y = heightOf(index);
          if (y !== undefined && Number.isFinite(y)) bottom.set(index, y);
        }
      }
      const below = (a: number | undefined, b: number | undefined) => (a === b ? 0 : b === undefined || (a !== undefined && a < b) ? -1 : 1);

      const rows = indices.map((index) => orderBy.map((path) => {
        const value = valueOf(context, index, path);
        return isMissing(value) ? UNDEFINED_LABEL : formatValue(value);
      }));
      const levelBottoms = new Map<string, number[]>();
      indices.forEach((index, i) => {
        const level = rows[i][0], y = bottom.get(index);
        if (level === undefined || level === UNDEFINED_LABEL || y === undefined) return;
        const list = levelBottoms.get(level);
        if (list) list.push(y);
        else levelBottoms.set(level, [y]);
      });
      const levelHeight = new Map([...levelBottoms].map(([level, list]) => [level, list.sort((a, b) => a - b)[Math.floor((list.length - 1) / 2)]]));
      // Un élément sans valeur rejoint l'étage sur lequel il est posé (le plus haut qui ne dépasse
      // pas son bas) plutôt que d'attendre la fin du chantier ; sans géométrie, il reste en dernier.
      const floors = [...levelHeight].sort((a, b) => a[1] - b[1]);
      let placed = 0;
      indices.forEach((index, i) => {
        const y = bottom.get(index);
        if (rows[i][0] !== UNDEFINED_LABEL || y === undefined || floors.length === 0) return;
        let floor = floors[0][0];
        for (const [level, height] of floors) if (height <= y) floor = level;
        rows[i][0] = floor;
        placed++;
      });

      // Un groupe par combinaison de valeurs d'orderBy, rangés dans l'ordre de construction : order
      // (dicté par l'utilisateur) d'abord pour la première propriété, puis la hauteur, puis l'ordre
      // naturel ; valeurs absentes en dernier.
      const groups = new Map<string, { values: string[]; members: number[] }>();
      indices.forEach((index, i) => {
        const key = rows[i].join('\u0000');
        const group = groups.get(key);
        if (group) group.members.push(index);
        else groups.set(key, { values: rows[i], members: [index] });
      });
      const rankOf = (value: string) => (value === UNDEFINED_LABEL ? Infinity : rank.get(fold(value)) ?? rank.size);
      const ordered = [...groups.values()].sort((a, b) => {
        for (let i = 0; i < a.values.length; i++) {
          const diff = (i === 0 ? rankOf(a.values[0]) - rankOf(b.values[0]) || below(levelHeight.get(a.values[0]), levelHeight.get(b.values[0])) : 0)
            || compareValues(a.values[i], b.values[i]);
          if (diff) return diff;
        }
        return 0;
      });
      for (const group of ordered) group.members.sort((a, b) => below(bottom.get(a), bottom.get(b)) || a - b);

      // Les éléments s'enchaînent dans l'ordre des groupes, à intervalles réguliers sur tout le
      // chantier : le premier commence au début, le dernier finit à la fin, et un groupe dure à
      // proportion de son nombre d'éléments. Les départs ne reculent jamais, donc un groupe ne
      // commence pas avant le précédent. Chaque durée est tirée de l'identifiant de l'élément.
      const updates: [number, string, PropValue][] = [];
      const periods: { value: string; elements: number; from: string; to: string }[] = [];
      const gaps = Math.max(1, indices.length - 1);
      let j = 0;
      let finish = first;
      for (const group of ordered) {
        let from = Infinity;
        let to = -Infinity;
        for (const index of group.members) {
          const duration = minDays + (stableHash(context.keys[index] ?? String(index)) % (maxDays - minDays + 1));
          const start = j > 0 && j === indices.length - 1 ? last - duration + 1 : first + Math.floor((j * (total - maxDays)) / gaps);
          const end = start + duration - 1;
          updates.push([index, startPath, formatScheduleDate(start)], [index, endPath, formatScheduleDate(end)]);
          from = Math.min(from, start);
          to = Math.max(to, end);
          j++;
        }
        finish = Math.max(finish, to);
        periods.push({ value: group.values.join(' · ') || 'tous', elements: group.members.length, from: formatScheduleDate(from), to: formatScheduleDate(to) });
      }
      const summary = {
        elements: indices.length, startProperty: startPath, endProperty: endPath,
        from: formatScheduleDate(first), to: formatScheduleDate(finish),
        ...(orderBy.length > 0 ? { orderBy } : {}),
        ...(bottom.size > 0 ? { sequence: `${rank.size > 0 ? 'Ordre dicté, puis d' : 'D'}u plus bas au plus haut, d’après la maquette.` } : {}),
        ...(placed > 0 ? { placedByHeight: `Sans « ${orderBy[0]} », ${plural(placed, 'élément')} : chacun rangé avec l’étage où il se trouve.` } : {}),
        periods: periods.slice(0, 30), ...(periods.length > 30 ? { morePeriods: periods.length - 30 } : {}),
        ...narrowedNote(narrowed),
      };
      if (args.dryRun === true) return { result: { dryRun: true, ...summary }, note: `Aperçu : dates sur ${plural(indices.length, 'élément')} (${plural(periods.length, 'période')}), rien n’est écrit` };
      const changed = context.writeProperties(updates);
      let planning: Record<string, unknown> = { opened: false };
      if (context.openPlanning) {
        try {
          planning = { opened: true, tasks: context.openPlanning(startPath, endPath) };
        } catch (error) {
          planning = { opened: false, error: error instanceof Error ? error.message : String(error) };
        }
      }
      return {
        result: { ...summary, ...(changed ? {} : { unchanged: 'Ces dates étaient déjà écrites.' }), planning, next: DONE },
        note: `Dates de planning écrites sur ${plural(indices.length, 'élément')} (${plural(periods.length, 'période')})`,
      };
    }

    default:
      return { result: { error: `Outil inconnu : ${name}` }, note: `Outil inconnu : ${name}` };
  }
}
