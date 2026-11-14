// Relais entre le viewer et un LLM. Le worker garde les clés et protège le quota ; il ne voit
// passer que la conversation (résumé du modèle, résultats d'outils), jamais le fichier entier.
// Le format est celui des « chat completions » d'OpenAI, compris par Workers AI, Groq et Cerebras.
//
// Deux sortes de requêtes :
// - avec `tools` (le site déjà déployé) : appel d'outils natif, comme avant ;
// - sans `tools` (le viewer actuel) : simple conversation, le modèle répond par un objet JSON en
//   texte, mode JSON demandé aux fournisseurs compatibles OpenAI ; `provider` épingle le
//   fournisseur de la première étape pour tout le tour.
import { normalizeUsage, type TokenUsage } from '../../src/assistant/usage.ts';
import { describeFailure, failureMessage, type ProviderFailure } from './diagnostics.ts';

interface Env {
  AI: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  ALLOWED_ORIGINS: string;
  MODEL: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  CEREBRAS_API_KEY?: string;
  CEREBRAS_MODEL?: string;
  /** Exact HTTPS chat-completions URLs authorised by the operator for enterprise BYOK. */
  AI_ALLOWED_ENDPOINTS?: string;
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface Reply {
  content: string;
  tool_calls: ToolCall[];
  provider: string;
  model: string;
  usage: TokenUsage;
}

interface Provider {
  name: string;
  model: string;
  /** `json` : réponse attendue en un objet JSON (mode JSON du fournisseur s'il en a un). */
  run(messages: unknown[], tools: unknown[], json: boolean): Promise<Reply>;
}

const MAX_BODY_BYTES = 256_000;
const MAX_MESSAGES = 80;
const MAX_TOOLS = 20;
const MAX_TOKENS = 1024;
/** Délai accordé à chaque fournisseur ; le navigateur attend 60 s au plus par étape. */
const PROVIDER_TIMEOUT_MS = 25_000;

// ------------------------------------------------------------------- outils

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Arguments d'un appel ; null s'ils sont illisibles (jamais un objet vide qui viserait tout le modèle). */
function parseArguments(raw: unknown): Record<string, unknown> | null {
  if (raw === undefined || raw === null || raw === '') return {};
  if (isRecord(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) return parsed;
    } catch {
      // illisible : signalé ci-dessous
    }
  }
  return null;
}

/** Identifiant propre à une réponse : deux étapes d'un même tour n'ont jamais le même. */
const callPrefix = () => `call_${crypto.randomUUID().slice(0, 8)}`;

/** Appels d'outils, quel que soit le dialecte : OpenAI ({function:{name,arguments}}) ou Workers AI ({name,arguments}). Les illisibles sont écartés et nommés. */
function normalizeToolCalls(raw: unknown, prefix = callPrefix()): { calls: ToolCall[]; unreadable: string[] } {
  const calls: ToolCall[] = [], unreadable: string[] = [];
  if (!Array.isArray(raw)) return { calls, unreadable };
  raw.forEach((item: unknown, index) => {
    if (!isRecord(item)) return;
    const fn = isRecord(item.function) ? item.function : item;
    if (typeof fn.name !== 'string') return;
    // Llama nomme les arguments « parameters » dans son format natif.
    const args = parseArguments(fn.arguments ?? fn.parameters);
    if (args === null) unreadable.push(fn.name);
    else calls.push({ id: typeof item.id === 'string' && item.id ? item.id : `${prefix}_${index}`, name: fn.name, arguments: args });
  });
  return { calls, unreadable };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part: unknown) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
  }
  // Workers AI rend parfois un objet quand le texte du modèle est du JSON : ne pas le perdre.
  return isRecord(content) ? JSON.stringify(content) : '';
}

/**
 * Appel d'outil écrit dans le texte au lieu de tool_calls ({"name":…,"parameters":…}, parfois
 * précédé de <|python_tag|>, ou déjà relu en objet par Workers AI). Sans cela, le viewer affichait
 * ce JSON comme réponse et rien n'était fait. Seuls les outils proposés sont reconnus.
 */
function toolCallInText(content: unknown, tools: unknown[], prefix: string): { calls: ToolCall[]; unreadable: string[] } | null {
  let value = content;
  if (typeof value === 'string') {
    const text = value.trim().replace(/^<\|python_tag\|>/, '').trim();
    if (!text.startsWith('{')) return null;
    try { value = JSON.parse(text); } catch { return null; }
  }
  if (!isRecord(value)) return null;
  const name = isRecord(value.function) ? value.function.name : value.name;
  const offered = tools.some((tool) => isRecord(tool) && isRecord(tool.function) && tool.function.name === name);
  return offered ? normalizeToolCalls([{ ...value, id: `${prefix}_text` }], prefix) : null;
}

