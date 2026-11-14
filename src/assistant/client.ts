// Dialogue avec le worker (worker/src/index.ts). Le modèle ne fait que traduire la demande en
// une requête JSON ({"tool", "args"} ou {"answer"}, voir protocol.ts) que le code valide puis
// exécute ici, dans le navigateur ; aucun appel d'outil natif n'est demandé au fournisseur.

import type { ToolOutcome } from './tools.ts';
import { RETRY_PREFIX, TOOL_RESULT_PREFIX, parseAction, retryMessage, toolResultMessage } from './protocol.ts';
import { normalizeUsage, type TokenUsage } from './usage.ts';

/** Kept only by the current panel instance; never placed in conversation history or storage. */
export interface ApiSettings { endpoint: string; apiKey: string; model: string }

/** Message de chat ordinaire : les résultats d'outils reviennent au modèle comme des messages user. */
export interface Message { role: 'system' | 'user' | 'assistant'; content: string }

export interface Reply {
  content: string;
  provider: string;
  model: string;
  usage?: TokenUsage;
  unreportedAttempts?: number;
}

interface ServiceStatus {
  ok: boolean;
  providers: { name: string; model: string }[];
}

export interface TurnEvents {
  /** Exécute un outil validé. `stop` : une écriture attend la confirmation de l'utilisateur, le tour s'arrête là. */
  execute(name: string, args: Record<string, unknown>): { outcome: ToolOutcome; stop?: boolean };
  onProvider(provider: string, model: string): void;
  onUsage?(usage: TokenUsage | null): void;
  /** Faux quand le modèle chargé a changé pendant le tour. */
  isCurrent?(): boolean;
}

export interface TurnResult {
  /** Texte final du modèle ({"answer"}), sans mise en forme. */
  answer: string | null;
  /** Outils exécutés pendant le tour, dans l'ordre. */
  ran: string[];
  /** Fin sans réponse : étapes épuisées, sortie invalide deux fois, écriture en attente de confirmation. */
  ending?: 'rounds' | 'invalid' | 'confirm';
  /** Dernier message de validation, pour `invalid`. */
  invalid?: string;
}

export const MAX_ROUNDS = 4;
const MAX_HISTORY = 40;
/** Délai d'une étape côté navigateur ; le worker en accorde 25 s à chaque fournisseur. */
const ROUND_TIMEOUT_MS = 60_000;
/** Taille gardée pour les résultats d'outils des tours précédents, renvoyés à chaque appel. */
const OLD_RESULT_CHARS = 240;

/** Adresse du worker : fixée au build (VITE_ASSISTANT_URL), ou le worker local en développement. */
export function assistantUrl(): string {
  const configured = (import.meta.env.VITE_ASSISTANT_URL as string | undefined)?.trim();
  if (configured) return configured.replace(/\/$/, '');
  return import.meta.env.DEV ? 'http://localhost:8787' : '';
}

export class AssistantError extends Error {
  readonly unreportedAttempts: number;
  /** Le relais n'a pas pu être joint (réseau, délai) : le panneau passe en « commandes seulement ». */
  readonly unreachable: boolean;
  constructor(message: string, unreportedAttempts = 0, unreachable = false) {
    super(message);
    this.unreportedAttempts = unreportedAttempts;
    this.unreachable = unreachable;
  }
}

async function readError(response: Response): Promise<AssistantError> {
  try {
    const body = (await response.json()) as { error?: string; unreportedAttempts?: number };
    const attempts = typeof body.unreportedAttempts === 'number' && Number.isInteger(body.unreportedAttempts) && body.unreportedAttempts >= 0 ? Math.min(10, body.unreportedAttempts) : response.status >= 500 ? 1 : 0;
    if (typeof body.error === 'string') return new AssistantError(body.error, attempts);
  } catch {
    // pas de JSON : message générique
  }
  return new AssistantError(`Le service d’IA a répondu ${response.status}.`, response.status >= 500 ? 1 : 0);
}

