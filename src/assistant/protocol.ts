// Protocole avec le modèle, indépendant du fournisseur : le modèle répond par UN objet JSON en
// texte, {"tool", "args"} ou {"answer"}, sans appel d'outil natif. Le viewer lit cet objet quel que
// soit le dialecte (JSON dans de la prose, <|python_tag|>, format d'appel natif, arguments en
// texte), le valide contre TOOL_DEFINITIONS et refuse le reste avec un message exact.

import { isRecord } from '../data/json.ts';
import { TOOL_DEFINITIONS, coerceArgs, definitionOf } from './schema.ts';

export type Action = { tool: string; args: Record<string, unknown> } | { answer: string };
export interface ProtocolError { error: string; tool?: string }

/** Plafond d'un résultat d'outil, pour le modèle comme pour les agents (window.viewerBim). */
export const MAX_RESULT_CHARS = 8000;
export const TOOL_RESULT_PREFIX = '[Résultat de ';
export const RETRY_PREFIX = '[Réponse invalide]';
export const FORMAT = 'Réponds par un seul objet JSON, sans autre texte : {"tool": "<nom>", "args": {…}} pour utiliser un outil, ou {"answer": "<texte>"} pour répondre.';

/** Premier objet JSON équilibré du texte (les accolades des chaînes ne comptent pas) ; `complete` faux s'il n'est pas refermé. */
export function firstJsonObject(text: string): { json: string; complete: boolean } | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inString = false, escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return { json: text.slice(start, i + 1), complete: true };
  }
  return { json: text.slice(start), complete: false };
}

const firstString = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === 'string' && value.trim() !== '');

/** Ce que l'objet demande : une réponse, ou un outil et ses arguments bruts, sous les formes que les fournisseurs emploient. */
function interpret(value: Record<string, unknown>): { answer: string } | { tool: string; args: unknown } | null {
  const answer = [value.answer, value.response].find((item): item is string => typeof item === 'string');
  if (answer !== undefined && value.tool === undefined && value.name === undefined) return { answer };
  if (Array.isArray(value.tool_calls) && isRecord(value.tool_calls[0])) return interpret(value.tool_calls[0]);
  if (isRecord(value.function)) return interpret({ ...value.function, ...(value.args !== undefined ? { args: value.args } : {}) });
  const tool = firstString(value.tool, value.name, value.tool_name, value.function);
  if (tool === undefined) return null;
  return { tool: tool.trim(), args: value.args ?? value.arguments ?? value.parameters ?? value.input ?? {} };
}

/**
 * L'action demandée par le modèle, validée contre le schéma de l'outil ; sinon une erreur qui dit
 * exactement quoi corriger. Un texte sans JSON est une réponse : le modèle a parlé au lieu d'agir.
 */
export function parseAction(text: string): Action | ProtocolError {
  // Jetons de format (<|python_tag|>, <|eom_id|>…) et clôtures de code n'ont pas de sens ici.
  const cleaned = text.replace(/<\|[^|>]*\|>/g, ' ').trim();
  const found = firstJsonObject(cleaned);
  if (!found) return cleaned ? { answer: cleaned } : { error: 'Réponse vide.' };
  if (!found.complete) return { error: 'Objet JSON incomplet : une accolade n’est pas refermée.' };
  let parsed: unknown;
  try { parsed = JSON.parse(found.json); }
  catch (error) { return { error: `JSON invalide (${error instanceof Error ? error.message : String(error)}).` }; }
  if (!isRecord(parsed)) return { error: 'Un objet JSON est attendu.' };
  const action = interpret(parsed);
  if (!action) return { error: 'L’objet JSON n’a ni « tool » ni « answer ».' };
  if ('answer' in action) return { answer: action.answer.trim() };
  let args = action.args;
  if (typeof args === 'string') {
    try { args = args.trim() === '' ? {} : JSON.parse(args); }
    catch { return { error: `${action.tool} : arguments illisibles (texte qui n’est pas du JSON).`, tool: action.tool }; }
  }
  const checked = coerceArgs(action.tool, args);
  if ('error' in checked) return { error: checked.error, ...(definitionOf(action.tool) ? { tool: action.tool } : {}) };
  return { tool: action.tool, args: checked.args };
}

/** Une ligne par outil : nom, arguments (« ? » : facultatif) et premier énoncé de sa description. */
export function toolLines(): string {
  return TOOL_DEFINITIONS.map(({ function: { name, description, parameters } }) => {
    const args = Object.keys(parameters.properties).filter((key) => key !== 'dryRun').map((key) => (parameters.required?.includes(key) ? key : `${key}?`));
    const purpose = /^.*?[.!?](?=\s|$)/.exec(description)?.[0] ?? description;
    return `- ${name}(${args.join(', ')}) : ${purpose}`;
  }).join('\n');
}

/** Message de seconde chance : l'erreur exacte, le schéma complet de l'outil visé (ou la liste des outils). */
export function retryMessage(error: ProtocolError): string {
  const definition = error.tool ? definitionOf(error.tool) : undefined;
  const reference = definition ? `Schéma des arguments de ${definition.function.name} : ${JSON.stringify(definition.function.parameters)}` : `Outils :\n${toolLines()}`;
  return `${RETRY_PREFIX} ${error.error}\n${reference}\n${FORMAT}`;
}

/**
 * Un résultat borné à `max` caractères en JSON, qui reste un objet : les plus longues listes sont
 * raccourcies et `truncated` le signale ; à défaut, le début du texte JSON.
 */
export function capResult(result: unknown, max = MAX_RESULT_CHARS): unknown {
  const text = JSON.stringify(result) ?? 'null';
  if (text.length <= max) return result;
  const note = 'Résultat coupé : affinez les filtres ou demandez moins de propriétés.';
  if (isRecord(result)) {
    const out: Record<string, unknown> = { ...structuredClone(result), truncated: note };
    for (let guard = 0; guard < 60 && JSON.stringify(out).length > max; guard++) {
      const lists = Object.values(out).filter((value): value is unknown[] => Array.isArray(value) && value.length > 1);
      if (lists.length === 0) break;
      const longest = lists.reduce((a, b) => (JSON.stringify(a).length >= JSON.stringify(b).length ? a : b));
      longest.length = Math.ceil(longest.length / 2);
    }
    if (JSON.stringify(out).length <= max) return out;
  }
  return { truncated: note, partial: text.slice(0, max) };
}

/** Résultat d'outil renvoyé au modèle (rôle user : aucun appel natif). */
export const toolResultMessage = (name: string, result: unknown): string => `${TOOL_RESULT_PREFIX}${name}] ${JSON.stringify(capResult(result))}`;
