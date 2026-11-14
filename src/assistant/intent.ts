// Couche 1 : les commandes courantes reconnues sans modèle de langage, en français et en anglais,
// dictées ou tapées. Les verbes et les noms de couleurs sont le seul vocabulaire : la cible se lit
// dans les noms et les valeurs du modèle chargé (valueIndex.ts). Une lecture unique devient un appel
// d'outil ; plusieurs lectures, une question à choix ; aucune, la main passe au modèle (couche 2).
// Dans le doute, refuser : une action immédiate fausse coûte plus qu'un aller-retour au modèle.

import type { RuleCondition } from '../data/conditions.ts';
import { ELEMENT_ID, fieldLabel } from '../data/elementFields.ts';
import { formatValue, toPropertyPath } from '../data/metadata.ts';
import { fold, plural } from '../data/text.ts';
import { mentionedElements } from './mentions.ts';
import { DATE_PATTERN, toIsoDate } from './schema.ts';
import { FILLERS, contentStems, stem, words, type ValueEntry, type ValueIndex } from './valueIndex.ts';

export type Intent = { kind: 'tool'; tool: string; args: Record<string, unknown> } | { kind: 'undo' };
export interface Choice { label: string; intent: Intent }
export interface Ambiguity { kind: 'ambiguity'; question: string; choices: Choice[] }
/** null : rien de sûr, la demande va au modèle (ou, sans modèle, l'utilisateur reformule). */
export type Parsed = Intent | Ambiguity | null;

const MAX_CHOICES = 5;
const MAX_READINGS = 64;

interface Target { filters: RuleCondition[]; scope?: 'selection'; label: string; count: number }
type TargetResult = Target | { ambiguous: Target[] } | null;
interface Sentence { raw: string; low: string }

// ------------------------------------------------------------------- texte

/** Sans accents ni casse, caractère pour caractère : les positions du texte d'origine restent valables. */
function foldAligned(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const folded = text[i].normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    out += folded.length === 1 ? folded : text[i];
  }
  return out;
}

