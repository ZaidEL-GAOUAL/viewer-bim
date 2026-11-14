// Définitions des outils : une seule source pour la validation des arguments, le message système
// et l'API des agents. `coerceArgs` lit le schéma pour accepter ce que les modèles envoient de
// travers (booléen ou nombre en texte, liste réduite à un élément, opérateur en symbole, date à la
// française) et refuser le reste avec un message exact, renvoyé tel quel au modèle.

import { RULE_OPS, numericValue } from '../data/conditions.ts';
import { isRecord } from '../data/json.ts';
import { formatScheduleDate, parseScheduleDate } from '../data/schedule.ts';
import { fold } from '../data/text.ts';

export interface Schema {
  type?: string | readonly string[];
  description?: string;
  enum?: readonly string[];
  default?: unknown;
  format?: 'date';
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: readonly string[];
}

export interface ToolDefinition {
  type: 'function';
  function: { name: string; description: string; parameters: Schema & { type: 'object'; properties: Record<string, Schema> } };
}

const SCALAR = ['string', 'number', 'boolean', 'null'] as const;
const CONDITION: Schema = {
  type: 'object',
  description: 'Filtre {property, op, value}.',
  properties: {
    property: { type: 'string', description: 'Propriété, ou "#nom" / "#id".' },
    op: { type: 'string', enum: RULE_OPS, default: 'equals', description: 'Opérateur (equals par défaut).' },
    value: { type: SCALAR, description: 'Valeur comparée.' },
  },
  required: ['property'],
};
const FILTERS: Schema = {
  type: 'array',
  description: 'Filtres combinés par ET : {property, op, value}. op : equals, not_equals, contains, missing, present, greater, less, greater_or_equal, less_or_equal. Liste vide = tous. property peut aussi être "#nom" (nom affiché de l’élément) ou "#id" (son identifiant).',
  items: CONDITION,
};
const SCOPE: Schema = { type: 'string', enum: ['model', 'selection'], description: '"model" (défaut) ou "selection" (éléments sélectionnés).' };
const NAMES = (description: string): Schema => ({ type: 'array', description, items: { type: 'string', description: 'Nom de propriété.' } });
const DRY_RUN: Schema = { type: 'boolean', description: 'true : calcule et renvoie un aperçu sans rien écrire.' };
const RULE: Schema = {
  type: 'object',
  description: '{id,name?,enabled:true,conditions:[{property,op,value?,numericScale?}],color?:"#rrggbb",opacity?:0..1,opacityBy?:{property,scale:"percent"|"fraction"}}. Conditions ET, vide=tous. op: equals,not_equals,contains,missing,present,greater,less,greater_or_equal,less_or_equal. opacityBy percent:100→1,50→0.5; fraction:1→1,0.5→0.5. Choisir opacity ou opacityBy.',
  properties: {
    id: { type: 'string', description: 'Identifiant de la règle.' },
    name: { type: 'string', description: 'Nom affiché.' },
    enabled: { type: 'boolean', default: true, description: 'Active (true par défaut).' },
    conditions: { type: 'array', description: 'Conditions combinées par ET ; vide = tous.', items: { ...CONDITION, properties: { ...CONDITION.properties, numericScale: { type: 'string', enum: ['number', 'percent', 'fraction'], description: 'Lecture des nombres.' } } } },
    color: { type: 'string', description: 'Couleur #rrggbb.' },
    opacity: { type: 'number', description: 'Opacité de 0 à 1.' },
    opacityBy: { type: 'object', description: 'Opacité lue dans une propriété.', properties: { property: { type: 'string', description: 'Propriété numérique.' }, scale: { type: 'string', enum: ['percent', 'fraction'], description: 'percent : 0–100 ; fraction : 0–1.' } }, required: ['property', 'scale'] },
  },
  required: ['id'],
};

const tool = (name: string, description: string, properties: Record<string, Schema> = {}, required: string[] = []): ToolDefinition =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, ...(required.length > 0 ? { required } : {}) } } });