/**
 * Contenu et appels d'outils d'une réponse, quel que soit le fournisseur. Sans outils proposés
 * (protocole texte), un appel natif éventuel est rendu en texte : le viewer le relit lui-même.
 */
function replyParts(content: unknown, rawCalls: unknown, tools: unknown[]): Pick<Reply, 'content' | 'tool_calls'> {
  if (tools.length === 0) {
    const text = textOf(content);
    return { content: text || (Array.isArray(rawCalls) && rawCalls.length > 0 ? JSON.stringify(rawCalls[0]) : ''), tool_calls: [] };
  }
  const prefix = callPrefix();
  const native = normalizeToolCalls(rawCalls, prefix);
  const { calls, unreadable } = native.calls.length === 0 && native.unreadable.length === 0 ? toolCallInText(content, tools, prefix) ?? native : native;
  // Des arguments illisibles ne deviennent jamais un appel à arguments vides : le viewer reçoit un message.
  if (calls.length === 0 && unreadable.length > 0) return { content: `Le modèle a demandé l’outil ${unreadable[0]} avec des arguments illisibles ; rien n’a été fait. Reformulez la demande.`, tool_calls: [] };
  return calls.length > 0 && native.calls.length === 0 ? { content: '', tool_calls: calls } : { content: textOf(content), tool_calls: calls };
}

// -------------------------------------------------------------- fournisseurs

function workersAi(env: Env): Provider {
  const model = env.MODEL;
  return {
    name: 'Cloudflare Workers AI',
    model,
    // Mode JSON de Workers AI non utilisé : sa prise en charge par ce modèle n'est pas vérifiée, et le protocole s'en passe.
    async run(messages, tools) {
      // OpenAI autorise content: null lors d'un appel d'outil ; le binding Workers AI
      // exige une chaîne. Garder les appels et leurs identifiants pour relier les résultats.
      const workerMessages = messages.map((message) => isRecord(message) && message.content === null
        ? { ...message, content: '' }
        : message);
      const input: Record<string, unknown> = { messages: workerMessages, max_tokens: MAX_TOKENS, temperature: 0.2 };
      if (tools.length > 0) input.tools = tools;
      const output = await env.AI.run(model, input);
      if (!isRecord(output)) throw new Error('réponse inattendue du modèle');
      return { ...replyParts(output.response, output.tool_calls, tools), provider: 'Cloudflare Workers AI', model, usage: normalizeUsage(output.usage) };
    },
  };
}

/** Fournisseur compatible OpenAI (Groq, Cerebras…). */
function openAiCompatible(name: string, url: string, key: string, model: string): Provider {
  return {
    name,
    model,
    async run(messages, tools, json) {
      const body: Record<string, unknown> = { model, messages, max_tokens: MAX_TOKENS, temperature: 0.2 };
      if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
      } else if (json) body.response_format = { type: 'json_object' };
      const post = (payload: Record<string, unknown>) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(payload),
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      let response = await post(body);
      // Mode JSON refusé (option inconnue de ce service, ou JSON que le modèle n'a pas su produire) : une fois sans.
      if (response.status === 400 && body.response_format) {
        delete body.response_format;
        response = await post(body);
      }
      // Upstream error text can contain request data or credentials: never return or log it.
      if (!response.ok) throw Object.assign(new Error('Upstream HTTP error'), { status: response.status });
      const output: unknown = await response.json();
      const choice = isRecord(output) && Array.isArray(output.choices) ? (output.choices[0] as unknown) : null;
      const message = isRecord(choice) && isRecord(choice.message) ? choice.message : null;
      if (!message) throw new Error(`${name} : réponse inattendue`);
      return { ...replyParts(message.content, message.tool_calls, tools), provider: name, model, usage: normalizeUsage(isRecord(output) ? output.usage : undefined) };
    },
  };
}

function providers(env: Env): Provider[] {
  const list: Provider[] = [workersAi(env)];
  if (env.GROQ_API_KEY) list.push(openAiCompatible('Groq', 'https://api.groq.com/openai/v1/chat/completions', env.GROQ_API_KEY, env.GROQ_MODEL || 'llama-3.3-70b-versatile'));
  if (env.CEREBRAS_API_KEY) list.push(openAiCompatible('Cerebras', 'https://api.cerebras.ai/v1/chat/completions', env.CEREBRAS_API_KEY, env.CEREBRAS_MODEL || 'llama-3.3-70b'));
  return list;
}

const DEFAULT_ENDPOINTS = [
  'https://api.openai.com/v1/chat/completions',
  'https://api.groq.com/openai/v1/chat/completions',
  'https://api.cerebras.ai/v1/chat/completions',
];