const POLITE_START = /^(?:(?:ok|bon|alors|maintenant|bien|d'accord|dac|merci|euh|hey|now|then|okay)\s*,?\s+)*(?:(?:est-ce que |est ce que )?(?:tu peux|peux-tu|peux tu|pourrais-tu|pourrais tu|tu pourrais|vous pouvez|pouvez-vous|pouvez vous|pourriez-vous|pourriez vous|je veux que tu|je voudrais que tu|j'aimerais que tu|je veux|je voudrais|j'aimerais|merci de|il faut|can you|could you|would you|please|i want to|i'd like to|i would like to|let's)\s+)?(?:me |moi |nous |m')?/;
const POLITE_END = /(?:\s*,?\s*(?:s'il te plait|s'il vous plait|stp|svp|please|merci|thanks|thank you))+$/;

function sentence(text: string): Sentence {
  let raw = text.normalize('NFC').replace(/[’‘`´]/g, "'").replace(/\s+/g, ' ').trim().replace(/^[\s.!?…;:,-]+|[\s.!?…;:,]+$/g, '');
  let low = foldAligned(raw);
  for (const pattern of [POLITE_START, POLITE_END]) {
    const match = pattern.exec(low);
    if (match && match[0]) {
      const [start, end] = match.index === 0 ? [match[0].length, raw.length] : [0, match.index];
      raw = raw.slice(start, end).trim();
      low = foldAligned(raw);
    }
  }
  return { raw, low };
}

/** Le texte d'origine d'un groupe nommé (casse et accents gardés), sans guillemets autour. */
function original(s: Sentence, match: RegExpExecArray, group: string): string {
  const span = match.indices?.groups?.[group];
  return span ? s.raw.slice(span[0], span[1]).trim().replace(/^["«']\s*|\s*["»']$/g, '').trim() : '';
}

// Verbes : radical + terminaisons usuelles (isole, isoler, isoles, isolez).
const fr = (stem: string) => `${stem}(?:e|er|es|ez)`;
const MET = 'met(?:s|tre|tez)?';
const DEFINI = 'defini(?:s|r|ssez)';
const WHOLE = /\b(?:tout|tous|toute|toutes|everything|all|maquette|modele|model)\b/;

// ------------------------------------------------------------------ cibles

const describe = (condition: RuleCondition) => condition.op === 'missing'
  ? `${fieldLabel(condition.property)} absent`
  : `${fieldLabel(condition.property)} = ${formatValue(condition.value)}`;

function target(index: ValueIndex, filters: RuleCondition[], scope?: 'selection'): Target {
  const label = [scope ? 'sélection' : '', ...filters.map(describe)].filter(Boolean).join(' et ') || 'toute la maquette';
  return { filters, ...(scope ? { scope } : {}), label, count: index.matching(filters).length };
}

/**
 * Toutes les façons de couvrir les mots de la cible par des valeurs du modèle (une par propriété)
 * et des noms de propriétés. Un nom doit désigner la propriété d'une valeur retenue (« niveau R+2 »),
 * sauf un booléen nommé seul (« porteurs » : Porteur = vrai). Tout mot doit être expliqué.
 */
function readings(tokens: readonly string[], index: ValueIndex): RuleCondition[][] {
  const found: RuleCondition[][] = [];
  const values: ValueEntry[] = [];
  const names: { paths: string[]; stems: string }[] = [];
  const visit = (pos: number) => {
    if (found.length >= MAX_READINGS) return;
    if (pos === tokens.length) {
      const filters: RuleCondition[] = values.map(({ path, value }) => ({ property: path, op: 'equals', value }));
      for (const name of names) {
        if (values.some((entry) => name.paths.includes(entry.path))) continue;
        const named = name.paths.filter((path) => index.booleans.has(path) && (index.nameStems.get(path) ?? []).some((list) => list.join(' ') === name.stems));
        if (named.length !== 1 || filters.some((filter) => filter.property === named[0])) return;
        filters.push({ property: named[0], op: 'equals', value: true });
      }
      found.push(filters);
      return;
    }
    for (let end = pos + 1; end <= Math.min(tokens.length, pos + 6); end++) {
      const span = tokens.slice(pos, end);
      for (const entry of index.valuesFor(span)) {
        if (values.some((chosen) => chosen.path === entry.path)) continue;
        values.push(entry);
        visit(end);
        values.pop();
      }
      const paths = index.propertiesFor(span);
      if (paths.length > 0) {
        names.push({ paths, stems: span.map(stem).join(' ') });
        visit(end);
        names.pop();
      }
    }
  };
  visit(0);
  return found;
}

/** Ce que vise un groupe de mots : filtres (ET) et périmètre, une lecture, plusieurs, ou aucune. */
function resolveTarget(phrase: string, index: ValueIndex, extra: RuleCondition[], allowWhole = false): TargetResult {
  let text = ` ${phrase} `;
  let scope: 'selection' | undefined;
  const selection = /\s(?:(?:de|dans|of|in)\s+)?(?:la\s+|the\s+|les\s+|l')?(?:selection|selectionne(?:e|s|es)?|selected)(?=\s)/g;
  if (selection.test(text)) { scope = 'selection'; text = text.replace(selection, ' '); }
  const conditions = [...extra];
  // « sans matériau », « qui n'ont pas de niveau » : la propriété est absente.
  const missing = /\s(?:qui\s+)?(?:n'?\s?(?:ont|a)\s+(?:pas|aucun|aucune)(?:\s+de|\s+d')?|sans|without|with no|missing|having no|that have no)\s+(.+)$/.exec(text);
  if (missing) {
    const paths = index.propertiesNamed(missing[1].replace(/^(?:le |la |les |l'|the )/, '').trim());
    if (paths.length !== 1) return paths.length > 1 ? { ambiguous: paths.map((path) => target(index, [...conditions, { property: path, op: 'missing' }], scope)) } : null;
    conditions.push({ property: paths[0], op: 'missing' });
    text = text.slice(0, missing.index);
  }
  const tokens = words(text).filter((word) => !FILLERS.has(word));
  if (tokens.length === 0) return conditions.length > 0 || scope || allowWhole || WHOLE.test(phrase) ? target(index, conditions, scope) : null;

  // Une lecture de plus de filtres qu'une autre est écartée : « Mur rideau » valeur entière l'emporte sur « Mur » + « rideau ».
  const all = readings(tokens, index);
  if (all.length === 0) return null;
  const fewest = Math.min(...all.map((filters) => filters.length));
  const unique = new Map<string, RuleCondition[]>();
  for (const filters of all.filter((list) => list.length === fewest)) {
    const sorted = [...conditions, ...filters].sort((a, b) => a.property.localeCompare(b.property));
    unique.set(JSON.stringify(sorted), sorted);
  }
  // Deux lectures qui touchent exactement les mêmes éléments n'en font qu'une (une vraie propriété avant le nom affiché).
  const byElements = new Map<string, Target>();
  for (const filters of [...unique.values()].sort((a, b) => Number(a.some((f) => f.property.startsWith('#'))) - Number(b.some((f) => f.property.startsWith('#'))))) {
    const key = index.matching(filters).join(',');
    if (!byElements.has(key)) byElements.set(key, target(index, filters, scope));
  }
  const targets = [...byElements.values()];
  return targets.length === 1 ? targets[0] : { ambiguous: targets.sort((a, b) => b.count - a.count) };
}

function fromTarget(result: TargetResult, build: (target: Target) => Intent | null): Parsed {
  if (!result) return null;
  if ('ambiguous' in result) {
    const choices = result.ambiguous.flatMap((option) => {
      const intent = build(option);
      return intent ? [{ label: `${option.label} (${plural(option.count, 'élément')})`, intent }] : [];
    }).slice(0, MAX_CHOICES);
    return choices.length > 1 ? { kind: 'ambiguity', question: 'Plusieurs lectures possibles. Laquelle ?', choices } : choices[0]?.intent ?? null;
  }
  return build(result);
}

const tool = (name: string, args: Record<string, unknown>): Intent => ({ kind: 'tool', tool: name, args });
const scoped = (option: Target) => (option.scope ? { scope: option.scope } : {});

/** Propriétés nommées par un texte ; plusieurs : une question ; aucune : null. */
function properties(text: string, index: ValueIndex, build: (path: string) => Intent, partial = true): Parsed {
  const cleaned = text.replace(/^(?:le |la |les |l'|the |leur |son |sa )/, '').trim();
  const paths = partial ? index.propertiesNamed(cleaned) : index.propertiesNamed(cleaned).filter((path) => exactName(index, path, cleaned));
  if (paths.length === 0) return null;
  if (paths.length === 1) return build(paths[0]);
  return { kind: 'ambiguity', question: `Plusieurs propriétés correspondent à « ${cleaned} ». Laquelle ?`, choices: paths.slice(0, MAX_CHOICES).map((path) => ({ label: path, intent: build(path) })) };
}

/** Le texte nomme la propriété en entier (nom complet, dernier segment ou mêmes mots), pas seulement une partie. */
function exactName(index: ValueIndex, path: string, text: string): boolean {
  const key = contentStems(text).join(' ');
  return fold(path) === fold(text) || (index.nameStems.get(path) ?? []).some((list) => list.join(' ') === key);
}

// ---------------------------------------------------------------- couleurs

const COLOURS: Record<string, string> = {
  rouge: '#e53935', red: '#e53935', vert: '#43a047', green: '#43a047', bleu: '#1e88e5', blue: '#1e88e5',
  jaune: '#fdd835', yellow: '#fdd835', orange: '#fb8c00', violet: '#8e24aa', purple: '#8e24aa', rose: '#ec407a', pink: '#ec407a',
  noir: '#212121', black: '#212121', blanc: '#fafafa', white: '#fafafa', gris: '#9e9e9e', grey: '#9e9e9e', gray: '#9e9e9e',
  marron: '#6d4c41', brun: '#6d4c41', brown: '#6d4c41', cyan: '#00acc1', turquoise: '#26a69a', beige: '#d7ccc8', magenta: '#d81b60',
};
const COLOUR = `(?<colour>#[0-9a-f]{6}|(?:${Object.keys(COLOURS).join('|')})(?:e|es|s|he|hes|te|tes)?)`;
function colourOf(word: string): { hex: string; name: string } | undefined {
  if (word.startsWith('#')) return { hex: word, name: word };
  const base = Object.keys(COLOURS).filter((name) => word.startsWith(name)).sort((a, b) => b.length - a.length)[0];
  return base ? { hex: COLOURS[base], name: base } : undefined;
}

/** Identifiant stable d'une règle posée par une commande : recolorier la même cible remplace la règle. */
const ruleId = (kind: string, option: Target) => `assistant-${kind}-${fold(option.filters.map((f) => `${f.property}-${f.op === 'missing' ? 'absent' : formatValue(f.value)}`).join('-') || 'tout').replace(/[^a-z0-9+]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)}`;

// ---------------------------------------------------------------- commandes

type Command = (s: Sentence, index: ValueIndex, extra: RuleCondition[]) => Parsed | undefined;

const UNDO = /^(?:annule(?:r|s|z)?|defai(?:s|re|tes)|undo|reviens en arriere|retour arriere)(?:\s+(?:ca|cela|ceci|la derniere (?:action|modification|commande)|ta derniere action|ce que tu (?:as|viens de) fait|that|it|the last (?:action|change)|last action))?$/;
const SHOW_ALL = /^(?:(?:re-?\s?)?affich(?:e|er|es|ez) tout(?:e la maquette| le modele)?|tout (?:re-?\s?)?afficher|montr(?:e|er|es|ez) tout|tout montrer|show (?:all|everything)(?: again)?|unhide (?:all|everything)|reinitialis(?:e|er|es|ez) (?:l'affichage|la vue|la visibilite)|ne plus isoler|n'isole plus|desisol(?:e|er|es|ez)(?: tout)?|stop isolating|reset (?:the )?view)$/;
const UNGROUP = /^(?:ne (?:re)?group(?:e|er|es|ez) plus(?: l'arbre| l'arborescence)?|supprim(?:e|er|es|ez) (?:le )?(?:re)?groupement|degroup(?:e|er|es|ez)(?: l'arbre| l'arborescence)?|ungroup(?: the tree)?|remove (?:the )?grouping)$/;
const LIST_PROPERTIES = /^(?:list(?:e|er|es|ez)|quelles sont|montr(?:e|er|es|ez)|affich(?:e|er|es|ez)|list|show|what are)\s+(?:moi\s+)?(?:les |the )?(?:proprietes|properties)(?: du modele| de la maquette| of the model)?$/;
const GROUP = new RegExp(`^(?:${fr('(?:re)?group')}|${fr('organis')}|${fr('rang')}|group|organi[sz]e)\\s+(?:(?:l'|les |the )?(?:arbre|arborescence|elements|tree|model|maquette)\\s+)?(?:par|by|selon)\\s+(?<list>.+)$`, 'd');
const COUNT_BY = /^(?:(?:la |the )?(?:repartition|distribution|breakdown)|(?:combien|nombre)(?: d'elements| de objets| d'objets| of elements)?|how many(?: elements| objects)?|compt(?:e|er|es|ez)(?: les elements)?)\s+(?:des elements |of elements |of objects )?(?:par|by|per|selon)\s+(?<property>.+)$/d;
const HOW_MANY = /^(?:combien(?:\s+(?:y a[- ]?t[- ]?il|il y a|y'?\s?a|ya|en a|en))?|how many|nombre)\s*(?:de |d'|des |of )?(?<target>.*?)(?:\s+(?:y a[- ]?t[- ]?il|il y a|are there|there are|y'?a|ya|en tout|au total|in total))?$/d;
const FIND = new RegExp(`^(?:quel(?:s|le|les)?|which|${fr('list')}|${fr('trouv')}|${fr('cherch')}|find|list)\\s+(?<target>.+)$`, 'd');
const HIGHLIGHT = new RegExp(`^(?:${MET} en (?:evidence|evidance|valeur)|${fr('surlign')}|fai(?:s|re|tes) ressortir|highlight)(?:\\s+(?<target>.+))?$`, 'd');
const TRANSPARENT = new RegExp(`^(?:rend(?:s|re|ez)?|${MET}|make)\\s+(?<target>.+?)\\s+(?:(?<semi>semi)[- ]?)?(?:transparente?s?|transparent|en transparence)(?:\\s+(?:a|au|at)\\s+(?<percent>\\d+)\\s*%)?$`, 'd');
const OPAQUE = new RegExp(`^(?:rend(?:s|re|ez)?|${MET}|make)\\s+(?<target>.+?)\\s+opaques?$`, 'd');
const OPACITY = new RegExp(`^(?:${MET}\\s+|set\\s+)?(?:l'|the\\s+)?(?:opacite|opacity)\\s+(?:de |des |du |d'|of )?(?<target>.+?)\\s+(?:a|au|to|=)\\s+(?<percent>\\d+)\\s*%$`, 'd');
const PAINT = `(?:${fr('colori')}|${fr('color')}|pein(?:s|dre)|peignez|${MET}|colou?r|paint|make)`;
const COLOUR_CMD = new RegExp(`^${PAINT}\\s+(?<target>.+?)\\s+(?:en\\s+|in\\s+)?${COLOUR}$|^${PAINT}\\s+(?:en|in)\\s+${COLOUR.replace('colour', 'first')}\\s+(?<after>.+)$`, 'd');
const SET = new RegExp(`^(?:(?<create>${fr('ajout')}|${fr('cre')}|add|create)\\s+(?:une |la |a |the |new )?(?:nouvelle |new )?(?:propriete|property|champ|field)\\s+|(?:${MET}|${fr('renseign')}|${fr('pass')}|${fr('fix')}|${DEFINI}|${fr('modifi')}|set|change)\\s+(?:la propriete |le champ |the property |property |le |la |l'|the )?)(?<prop>.+?)\\s*(?:=|:|\\s(?:a|to|valant|avec la valeur|with value)\\s)\\s*(?<value>.+?)(?:\\s+(?:sur|pour|aux|au|dans|on|for|in)\\s+(?<target>.+))?$`, 'd');
const EQUATION = /^(?<prop>[^=]+?)\s*=\s*(?<value>.+?)(?:\s+(?:sur|pour|aux|au|dans|on|for|in)\s+(?<target>.+))?$/d;
const ISOLATE = new RegExp(`^(?:${fr('isol')}|n'?\\s?${fr('affich')} que|${fr('affich')}(?: moi)? (?:que|seulement|uniquement)|ne ${fr('montr')} que|${fr('montr')}(?: moi)? (?:que|seulement|uniquement)|ne ${fr('gard')} que|${fr('gard')} (?:que|seulement|uniquement)|(?:${fr('masqu')}|${fr('cach')}) tout sauf|isolate|show only|only show|hide (?:everything|all) (?:except|but))(?:\\s+(?<target>.+?))?(?:\\s*,?\\s*(?:et\\s+)?(?:le reste (?:invisible|masque|cache)|(?:masque|cache) le reste|and hide the rest|hide the rest|the rest hidden))?$`, 'd');
const SHOW_AGAIN = new RegExp(`^(?:re-?\\s?${fr('affich')}|re-?\\s?${fr('montr')}|${fr('demasqu')}|fai(?:s|re|tes) reapparaitre|unhide)(?:\\s+(?<target>.+))?$|^show\\s+(?<again>.+?)\\s+again$`, 'd');
const HIDE = new RegExp(`^(?:${fr('masqu')}|${fr('cach')}|hide)(?:\\s+(?<target>.+))?$`, 'd');
const SELECT = new RegExp(`^(?:${fr('selectionn')}|select)(?:\\s+(?<target>.+))?$`, 'd');
const PLAN = /\b(?:planning|planifi\w*|plan(?:s)? (?:les |the )?dates|plan dates|schedule|dates? de (?:debut|fin)|start and end dates|calendrier)\b/;
const DURATION = /(?:\b(?:entre|de|between|from)\s+)?\b(\d+)\s*(?:et|a|au|and|to|-)\s*(\d+)\s*(?:jours?|j|days?)\b/g;
const ORDER = /(?:\b(?:ordonn|group|rang|tri|class)(?:e|es|ee|ees|s)?\s+)?\b(?:par|selon|suivant|dans l'ordre (?:du|de la|des|de l')|en suivant|by|ordered by|per)\s+(?:le |la |les |l'|the |chaque |each )?([^,;]+?)(?=\s*(?:,|;|$|\s(?:et|puis|then|and|avec|with|du|from|entre|between)\s))/g;
const PER_ELEMENT = /^(?:elements?|objets?|taches?|tasks?|items?|jours?|days?)$/;
const PLAN_WORDS = new Set([
  'ajoute', 'ajouter', 'ajoutes', 'ajoutez', 'ecris', 'ecrire', 'ecrivez', 'genere', 'generer', 'generez', 'cree', 'creer', 'creez', 'mets', 'met', 'mettre', 'mettez', 'fais', 'faire', 'faites', 'prepare', 'preparer', 'preparez',
  'planning', 'planifie', 'planifier', 'planifiez', 'planification', 'previsionnel', 'previsionnelle', '4d', 'date', 'dates', 'debut', 'fin', 'demarrage', 'chantier', 'travaux', 'projet', 'construction',
  'chaque', 'dure', 'durent', 'duree', 'durees', 'entre', 'jour', 'jours', 'et', 'puis', 'commence', 'commencant', 'finit', 'finissant', 'termine', 'terminant', 'ordre', 'ordonne', 'ordonnes', 'ordonnee', 'ordonnees',
  'bas', 'haut', 'vers', 'etage', 'etages', 'calendrier', 'minimum', 'maximum', 'min', 'max', 'selection', 'schedule', 'plan', 'from', 'between', 'and', 'days', 'day', 'each', 'start', 'end', 'by', 'with', 'a', 'an',
  'ordered', 'site', 'durant', 'pendant', 'element', 'elements', 'objet', 'objets', 'tache', 'taches', 'task', 'tasks', 'per', 'par', 'est', 'sont', 'qui',
]);

const commands: Command[] = [
  (s) => (UNDO.test(s.low) ? { kind: 'undo' } : undefined),
  (s) => (SHOW_ALL.test(s.low) ? tool('set_visibility', { filters: [], showAll: true }) : undefined),
  (s) => (UNGROUP.test(s.low) ? tool('update_view', { groupBy: [] }) : undefined),
  (s) => (LIST_PROPERTIES.test(s.low) ? tool('list_properties', {}) : undefined),
  (s, index) => {
    const match = GROUP.exec(s.low);
    if (!match) return undefined;
    const parts = match.groups!.list.split(/\s*(?:,|;|>|\bpuis\b|\bet\b|\bthen\b|\band\b)\s*/).filter(Boolean);
    const paths: string[] = [];
    for (const part of parts) {
      const one = properties(part, index, (path) => tool('update_view', { groupBy: [...paths, path] }));
      if (one === null || one.kind !== 'tool') return parts.length === 1 ? one : null;
      paths.push((one.args.groupBy as string[]).at(-1)!);
    }
    return tool('update_view', { groupBy: paths });
  },
  (s, index, extra) => {
    const match = COUNT_BY.exec(s.low);
    if (!match || extra.length > 0) return match ? null : undefined;
    return properties(match.groups!.property, index, (path) => tool('count_by', { property: path }));
  },
  (s, index, extra) => {
    const match = HOW_MANY.exec(s.low);
    if (!match) return undefined;
    const phrase = match.groups!.target;
    // « combien de murs par niveau » : count_by ne filtre pas, on laisse au modèle.
    if (/\s(?:par|by|per)\s/.test(` ${phrase} `)) return null;
    return fromTarget(resolveTarget(phrase, index, extra, true), (option) => tool('find_elements', { filters: option.filters, ...scoped(option) }));
  },
  (s, index, extra) => (PLAN.test(s.low) ? planDates(s, index, extra) : undefined),
  (s, index, extra) => {
    const match = HIGHLIGHT.exec(s.low);
    return match ? fromTarget(resolveTarget(match.groups!.target ?? '', index, extra), (option) => tool('select_elements', { filters: option.filters, highlight: true, ...scoped(option) })) : undefined;
  },
  (s, index, extra) => {
    const match = TRANSPARENT.exec(s.low) ?? OPAQUE.exec(s.low) ?? OPACITY.exec(s.low);
    if (!match) return undefined;
    const { semi, percent } = match.groups!;
    const opacity = match[0].includes('opaque') ? 1 : percent !== undefined
      ? (/opacit/.test(match[0]) ? Number(percent) / 100 : 1 - Number(percent) / 100)
      : semi ? 0.5 : 0.3;
    if (!(opacity >= 0 && opacity <= 1)) return null;
    return fromTarget(resolveTarget(match.groups!.target, index, extra), (option) => (option.scope ? null : tool('update_view', {
      rules: [{ id: ruleId('opacite', option), name: `${option.label} : opacité ${Math.round(opacity * 100)} %`, enabled: true, conditions: option.filters, opacity }],
    })));
  },
  (s, index, extra) => {
    const match = COLOUR_CMD.exec(s.low);
    const colour = match && colourOf(match.groups!.colour ?? match.groups!.first);
    if (!match || !colour) return undefined;
    return fromTarget(resolveTarget(match.groups!.target ?? match.groups!.after, index, extra), (option) => (option.scope ? null : tool('update_view', {
      rules: [{ id: ruleId('couleur', option), name: `${option.label} : ${colour.name}`, enabled: true, conditions: option.filters, color: colour.hex }],
    })));
  },
  (s, index, extra) => setProperty(s, index, extra, SET.exec(s.low)),
  (s, index, extra) => {
    const match = ISOLATE.exec(s.low);
    return match ? fromTarget(resolveTarget(match.groups!.target ?? '', index, extra), (option) => tool('select_elements', { filters: option.filters, isolate: true, ...scoped(option) })) : undefined;
  },
  (s, index, extra) => {
    const match = SHOW_AGAIN.exec(s.low);
    return match ? fromTarget(resolveTarget(match.groups!.target ?? match.groups!.again ?? '', index, extra), (option) => tool('set_visibility', { filters: option.filters, visible: true, ...scoped(option) })) : undefined;
  },
  (s, index, extra) => {
    const match = HIDE.exec(s.low);
    return match ? fromTarget(resolveTarget(match.groups!.target ?? '', index, extra), (option) => tool('set_visibility', { filters: option.filters, visible: false, ...scoped(option) })) : undefined;
  },
  (s, index, extra) => {
    const match = SELECT.exec(s.low);
    return match ? fromTarget(resolveTarget(match.groups!.target ?? '', index, extra), (option) => tool('select_elements', { filters: option.filters, ...scoped(option) })) : undefined;
  },
  (s, index, extra) => {
    const match = FIND.exec(s.low);
    return match ? fromTarget(resolveTarget(match.groups!.target, index, extra), (option) => tool('find_elements', { filters: option.filters, ...scoped(option) })) : undefined;
  },
  (s, index, extra) => setProperty(s, index, extra, EQUATION.exec(s.low), true),
];

/** « mets Lot à GO sur les murs », « ajoute une propriété Lot = GO aux murs ». La valeur garde sa casse. */
function setProperty(s: Sentence, index: ValueIndex, extra: RuleCondition[], match: RegExpExecArray | null, equation = false): Parsed | undefined {
  if (!match) return undefined;
  const create = !equation && match.groups!.create !== undefined;
  const name = original(s, match, 'prop');
  const value = original(s, match, 'value');
  if (!name || !value) return null;
  const phrase = match.groups!.target;
  const resolved = phrase === undefined ? target(index, extra) : resolveTarget(phrase, index, extra);
  const build = (path: string) => (option: Target) => tool('set_property', { filters: option.filters, property: path, value, ...scoped(option) });
  const existing = properties(name, index, (path) => tool('set_property', { property: path }), false);
  if (existing?.kind === 'ambiguity') {
    if (resolved === null || 'ambiguous' in resolved) return null;
    return { ...existing, choices: existing.choices.map((choice) => ({ label: choice.label, intent: build(choice.label)(resolved) })) };
  }
  const path = existing?.kind === 'tool' ? existing.args.property as string : create ? toPropertyPath(name) : undefined;
  // Une propriété inconnue n'est créée que si la phrase le dit (« ajoute une propriété ») ; sinon c'est peut-être une faute.
  return path ? fromTarget(resolved, build(path)) : null;
}

function planDates(s: Sentence, index: ValueIndex, extra: RuleCondition[]): Parsed {
  if (extra.length > 0) return null;
  let rest = s.low;
  const blank = (match: { index?: number; 0: string }) => { rest = rest.slice(0, match.index) + ' '.repeat(match[0].length) + rest.slice(match.index! + match[0].length); };
  const dates = [...s.low.matchAll(DATE_PATTERN)];
  if (dates.length !== 2) return null;
  const [start, end] = dates.map((match) => toIsoDate(match[0]));
  if (!start || !end) return null;
  dates.forEach(blank);
  const durations = [...rest.matchAll(DURATION)];
  if (durations.length !== 1) return null;
  durations.forEach(blank);
  const [low, high] = [Number(durations[0][1]), Number(durations[0][2])].sort((a, b) => a - b);
  let orderBy: string[] = [];
  let choice: Ambiguity | null = null;
  for (const match of [...rest.matchAll(ORDER)]) {
    const phrase = match[1].trim();
    blank(match);
    if (PER_ELEMENT.test(phrase)) continue;
    if (orderBy.length > 0 || choice) return null;
    const found = properties(phrase, index, (path) => tool('plan_dates', { orderBy: [path] }));
    if (found === null) return null;
    if (found.kind === 'ambiguity') choice = found;
    else orderBy = found.kind === 'tool' ? found.args.orderBy as string[] : [];
  }
  const leftover = words(rest.replace(PLAN, ' ')).filter((word) => !FILLERS.has(word) && !PLAN_WORDS.has(word));
  if (leftover.length > 0) return null;
  const scope = /\bselection\b/.test(s.low) ? { scope: 'selection' } : {};
  const args = (paths: string[]) => ({ filters: [], start, end, minDays: low, maxDays: high, ...(paths.length > 0 ? { orderBy: paths } : {}), ...scope });
  if (choice) return { ...choice, choices: choice.choices.map((option) => ({ label: option.label, intent: tool('plan_dates', args([option.label])) })) };
  return tool('plan_dates', args(orderBy));
}

/**
 * La commande que dit la phrase, sans modèle de langage : un appel d'outil, une question à choix
 * (plusieurs lectures), ou null (aucune lecture sûre : la demande va au modèle).
 */
export function parseIntent(text: string, index: ValueIndex): Parsed {
  const s = sentence(text);
  if (!s.low) return null;
  // Un identifiant cité tel quel désigne son élément ; plusieurs ne s'expriment pas en filtres ET.
  const mentioned = mentionedElements(s.raw, index.keys);
  if (mentioned.length > 1) return null;
  const extra: RuleCondition[] = [];
  if (mentioned.length === 1) {
    const key = index.keys[mentioned[0]];
    const at = s.raw.indexOf(key);
    s.raw = `${s.raw.slice(0, at)} ${s.raw.slice(at + key.length)}`.replace(/\s+/g, ' ').trim();
    s.low = foldAligned(s.raw);
    extra.push({ property: ELEMENT_ID, op: 'equals', value: key });
  }
  for (const command of commands) {
    const parsed = command(s, index, extra);
    if (parsed !== undefined) return parsed;
  }
  return null;
}