/** Format OpenAI (nom, description, schéma JSON des arguments) : compris par les fournisseurs, les agents et WebMCP. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  tool('list_properties', 'Propriétés du modèle avec leur nombre de valeurs distinctes.', { search: { type: 'string', description: 'Texte cherché dans les noms (facultatif).' } }),
  tool('count_by', 'Répartition des éléments par valeur d’une propriété.', { property: { type: 'string', description: 'Nom de la propriété.' }, scope: SCOPE }, ['property']),
  tool('find_elements', 'Éléments vérifiant les filtres : total et premiers éléments avec les propriétés demandées.', {
    filters: FILTERS,
    properties: NAMES('Propriétés à renvoyer (facultatif).'),
    scope: SCOPE,
    limit: { type: 'number', description: 'Éléments détaillés (défaut 20, max 50).' },
  }, ['filters']),
  tool('get_element', 'Toutes les propriétés d’un élément, par nom ou identifiant (même partiel).', { query: { type: 'string', description: 'Nom ou identifiant.' } }, ['query']),
  tool('select_elements', 'Sélectionne et cadre dans la vue 3D les éléments vérifiant les filtres. isolate=true : n’affiche que ces éléments, le reste devient invisible (« n’affiche que X », « masque tout sauf X »). highlight=true : met en évidence (« mets en évidence X », « fais ressortir X ») : surbrillance et le reste atténué.', {
    filters: FILTERS,
    scope: SCOPE,
    isolate: { type: 'boolean', description: 'N’afficher que ces éléments ; le reste est masqué.' },
    highlight: { type: 'boolean', description: 'Mettre en évidence : le reste de la maquette est atténué (opacité 0,15).' },
  }, ['filters']),
  tool('set_visibility', 'Masque (visible=false) ou réaffiche (visible=true) les éléments vérifiant les filtres, sans changer la sélection ; showAll=true réaffiche toute la maquette. Pour « n’afficher que X », préférer select_elements avec isolate=true.', {
    filters: FILTERS,
    scope: SCOPE,
    visible: { type: 'boolean', description: 'false pour masquer, true pour réafficher (obligatoire sans showAll).' },
    showAll: { type: 'boolean', description: 'true : tout réafficher (les filtres sont ignorés).' },
  }, ['filters']),
  tool('compute', 'Calcule une formule sur chaque élément vérifiant les filtres (le viewer fait le calcul, pas toi) : somme, moyenne, min, max, et les éléments où une condition est vraie. Propriétés entre crochets : [Qto_WallBaseQuantities / NetVolume] - [Length] * [Height] * 0.2 ; condition : [LoadBearing] == true and [FireRating] == null. Opérateurs : + - * / < <= > >= == != and or not, abs() min() max() round().', {
    filters: FILTERS,
    scope: SCOPE,
    expression: { type: 'string', description: 'Formule numérique par élément (facultatif si where est donné).' },
    where: { type: 'string', description: 'Condition par élément ; renvoie les éléments où elle est vraie (facultatif).' },
  }, ['filters']),
  tool('get_view_settings', 'Règles de couleur/opacité actives et regroupement de l’arborescence, dans leur ordre.'),
  tool('update_view', 'Change seulement la présentation. Ajoute/remplace des règles par id, retire des ids, réordonne la pile et/ou regroupe l’arbre. Dernière règle correspondante prioritaire, séparément pour couleur et opacité. Les propriétés et la géométrie ne changent pas.', {
    rules: { type: 'array', description: 'Règles à ajouter/remplacer ; les autres restent.', items: RULE },
    removeRuleIds: { type: 'array', description: 'Identifiants des règles à retirer.', items: { type: 'string', description: 'Identifiant de règle.' } },
    ruleOrder: { type: 'array', description: 'Tous les ids restants dans l’ordre souhaité ; dernier prioritaire.', items: { type: 'string', description: 'Identifiant de règle.' } },
    groupBy: { type: 'array', description: 'Propriétés formant la hiérarchie de l’arbre, dans l’ordre ; [] pour supprimer le regroupement.', items: { type: 'string', description: 'Nom exact d’une propriété.' } },
  }),
  tool('set_property', 'Ajoute ou modifie une propriété des éléments vérifiant les filtres. La propriété est créée si elle n’existe pas ; dans une catégorie, écrire « Catégorie / Nom ». value : la même valeur pour tous ; expression : formule calculée par élément, comme compute ([Longueur] * 2). Modification annulable par l’utilisateur.', {
    filters: FILTERS,
    scope: SCOPE,
    property: { type: 'string', description: 'Nom de la propriété à écrire.' },
    value: { type: SCALAR, description: 'Valeur à écrire (texte, nombre ou booléen).' },
    expression: { type: 'string', description: 'Formule par élément, à la place de value.' },
    dryRun: DRY_RUN,
  }, ['filters', 'property']),
  tool('plan_dates', 'Planning prévisionnel : écrit une date de début et une date de fin (AAAA-MM-JJ) sur chaque élément visé, puis ouvre le Planning 4D. Les éléments s’enchaînent groupe par groupe d’orderBy (ex. le niveau ou code étage), du plus bas au plus haut d’après la maquette quels que soient les noms, répartis régulièrement de start (premier début) à end (dernière fin) ; chaque élément dure entre minDays et maxDays jours. Annulable par l’utilisateur.', {
    filters: FILTERS,
    scope: SCOPE,
    start: { type: 'string', format: 'date', description: 'Début du chantier, AAAA-MM-JJ.' },
    end: { type: 'string', format: 'date', description: 'Fin du chantier, AAAA-MM-JJ.' },
    minDays: { type: 'number', description: 'Durée minimale d’un élément, en jours.' },
    maxDays: { type: 'number', description: 'Durée maximale d’un élément, en jours.' },
    orderBy: NAMES('Propriétés qui ordonnent les tâches, la première d’abord.'),
    order: { type: 'array', description: 'Seulement si l’utilisateur a dicté lui-même l’ordre des valeurs de la première propriété d’orderBy ; ne le devine jamais. Sans order, l’outil range les groupes du plus bas au plus haut d’après la maquette.', items: { type: 'string', description: 'Valeur.' } },
    startProperty: { type: 'string', description: 'Propriété de début (défaut « Planning / Date début »).' },
    endProperty: { type: 'string', description: 'Propriété de fin (défaut « Planning / Date fin »).' },
    dryRun: DRY_RUN,
  }, ['start', 'end', 'minDays', 'maxDays']),
];

export const TOOL_NAMES: readonly string[] = TOOL_DEFINITIONS.map((definition) => definition.function.name);
export const definitionOf = (name: string): ToolDefinition | undefined => TOOL_DEFINITIONS.find((definition) => definition.function.name === name);

// ------------------------------------------------------------------- dates

const MONTHS: Record<string, number> = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
const MONTH_NAMES = Object.keys(MONTHS).join('|');
/** Dates reconnues dans un texte libre : AAAA-MM-JJ, JJ/MM/AAAA (ou . -), « 4 janvier 2026 », « 1er mars 2026 », « January 4, 2026 ». */
export const DATE_PATTERN = new RegExp(`\\b(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{4}|\\d{1,2}(?:er)?\\s+(?:${MONTH_NAMES})\\s+\\d{4}|(?:${MONTH_NAMES})\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4})\\b`, 'gi');

