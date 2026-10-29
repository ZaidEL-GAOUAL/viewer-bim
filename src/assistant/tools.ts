// Outils mis à disposition du LLM. Ils tournent dans le navigateur, sur les données déjà
// chargées : le modèle n'en reçoit que les résultats, jamais le fichier entier.

import { PATH_SEP, UNDEFINED_LABEL, compareValues, formatValue, ownValue, type PropValue, type PropertyStore } from '../data/metadata.ts';
import { formatScheduleDate, parseScheduleDate } from '../data/schedule.ts';
import { numericValue, validateAppearanceRules, type AppearanceRule, type RuleCondition } from '../data/appearanceRules.ts';
import { ELEMENT_ID, ELEMENT_NAME, isElementField } from '../data/elementFields.ts';
import { ExpressionError, compileExpression, type Expression, type Value } from './expression.ts';

export type FilterOp = 'equals' | 'not_equals' | 'contains' | 'missing' | 'present' | 'greater' | 'less' | 'greater_or_equal' | 'less_or_equal';
const FILTER_OPS: readonly string[] = ['equals', 'not_equals', 'contains', 'missing', 'present', 'greater', 'less', 'greater_or_equal', 'less_or_equal'];
/** Opérateurs écrits en symboles par certains modèles (« = », « >= ») : ramenés aux noms attendus. */
const OP_ALIASES: Record<string, string> = { '=': 'equals', '==': 'equals', '!=': 'not_equals', '<>': 'not_equals', '>': 'greater', '<': 'less', '>=': 'greater_or_equal', '<=': 'less_or_equal' };
const opOf = (raw: unknown): string => { const op = String(raw ?? 'equals').trim(); return OP_ALIASES[op] ?? op; };

export interface Filter {
  property: string;
  op: FilterOp;
  value?: PropValue;
}