/**
 * Destination validation precedes the exact operator allowlist; no arbitrary outbound proxy.
 * Twin of `normalizeApiSettings` in src/assistant/settings.ts (client side): separate packages, change both together.
 */
export function validateEndpoint(raw: string): string {
  const url = new URL(raw);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search ||
      !host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || host.startsWith('[') ||
      /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid)$/.test(host)) {
    throw new Error('Une adresse HTTPS publique sans identifiants ni paramètres est requise.');
  }
  return url.href;
}

function customProvider(raw: unknown, env: Env): Provider | null {
  if (raw === undefined) return null;
  if (!isRecord(raw) || typeof raw.endpoint !== 'string' || typeof raw.apiKey !== 'string' || typeof raw.model !== 'string') throw new Error('Configuration de l’API incomplète.');
  const endpoint = validateEndpoint(raw.endpoint);
  const allowed = [...DEFAULT_ENDPOINTS, ...(env.AI_ALLOWED_ENDPOINTS ?? '').split(',').map((value) => value.trim()).filter(Boolean)];
  if (!allowed.some((value) => { try { return validateEndpoint(value) === endpoint; } catch { return false; } })) {
    throw new Error('Cette adresse d’API doit être autorisée par l’administrateur du relais.');
  }
  const key = raw.apiKey.trim(), model = raw.model.trim();
  if (!key || key.length > 8192 || /[\r\n]/.test(key) || !model || model.length > 200 || /[\r\n]/.test(model)) throw new Error('Clé API ou modèle invalide.');
  return openAiCompatible(new URL(endpoint).hostname, endpoint, key, model);
}

// ------------------------------------------------------------------- HTTP

/** Abandonne un fournisseur qui ne répond pas à temps (le binding Workers AI n'accepte pas de signal). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(`Provider timed out after ${ms / 1000} s`), { name: 'TimeoutError' })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin') ?? '';
    const allowed = env.ALLOWED_ORIGINS.split(',').map((item) => item.trim()).filter(Boolean);
    if (!allowed.includes(origin)) return json(403, { error: 'Origine non autorisée.' }, {});
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(request.url);
    if (request.method === 'GET') {
      // État du service, affiché par le viewer : quels relais sont configurés.
      return json(200, { ok: true, providers: providers(env).map(({ name, model }) => ({ name, model })) }, headers);
    }
    if (request.method !== 'POST' || url.pathname !== '/chat') return json(404, { error: 'Inconnu.' }, headers);

    const ip = request.headers.get('CF-Connecting-IP') ?? 'inconnu';
    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) return json(429, { error: 'Trop de requêtes : attendez une minute avant de réessayer.' }, headers);
    }

    const length = Number(request.headers.get('Content-Length') ?? 0);
    if (length > MAX_BODY_BYTES) return json(413, { error: 'Conversation trop longue : commencez une nouvelle conversation.' }, headers);
    let body: unknown;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return json(413, { error: 'Conversation trop longue : commencez une nouvelle conversation.' }, headers);
      body = JSON.parse(text);
    } catch {
      return json(400, { error: 'Corps de requête illisible.' }, headers);
    }
    if (!isRecord(body) || !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
      return json(400, { error: 'Requête invalide.' }, headers);
    }
    // Avec `tools` : le dialogue d'avant (site déjà déployé). Sans : protocole texte, réponse en JSON.
    const legacy = Array.isArray(body.tools);
    const tools = legacy ? (body.tools as unknown[]).slice(0, MAX_TOOLS) : [];
    let custom: Provider | null;
    try { custom = customProvider(body.api, env); }
    catch (error) { return json(400, { error: error instanceof Error ? error.message : 'Configuration de l’API invalide.' }, headers); }

    // Chaque fournisseur est tenté dans l'ordre ; le premier qui répond l'emporte. Un fournisseur
    // épinglé par le tour en cours est le seul tenté : un tour ne change pas de modèle en route.
    const configured = custom ? [custom] : providers(env);
    const pinned = typeof body.provider === 'string' ? configured.filter(({ name }) => name === body.provider) : [];
    const errors: ProviderFailure[] = [];
    for (const provider of pinned.length > 0 ? pinned : configured) {
      try {
        const reply = await withTimeout(provider.run(body.messages, tools, !legacy), PROVIDER_TIMEOUT_MS);
        return json(200, { ...reply, ...(errors.length ? { unreportedAttempts: errors.length } : {}) }, headers);
      } catch (error) {
        errors.push(describeFailure(provider.name, error));
      }
    }
    console.error(JSON.stringify({ event: 'ai_provider_failure', failures: errors }));
    return json(503, {
      unreportedAttempts: errors.length,
      failures: errors,
      error: failureMessage(errors),
    }, headers);
  },
};