/** Une date écrite à la française ou en ISO, en AAAA-MM-JJ ; undefined si elle n'est pas lisible ou n'existe pas. */
export function toIsoDate(raw: string): string | undefined {
  const text = fold(raw).replace(/\s+/g, ' ');
  let year: number, month: number, day: number;
  let match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text))) [year, month, day] = [+match[1], +match[2], +match[3]];
  else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text))) [day, month, year] = [+match[1], +match[2], +match[3]];
  else if ((match = /^(\d{1,2})(?:er)? ([a-z]+) (\d{4})$/.exec(text)) && MONTHS[match[2]]) [day, month, year] = [+match[1], MONTHS[match[2]], +match[3]];
  else if ((match = /^([a-z]+) (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})$/.exec(text)) && MONTHS[match[1]]) [month, day, year] = [MONTHS[match[1]], +match[2], +match[3]];
  else return undefined;
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  try { return formatScheduleDate(parseScheduleDate(iso)); } catch { return undefined; }
}

// --------------------------------------------------------------- coercion

/** Opérateurs écrits en symboles par certains modèles. */
const SYMBOLS: Record<string, string> = { '=': 'equals', '==': 'equals', '!=': 'not_equals', '<>': 'not_equals', '>': 'greater', '<': 'less', '>=': 'greater_or_equal', '<=': 'less_or_equal' };
const TRUE = new Set(['true', '1', 'oui', 'vrai', 'yes']);
const FALSE = new Set(['false', '0', 'non', 'faux', 'no']);

class ArgumentError extends Error {}

const typesOf = (schema: Schema): readonly string[] => (schema.type === undefined ? [] : typeof schema.type === 'string' ? [schema.type] : schema.type);
const quote = (value: unknown) => `« ${typeof value === 'string' ? value : JSON.stringify(value)} »`;

/** Texte JSON d'une liste ou d'un objet envoyé à la place de la valeur elle-même. */
function parsedJson(value: string): unknown {
  const text = value.trim();
  if (!text.startsWith('[') && !text.startsWith('{')) return value;
  try { return JSON.parse(text); } catch { return value; }
}