/** Tools read metadata, change presentation and write properties (undoable). No geometry access. */
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
  description: 'Filtres combinés par ET : {property, op, value}. op : equals, not_equals, contains, missing, present, greater, less, greater_or_equal, less_or_equal. Liste vide = tous. property peut aussi être "#nom" (nom affiché de l’élément) ou "#id" (son identifiant).',
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
      description: 'Sélectionne et cadre dans la vue 3D les éléments vérifiant les filtres. isolate=true : n’affiche que ces éléments, le reste devient invisible (« n’affiche que X », « masque tout sauf X »). highlight=true : met en évidence (« mets en évidence X », « fais ressortir X ») : surbrillance et le reste atténué.',
      parameters: {
        type: 'object',
        properties: {
          filters: FILTERS,
          scope: SCOPE,
          isolate: { type: 'boolean', description: 'N’afficher que ces éléments ; le reste est masqué.' },
          highlight: { type: 'boolean', description: 'Mettre en évidence : le reste de la maquette est atténué (opacité 0,15).' },
        },
        required: ['filters'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_visibility',
      description: 'Masque (visible=false) ou réaffiche (visible=true) les éléments vérifiant les filtres, sans changer la sélection ; showAll=true réaffiche toute la maquette. Pour « n’afficher que X », préférer select_elements avec isolate=true.',
      parameters: {
        type: 'object',
        properties: {
          filters: FILTERS,
          scope: SCOPE,
          visible: { type: 'boolean', description: 'false pour masquer, true pour réafficher.' },
          showAll: { type: 'boolean', description: 'true : tout réafficher (les filtres sont ignorés).' },
        },
        required: ['filters'],
      },
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
  {
    type: 'function', function: {
      name: 'set_property',
      description: 'Ajoute ou modifie une propriété des éléments vérifiant les filtres. La propriété est créée si elle n’existe pas ; dans une catégorie, écrire « Catégorie / Nom ». value : la même valeur pour tous ; expression : formule calculée par élément, comme compute ([Longueur] * 2). Modification annulable par l’utilisateur.',
      parameters: {
        type: 'object',
        properties: {
          filters: FILTERS,
          scope: SCOPE,
          property: { type: 'string', description: 'Nom de la propriété à écrire.' },
          value: { type: 'string', description: 'Valeur à écrire (texte, nombre ou booléen).' },
          expression: { type: 'string', description: 'Formule par élément, à la place de value.' },
        },
        required: ['filters', 'property'],
      },
    },
  },
  {
    type: 'function', function: {
      name: 'plan_dates',
      description: 'Planning prévisionnel : écrit une date de début et une date de fin (AAAA-MM-JJ) sur chaque élément visé, puis ouvre le Planning 4D. Les éléments s’enchaînent dans l’ordre d’orderBy (ex. le code étage), répartis régulièrement de start (premier début) à end (dernière fin) ; chaque élément dure entre minDays et maxDays jours. Annulable par l’utilisateur.',
      parameters: {
        type: 'object',
        properties: {
          filters: FILTERS,
          scope: SCOPE,
          start: { type: 'string', description: 'Début du chantier, AAAA-MM-JJ.' },
          end: { type: 'string', description: 'Fin du chantier, AAAA-MM-JJ.' },
          minDays: { type: 'number', description: 'Durée minimale d’un élément, en jours.' },
          maxDays: { type: 'number', description: 'Durée maximale d’un élément, en jours.' },
          orderBy: { type: 'array', description: 'Propriétés qui ordonnent les tâches, la première d’abord.', items: { type: 'string', description: 'Nom de propriété.' } },
          order: { type: 'array', description: 'Valeurs de la première propriété d’orderBy dans l’ordre de construction, du plus bas au plus haut (ex. SS1, RDC, R+1). Sans order : ordre naturel (00, 01, 02…). Valeurs absentes en dernier.', items: { type: 'string', description: 'Valeur.' } },
          startProperty: { type: 'string', description: 'Propriété de début (défaut « Planning / Date début »).' },
          endProperty: { type: 'string', description: 'Propriété de fin (défaut « Planning / Date fin »).' },
        },
        required: ['start', 'end', 'minDays', 'maxDays'],
      },
    },
  },
];

/** Règles posées par « mettre en évidence », dans cet ordre : atténuation générale, puis les éléments visés. */
export const HIGHLIGHT_IDS: readonly string[] = ['assistant-dim-others', 'assistant-highlight'];
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
const DONE = 'Action faite. Réponds maintenant à l’utilisateur, sans autre appel, sauf si sa demande comporte une autre action distincte.';

const DETAIL_LIMIT = 20;
const DETAIL_MAX = 50;
const COUNT_LIMIT = 40;

/** Metadata only: computed geometry is intentionally unavailable to the assistant. */
export function valueOf(context: ToolContext, index: number, path: string): PropValue | undefined {
  if (path === ELEMENT_NAME) return context.labelOf(index);
  if (path === ELEMENT_ID) return context.keys[index];
  return ownValue(context.store.propsOf(index), path);
}

/** Mots par lesquels on désigne le nom ou l'identifiant d'un élément, quand aucune propriété ne porte ce nom. */
const NAME_WORDS = new Set(['nom', 'name', 'label', 'libelle', 'nom de l’element', "nom de l'element", 'nom affiche', 'element']);
const ID_WORDS = new Set(['id', 'identifiant', 'globalid', 'global id', 'guid', 'cle', 'key', 'ifc id']);

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
  if (paths.includes(name) || isElementField(name)) return name;
  const wanted = fold(name.replace(/\s*\/\s*/g, PATH_SEP));
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
    out[path] = [...store.groups(path).entries()]
      .filter(([label]) => label !== UNDEFINED_LABEL)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, EXISTING_VALUES)
      .map(([label]) => label);
  }
  return Object.keys(out).length > 0 ? { existingValues: out } : {};
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
    case 'less':
    case 'greater_or_equal':
    case 'less_or_equal': {
      const a = numericValue(value);
      const b = numericValue(filter.value);
      if (a === undefined || b === undefined) return false;
      if (filter.op === 'greater') return a > b;
      if (filter.op === 'less') return a < b;
      return filter.op === 'greater_or_equal' ? a >= b : a <= b;
    }
    default:
      return false;
  }
}

interface ResolvedFilter {
  path: string;
  filter: Filter;
}

/**
 * Booléen d'un argument d'outil. Certains modèles (Llama 3.3 en particulier) envoient « "true" » en
 * texte : comparé à `true`, il était ignoré, et « n'affiche que X » ne faisait que sélectionner X.
 */
function flag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return undefined;
  const text = fold(value);
  if (['true', '1', 'oui', 'vrai', 'yes'].includes(text)) return true;
  if (['false', '0', 'non', 'faux', 'no'].includes(text)) return false;
  return undefined;
}

