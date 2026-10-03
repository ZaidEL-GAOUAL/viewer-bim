// Dialogue avec le worker (worker/src/index.ts) : envoi de la conversation, exécution des
// appels d'outils demandés par le modèle, jusqu'à sa réponse finale.

import { TOOL_DEFINITIONS, runTool, type ToolContext } from './tools.ts';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Message au format « chat completions » (OpenAI), tel que le worker le transmet. */
export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface Reply {
  content: string;
  tool_calls: ToolCall[];
  provider: string;
  model: string;
}

export interface ServiceStatus {
  ok: boolean;
  providers: { name: string; model: string }[];
}

export interface TurnEvents {
  /** Un outil vient d'être exécuté : ligne à afficher. */
  onTool(note: string, name: string): void;
  onProvider(provider: string, model: string): void;
}

const MAX_ROUNDS = 6;
const MAX_HISTORY = 40;
/** Un résultat d'outil trop long est coupé : le modèle n'a pas besoin de tout. */
const MAX_RESULT_CHARS = 8000;
/** Taille gardée pour les résultats d'outils des tours précédents, renvoyés à chaque appel. */
const OLD_RESULT_CHARS = 240;

/** Adresse du worker : fixée au build (VITE_ASSISTANT_URL), ou le worker local en développement. */
export function assistantUrl(): string {
  const configured = (import.meta.env.VITE_ASSISTANT_URL as string | undefined)?.trim();
  if (configured) return configured.replace(/\/$/, '');
  return import.meta.env.DEV ? 'http://localhost:8787' : '';
}

export class AssistantError extends Error {}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // pas de JSON : message générique
  }
  return `Le service d’IA a répondu ${response.status}.`;
}

export async function fetchStatus(url: string, signal?: AbortSignal): Promise<ServiceStatus> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new AssistantError(await readError(response));
  return (await response.json()) as ServiceStatus;
}

export async function chat(url: string, messages: Message[], signal?: AbortSignal): Promise<Reply> {
  let response: Response;
  try {
    response = await fetch(`${url}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, tools: TOOL_DEFINITIONS }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new AssistantError('Impossible de joindre le service d’IA. Vérifiez la connexion, ou réessayez plus tard.');
  }
  if (!response.ok) throw new AssistantError(await readError(response));
  return (await response.json()) as Reply;
}

/** Garde le message système et les derniers échanges, sans couper un aller-retour d'outil. */
export function trimHistory(messages: Message[]): Message[] {
  if (messages.length <= MAX_HISTORY) return messages;
  const system = messages[0].role === 'system' ? [messages[0]] : [];
  let start = messages.length - MAX_HISTORY;
  while (start < messages.length && messages[start].role !== 'user') start++;
  return [...system, ...messages.slice(start)];
}

function truncate(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}… (résultat coupé : affinez les filtres)` : text;
}

/**
 * Une fois un tour terminé, ses résultats d'outils n'ont plus besoin d'être renvoyés en entier :
 * seuls les premiers caractères restent, pour que le modèle sache ce qu'il a déjà demandé.
 */
export function compactHistory(messages: Message[]): void {
  for (const message of messages) {
    if (message.role === 'tool' && message.content.length > OLD_RESULT_CHARS) {
      message.content = `${message.content.slice(0, OLD_RESULT_CHARS)}… (résultat d’un tour précédent, abrégé)`;
    }
  }
}

/**
 * Un tour de conversation : la question de l'utilisateur, les appels d'outils que le modèle
 * demande (exécutés ici, dans le navigateur), puis sa réponse. `messages` est complété en place.
 */
export async function runTurn(url: string, messages: Message[], userText: string, context: ToolContext, events: TurnEvents, signal?: AbortSignal): Promise<string> {
  compactHistory(messages);
  messages.push({ role: 'user', content: userText });
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const reply = await chat(url, trimHistory(messages), signal);
    events.onProvider(reply.provider, reply.model);
    if (reply.tool_calls.length === 0) {
      const content = reply.content.trim() || 'Je n’ai pas de réponse à donner.';
      messages.push({ role: 'assistant', content });
      return content;
    }
    messages.push({
      role: 'assistant',
      content: reply.content || null,
      tool_calls: reply.tool_calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
    });
    for (const call of reply.tool_calls) {
      const outcome = runTool(call.name, call.arguments, context);
      events.onTool(outcome.note, call.name);
      messages.push({ role: 'tool', tool_call_id: call.id, content: truncate(JSON.stringify(outcome.result)) });
    }
  }
  const content = 'Je n’ai pas réussi à conclure : reformulez la demande, ou découpez-la en étapes.';
  messages.push({ role: 'assistant', content });
  return content;
}