/** Ligne d'état du service : son fournisseur ; sans service joignable, les commandes restent disponibles. */
export function serviceLine(provider: string, unreachable: boolean): string {
  if (provider) return `Service : ${provider}`;
  return unreachable ? 'Service d’IA injoignable : commandes seulement.' : 'Service d’IA : connexion…';
}

export async function fetchStatus(url: string, signal?: AbortSignal): Promise<ServiceStatus> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as ServiceStatus;
}

/**
 * Une étape : la conversation, sans `tools` (le relais répond en texte, en mode JSON quand le
 * fournisseur en a un). `provider` épingle le fournisseur qui a répondu à la première étape du tour.
 */
export async function chat(url: string, messages: Message[], signal?: AbortSignal, api?: ApiSettings, provider?: string): Promise<Reply> {
  if (api) {
    const relay = new URL(url);
    if (relay.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(relay.hostname)) throw new AssistantError('Le relais doit utiliser HTTPS pour transmettre votre clé API.');
  }
  let response: Response;
  try {
    response = await fetch(`${url}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, ...(api ? { api } : {}), ...(provider ? { provider } : {}) }),
      redirect: 'error',
      credentials: 'omit',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(ROUND_TIMEOUT_MS)]) : AbortSignal.timeout(ROUND_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') throw new AssistantError(`Le service d’IA n’a pas répondu en ${ROUND_TIMEOUT_MS / 1000} s. Réessayez plus tard ; les commandes restent disponibles.`, 1, true);
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new AssistantError('Impossible de joindre le service d’IA. Vérifiez la connexion, ou réessayez plus tard ; les commandes restent disponibles.', 1, true);
  }
  if (!response.ok) throw await readError(response);
  const reply = (await response.json()) as Reply & { tool_calls?: unknown[] };
  // Un relais pas encore mis à jour peut renvoyer un appel natif : il est relu comme du texte.
  if (!reply.content && Array.isArray(reply.tool_calls) && reply.tool_calls.length > 0) reply.content = JSON.stringify(reply.tool_calls[0]);
  return reply;
}

/** Message écrit par le viewer (résultat d'outil, correction, note) plutôt que par l'utilisateur. */
const isViewerNote = (message: Message) => message.role === 'user' && (message.content.startsWith(TOOL_RESULT_PREFIX) || message.content.startsWith(RETRY_PREFIX) || message.content.startsWith('[Viewer]'));

/** Garde le message système, tout le tour en cours, puis les échanges précédents complets qui tiennent encore. */
export function trimHistory(messages: Message[], turnStart?: number): Message[] {
  if (messages.length <= MAX_HISTORY) return messages;
  const system = messages[0]?.role === 'system' ? [messages[0]] : [];
  let current = turnStart ?? messages.length - 1;
  if (turnStart === undefined) while (current > system.length && (messages[current].role !== 'user' || isViewerNote(messages[current]))) current--;
  let start = Math.max(system.length, current - Math.max(0, MAX_HISTORY - system.length - (messages.length - current)));
  while (start < current && (messages[start].role !== 'user' || isViewerNote(messages[start]))) start++;
  return [...system, ...messages.slice(start)];
}

/**
 * Une fois un tour terminé, ses résultats d'outils n'ont plus besoin d'être renvoyés en entier :
 * seuls les premiers caractères restent, pour que le modèle sache ce qu'il a déjà demandé.
 */
export function compactHistory(messages: Message[]): void {
  for (const message of messages) {
    if (message.role === 'user' && message.content.startsWith(TOOL_RESULT_PREFIX) && message.content.length > OLD_RESULT_CHARS) {
      message.content = `${message.content.slice(0, OLD_RESULT_CHARS)}… (résultat d’un tour précédent, abrégé)`;
    }
  }
}

/** Garde trace, pour le modèle, de ce qui s'est fait sans lui (commande, confirmation) : une demande et sa réponse. */
export function noteInHistory(messages: Message[], request: string, answer: string): void {
  messages.push({ role: 'user', content: request }, { role: 'assistant', content: JSON.stringify({ answer }) });
}

/**
 * Un tour : la demande, puis au plus MAX_ROUNDS étapes. À chaque étape le modèle répond par un
 * objet JSON ; un outil validé s'exécute (`events.execute`) et son résultat lui revient. Une sortie
 * invalide a une seconde chance avec le message exact ; invalide encore, le tour s'arrête sans rien
 * exécuter de plus. `messages` est complété en place.
 */
export async function runTurn(url: string, messages: Message[], userText: string, events: TurnEvents, signal?: AbortSignal, api?: ApiSettings): Promise<TurnResult> {
  compactHistory(messages);
  const turnStart = messages.length;
  messages.push({ role: 'user', content: userText });
  const ran: string[] = [];
  let provider: string | undefined;
  let retried = false;
  const stale = () => events.isCurrent?.() === false;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      signal?.throwIfAborted();
      if (stale()) throw new AssistantError('Le projet a changé. Relancez votre demande.');
      let reply: Reply;
      try { reply = await chat(url, trimHistory(messages, turnStart), signal, api, provider); }
      catch (error) {
        const attempts = error instanceof AssistantError ? error.unreportedAttempts : 1;
        for (let i = 0; i < attempts; i++) events.onUsage?.(null);
        throw error;
      }
      // Count a received provider response even if its model was replaced while it was in flight.
      events.onUsage?.(normalizeUsage(reply.usage));
      const attempts = typeof reply.unreportedAttempts === 'number' && Number.isInteger(reply.unreportedAttempts) ? Math.max(0, Math.min(10, reply.unreportedAttempts)) : 0;
      for (let i = 0; i < attempts; i++) events.onUsage?.(null);
      signal?.throwIfAborted();
      if (stale()) throw new AssistantError('Le projet a changé. Relancez votre demande.');
      provider ??= reply.provider;
      events.onProvider(reply.provider, reply.model);

      const action = parseAction(typeof reply.content === 'string' ? reply.content : '');
      if ('error' in action) {
        messages.push({ role: 'assistant', content: String(reply.content ?? '').slice(0, 600) });
        if (retried) {
          // Rien n'est deviné : la demande reste telle quelle, et si rien n'a tourné elle sort de l'historique.
          if (ran.length === 0) messages.length = turnStart;
          else messages.push({ role: 'user', content: `${RETRY_PREFIX} ${action.error}` }, { role: 'assistant', content: JSON.stringify({ answer: '' }) });
          return { answer: null, ran, ending: 'invalid', invalid: action.error };
        }
        retried = true;
        messages.push({ role: 'user', content: retryMessage(action) });
        continue;
      }
      messages.push({ role: 'assistant', content: JSON.stringify(action) });
      if ('answer' in action) return { answer: action.answer, ran };
      const { outcome, stop } = events.execute(action.tool, action.args);
      ran.push(action.tool);
      messages.push({ role: 'user', content: toolResultMessage(action.tool, outcome.result) });
      if (stop) {
        messages.push({ role: 'assistant', content: JSON.stringify({ answer: 'Aperçu montré : en attente de la confirmation de l’utilisateur.' }) });
        return { answer: null, ran, ending: 'confirm' };
      }
    }
    messages.push({ role: 'assistant', content: JSON.stringify({ answer: '' }) });
    return { answer: null, ran, ending: 'rounds' };
  } catch (error) {
    // L'historique reste cohérent : sans action faite, la demande en sort ; sinon le tour est refermé.
    if (ran.length === 0) messages.length = turnStart;
    else if (messages[messages.length - 1]?.role === 'user') messages.push({ role: 'assistant', content: JSON.stringify({ answer: 'Interrompu.' }) });
    throw error;
  }
}