/**
 * Une liste attendue, telle que les modèles l'envoient parfois : en texte JSON, ou réduite à son
 * seul élément ({property, op, value} au lieu de [{…}], "Niveau" au lieu de ["Niveau"]).
 */
function asList(raw: unknown): unknown {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      // un texte simple : un seul élément
    }
  }
  return value === undefined || value === null || value === '' || Array.isArray(value) ? value : [value];
}

/** Périmètre « selection », même écrit « sélection » ou « Selection ». */
const inSelection = (scope: unknown): boolean => typeof scope === 'string' && fold(scope) === 'selection';

function parseFilters(store: PropertyStore, rawFilters: unknown): ResolvedFilter[] | { error: string } {
  const raw = asList(rawFilters);
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw)) return { error: 'filters doit être une liste.' };
  const out: ResolvedFilter[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return { error: 'Chaque filtre doit être un objet {property, op, value}.' };
    const record = item as Record<string, unknown>;
    const property = typeof record.property === 'string' ? record.property : '';
    const op = opOf(record.op) as FilterOp;
    if (!FILTER_OPS.includes(op)) return { error: `Opérateur inconnu : ${op}` };
    const path = resolveProperty(store, property);
    if (typeof path !== 'string') return path;
    const value = record.value;
    out.push({ path, filter: { property, op, value: value === undefined || value === null ? undefined : (value as PropValue) } });
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
  const name = String(raw ?? '').trim().replace(/\s*\/\s*/g, PATH_SEP);
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

/** Jour d'une date AAAA-MM-JJ, ou JJ/MM/AAAA comme on l'écrit en français. */
function dayOf(raw: unknown, label: string): number {
  const text = String(raw ?? '').trim();
  const french = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  try {
    return parseScheduleDate(french ? `${french[3]}-${french[2].padStart(2, '0')}-${french[1].padStart(2, '0')}` : text);
  } catch {
    throw new Error(`${label} : date « ${text} » illisible, attendu AAAA-MM-JJ.`);
  }
}

function dayCount(raw: unknown, label: string): number {
  const value = Number(typeof raw === 'string' ? raw.replace(',', '.') : raw);
  if (!Number.isFinite(value) || value < 1) throw new Error(`${label} doit être un nombre de jours, au moins 1.`);
  return Math.round(value);
}

/** Nombre tiré de l'identifiant (FNV-1a) : relancer donne les mêmes durées. */
function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return hash >>> 0;
}

const NO_WRITE = 'La modification des propriétés n’est pas disponible dans ce contexte.';