function coerce(value: unknown, schema: Schema, at: string): unknown {
  const types = typesOf(schema);
  if (types.length > 1) {
    if (value === null ? types.includes('null') : types.includes(typeof value)) return value;
    throw new ArgumentError(`${at} : ${quote(value)} n’est pas une valeur simple (texte, nombre ou booléen).`);
  }
  switch (types[0]) {
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number' && (value === 0 || value === 1)) return value === 1;
      const text = typeof value === 'string' ? fold(value) : '';
      if (TRUE.has(text)) return true;
      if (FALSE.has(text)) return false;
      throw new ArgumentError(`${at} : ${quote(value)} n’est pas un booléen (true ou false).`);
    }
    case 'number': {
      const number = typeof value === 'number' ? value : typeof value === 'string' ? numericValue(value) : undefined;
      if (number === undefined || !Number.isFinite(number)) throw new ArgumentError(`${at} : ${quote(value)} n’est pas un nombre.`);
      return number;
    }
    case 'string': {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new ArgumentError(`${at} : texte attendu, reçu ${quote(value)}.`);
      const text = String(value);
      if (schema.format === 'date') {
        const iso = toIsoDate(text);
        if (!iso) throw new ArgumentError(`${at} : date ${quote(text)} illisible, attendu AAAA-MM-JJ.`);
        return iso;
      }
      if (!schema.enum) return text;
      const wanted = SYMBOLS[text.trim()] ?? fold(text);
      const found = schema.enum.find((option) => fold(option) === wanted);
      if (found === undefined) throw new ArgumentError(`${at} : ${quote(text)} inconnu, attendu ${schema.enum.join(', ')}.`);
      return found;
    }
    case 'array': {
      const parsed = typeof value === 'string' ? parsedJson(value) : value;
      const list = parsed === '' ? [] : Array.isArray(parsed) ? parsed : [parsed];
      return list.map((item, i) => coerce(item, schema.items ?? {}, `${at}[${i}]`));
    }
    case 'object': {
      const parsed = typeof value === 'string' ? parsedJson(value) : value;
      if (!isRecord(parsed)) throw new ArgumentError(`${at} : objet attendu, reçu ${quote(value)}.`);
      return coerceObject(parsed, schema, at);
    }
    default:
      return value;
  }
}

function coerceObject(raw: Record<string, unknown>, schema: Schema, at: string): Record<string, unknown> {
  const properties = schema.properties ?? {};
  const out: Record<string, unknown> = {};
  const where = (key: string) => (at ? `${at}.${key}` : key);
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(properties, key)) throw new ArgumentError(`${where(key)} : argument inconnu. Arguments possibles : ${Object.keys(properties).join(', ') || 'aucun'}.`);
  }
  for (const [key, child] of Object.entries(properties)) {
    const value = raw[key];
    // Un null ou un texte vide envoyé pour un champ facultatif vaut son absence, sauf là où null est une valeur.
    const absent = value === undefined || (value === null && !typesOf(child).includes('null')) || (value === '' && (typesOf(child)[0] !== 'string' || child.enum !== undefined));
    if (!absent) Object.defineProperty(out, key, { value: coerce(value, child, where(key)), enumerable: true, configurable: true, writable: true });
    else if (child.default !== undefined) out[key] = child.default;
    else if (schema.required?.includes(key)) throw new ArgumentError(`${where(key)} : argument obligatoire manquant${child.type === 'array' ? ' ([] pour tous les éléments)' : ''}.`);
  }
  return out;
}

/**
 * Arguments d'un outil ramenés à son schéma : types convertis quand la valeur est sans ambiguïté
 * (« "true" », « "15" », « = », « 04/01/2026 », un filtre seul au lieu d'une liste), sinon une erreur
 * qui dit exactement quoi corriger. Jamais d'appel avec des arguments vides ou devinés.
 */
export function coerceArgs(name: string, raw: unknown): { args: Record<string, unknown> } | { error: string } {
  const definition = definitionOf(name);
  if (!definition) return { error: `Outil inconnu « ${name} ». Outils : ${TOOL_NAMES.join(', ')}.` };
  const parsed = raw === undefined || raw === null ? {} : typeof raw === 'string' ? parsedJson(raw) : raw;
  if (!isRecord(parsed)) return { error: `${name} : les arguments doivent former un objet JSON.` };
  try {
    return { args: coerceObject(parsed, definition.function.parameters, '') };
  } catch (error) {
    if (error instanceof ArgumentError) return { error: `${name} — ${error.message}` };
    throw error;
  }
}