/** Indices des éléments du périmètre qui vérifient tous les filtres. */
export function selectIndices(context: ToolContext, filters: ResolvedFilter[], scope: unknown): number[] {
  const base = inSelection(scope) ? [...context.selection] : Array.from({ length: context.count }, (_, i) => i);
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
      // Le nom et l'identifiant de chaque élément se filtrent aussi : on les rappelle à chaque liste.
      const elementFields = { '#nom': 'nom affiché de l’élément', '#id': 'identifiant de l’élément' };
      return { result: { total, properties, elementFields }, note: `${plural(total, 'propriété')} listée${total > 1 ? 's' : ''}` };
    }

    case 'count_by': {
      const path = resolveProperty(store, String(args.property ?? ''));
      if (typeof path !== 'string') return { result: path, note: path.error };
      if (isElementField(path)) return { result: { error: `${path} distingue chaque élément : utilisez find_elements avec un filtre sur ${path}.` }, note: 'Répartition impossible sur le nom ou l’identifiant' };
      const scope = inSelection(args.scope) ? context.selection : null;
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
      return { result: { count: indices.length, shown: elements.length, elements, ...(indices.length === 0 ? existingValues(store, filters) : {}) }, note: `${plural(indices.length, 'élément')} trouvé${indices.length > 1 ? 's' : ''}` };
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
      const narrowing = narrowToMentioned(context, filters, selectIndices(context, filters, args.scope));
      const indices = narrowing.indices;
      const isolate = flag(args.isolate) === true;
      const highlight = flag(args.highlight) === true;
      if (indices.length === 0) return { result: { count: 0, error: NO_MATCH, ...existingValues(store, filters) }, note: 'Aucun élément concerné' };
      context.select(indices, isolate);
      let dimmed = false;
      if (highlight && context.setAppearanceRules && !inSelection(args.scope)) {
        // Mise en évidence : tout est atténué, puis les éléments visés reprennent leur opacité.
        // Deux règles empilées, reconnaissables à leur identifiant pour pouvoir les retirer.
        // Cible réduite aux éléments cités : une règle par identifiant (les conditions se combinent par ET).
        const targets: RuleCondition[][] = narrowing.narrowed > 0
          ? indices.map((index) => [{ property: ELEMENT_ID, op: 'equals', value: context.keys[index] }])
          : [filters.map(({ path, filter }) => ({ property: path, op: filter.op, ...(filter.value !== undefined ? { value: filter.value } : {}) }))];
        const kept = (context.appearanceRules ?? []).filter((rule) => !isHighlightRule(rule.id)).map((rule) => structuredClone(rule));
        context.setAppearanceRules([
          ...kept,
          { id: HIGHLIGHT_IDS[0], name: 'Mise en évidence : reste atténué', enabled: true, conditions: [], opacity: 0.15 },
          ...targets.map((conditions, i): AppearanceRule => ({ id: i === 0 ? HIGHLIGHT_IDS[1] : `${HIGHLIGHT_IDS[1]}-${i + 1}`, name: 'Mise en évidence', enabled: true, conditions, opacity: 1 })),
        ]);
        dimmed = true;
      }
      const many = indices.length > 1;
      const verb = isolate ? (many ? 'isolés' : 'isolé') : highlight ? 'mis en évidence' : many ? 'sélectionnés' : 'sélectionné';
      return {
        result: {
          count: indices.length,
          ...namesOf(context, indices),
          isolated: isolate,
          highlighted: highlight,
          ...(dimmed ? { rules: (context.appearanceRules ?? []).filter((rule) => isHighlightRule(rule.id)).map((rule) => rule.id) } : {}),
          ...(narrowing.narrowed > 0 ? { narrowed: `Réduit à l’identifiant cité par l’utilisateur : ${narrowing.narrowed} homonyme(s) écarté(s).` } : {}),
          next: DONE,
        },
        note: `${plural(indices.length, 'élément')} ${verb}`,
      };
    }

    case 'set_visibility': {
      if (!context.setVisible || !context.showAll) throw new Error('La visibilité n’est pas réglable dans ce contexte.');
      if (flag(args.showAll) === true) {
        context.showAll();
        return { result: { shown: context.count }, note: 'Toute la maquette est réaffichée' };
      }
      const filters = parseFilters(store, args.filters);
      if (!Array.isArray(filters)) return { result: filters, note: filters.error };
      const visible = flag(args.visible) !== false;
      const narrowing = narrowToMentioned(context, filters, selectIndices(context, filters, args.scope));
      const indices = narrowing.indices;
      if (indices.length === 0) return { result: { changed: 0, error: NO_MATCH, ...existingValues(store, filters) }, note: 'Aucun élément concerné' };
      context.setVisible(indices, visible);
      return { result: { changed: indices.length, ...namesOf(context, indices), visible, ...(narrowing.narrowed > 0 ? { narrowed: `Réduit à l’identifiant cité par l’utilisateur : ${narrowing.narrowed} homonyme(s) écarté(s).` } : {}), next: DONE }, note: `${plural(indices.length, 'élément')} ${visible ? 'réaffiché' : 'masqué'}${indices.length > 1 ? 's' : ''}` };
    }

    case 'compute': {
      const filters = parseFilters(store, args.filters);
      if (!Array.isArray(filters)) return { result: filters, note: filters.error };
      const expression = compileFormula(store, args.expression);
      const where = compileFormula(store, args.where);
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
        // Mêmes écarts des modèles que pour les autres outils : booléen ou nombre en texte, liste
        // réduite à un élément, opérateur en symbole. Une règle ajoutée sans « enabled » est active.
        rule.enabled = rule.enabled === undefined ? true : flag(rule.enabled) ?? rule.enabled;
        if (typeof rule.opacity === 'string' && rule.opacity.trim() !== '' && Number.isFinite(Number(rule.opacity))) rule.opacity = Number(rule.opacity);
        const conditions = asList(rule.conditions);
        if (Array.isArray(conditions)) rule.conditions = conditions.map((condition: unknown) => {
          if (!condition || typeof condition !== 'object' || Array.isArray(condition)) throw new Error('Condition illisible.');
          const c = condition as Record<string, unknown>;
          return { ...c, property: resolve(c.property), op: opOf(c.op) };
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
      const indices = selectIndices(context, filters, args.scope);
      if (indices.length === 0) return { result: { changed: 0, error: NO_MATCH, ...existingValues(store, filters) }, note: 'Aucun élément concerné' };
      const created = !store.paths.includes(path);
      const updates: [number, string, PropValue][] = [];
      for (const index of indices) {
        if (!formula) { updates.push([index, path, constant as PropValue]); continue; }
        const value = formula.evaluate((name) => valueOf(context, index, name));
        if (value === null || (typeof value === 'number' && !Number.isFinite(value))) continue;
        updates.push([index, path, typeof value === 'number' ? Number(value.toPrecision(12)) : value]);
      }
      if (updates.length === 0) return { result: { changed: 0, error: 'La formule ne donne aucune valeur pour ces éléments (propriétés absentes ?).' }, note: 'Aucune valeur calculée' };
      const changed = context.writeProperties(updates);
      const skipped = indices.length - updates.length;
      return {
        result: { property: path, created, count: updates.length, ...(skipped > 0 ? { skipped } : {}), ...(changed ? {} : { unchanged: 'Ces éléments avaient déjà cette valeur.' }), ...namesOf(context, updates.map(([index]) => index)), next: DONE },
        note: `« ${path} » ${created ? 'ajoutée' : 'modifiée'} sur ${plural(updates.length, 'élément')}`,
      };
    }

    case 'plan_dates': {
      if (!context.writeProperties) throw new Error(NO_WRITE);
      const filters = parseFilters(store, args.filters);
      if (!Array.isArray(filters)) return { result: filters, note: filters.error };
      const first = dayOf(args.start, 'start');
      const last = dayOf(args.end, 'end');
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
      const requested = asList(args.orderBy);
      for (const name of Array.isArray(requested) ? requested : []) {
        const path = resolveProperty(store, String(name));
        if (typeof path !== 'string') return { result: path, note: path.error };
        orderBy.push(path);
      }
      const listed = asList(args.order);
      const rank = new Map<string, number>();
      for (const value of Array.isArray(listed) ? listed : []) if (!rank.has(fold(String(value)))) rank.set(fold(String(value)), rank.size);

      const indices = selectIndices(context, filters, args.scope).sort((a, b) => a - b);
      if (indices.length === 0) return { result: { elements: 0, error: NO_MATCH, ...existingValues(store, filters) }, note: 'Aucun élément concerné' };

      // Un groupe par combinaison de valeurs d'orderBy, rangés dans l'ordre de construction :
      // order d'abord pour la première propriété, puis l'ordre naturel ; valeurs absentes en dernier.
      const groups = new Map<string, { values: string[]; members: number[] }>();
      for (const index of indices) {
        const values = orderBy.map((path) => {
          const value = valueOf(context, index, path);
          return isMissing(value) ? UNDEFINED_LABEL : formatValue(value);
        });
        const key = values.join('\u0000');
        const group = groups.get(key);
        if (group) group.members.push(index);
        else groups.set(key, { values, members: [index] });
      }
      const rankOf = (value: string) => (value === UNDEFINED_LABEL ? Infinity : rank.get(fold(value)) ?? rank.size);
      const ordered = [...groups.values()].sort((a, b) => {
        for (let i = 0; i < a.values.length; i++) {
          const diff = (i === 0 ? rankOf(a.values[0]) - rankOf(b.values[0]) : 0) || compareValues(a.values[i], b.values[i]);
          if (diff) return diff;
        }
        return 0;
      });

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
        result: {
          elements: indices.length, startProperty: startPath, endProperty: endPath,
          from: formatScheduleDate(first), to: formatScheduleDate(finish),
          ...(orderBy.length > 0 ? { orderBy } : {}),
          periods: periods.slice(0, 30), ...(periods.length > 30 ? { morePeriods: periods.length - 30 } : {}),
          ...(changed ? {} : { unchanged: 'Ces dates étaient déjà écrites.' }),
          planning, next: DONE,
        },
        note: `Dates de planning écrites sur ${plural(indices.length, 'élément')} (${plural(periods.length, 'période')})`,
      };
    }

    default:
      return { result: { error: `Outil inconnu : ${name}` }, note: `Outil inconnu : ${name}` };
  }
}
