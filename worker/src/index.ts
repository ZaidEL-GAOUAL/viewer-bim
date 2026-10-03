// Relais entre le viewer et un LLM. Le worker garde les clés et protège le quota ; il ne voit
// passer que la conversation (résumé du modèle, résultats d'outils), jamais le fichier entier.
// Le format est celui des « chat completions » d'OpenAI, compris par Workers AI, Groq et Cerebras.

interface Env {
  AI: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  ALLOWED_ORIGINS: string;
  MODEL: string;
  GROQ_API_KEY?: string;
  GROQ_MODEL?: string;
  CEREBRAS_API_KEY?: string;
  CEREBRAS_MODEL?: string;
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
}

interface Provider {
  name: string;
  model: string;
  run(messages: unknown[], tools: unknown[]): Promise<Reply>;
}

const MAX_BODY_BYTES = 256_000;
const MAX_MESSAGES = 80;
const MAX_TOOLS = 20;
const MAX_TOKENS = 1024;

// ------------------------------------------------------------------- outils

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) return parsed;
    } catch {
      // arguments illisibles : l'outil recevra un objet vide et le dira
    }
  }
  return {};
}

/** Appels d'outils, quel que soit le dialecte : OpenAI ({function:{name,arguments}}) ou Workers AI ({name,arguments}). */
function normalizeToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  raw.forEach((item: unknown, index) => {
    if (!isRecord(item)) return;
    const fn = isRecord(item.function) ? item.function : item;
    if (typeof fn.name !== 'string') return;
    calls.push({ id: typeof item.id === 'string' ? item.id : `call_${index}`, name: fn.name, arguments: parseArguments(fn.arguments) });
  });
  return calls;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part: unknown) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

// -------------------------------------------------------------- fournisseurs

function workersAi(env: Env): Provider {
  const model = env.MODEL;
  return {
    name: 'Cloudflare Workers AI',
    model,
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
      return { content: textOf(output.response), tool_calls: normalizeToolCalls(output.tool_calls), provider: 'Cloudflare Workers AI', model };
    },
  };
}

/** Fournisseur compatible OpenAI (Groq, Cerebras…). */
function openAiCompatible(name: string, url: string, key: string, model: string): Provider {
  return {
    name,
    model,
    async run(messages, tools) {
      const body: Record<string, unknown> = { model, messages, max_tokens: MAX_TOKENS, temperature: 0.2 };
      if (tools.length > 0) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`${name} : HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
      const output: unknown = await response.json();
      const choice = isRecord(output) && Array.isArray(output.choices) ? (output.choices[0] as unknown) : null;
      const message = isRecord(choice) && isRecord(choice.message) ? choice.message : null;
      if (!message) throw new Error(`${name} : réponse inattendue`);
      return { content: textOf(message.content), tool_calls: normalizeToolCalls(message.tool_calls), provider: name, model };
    },
  };
}

function providers(env: Env): Provider[] {
  const list: Provider[] = [workersAi(env)];
  if (env.GROQ_API_KEY) list.push(openAiCompatible('Groq', 'https://api.groq.com/openai/v1/chat/completions', env.GROQ_API_KEY, env.GROQ_MODEL || 'llama-3.3-70b-versatile'));
  if (env.CEREBRAS_API_KEY) list.push(openAiCompatible('Cerebras', 'https://api.cerebras.ai/v1/chat/completions', env.CEREBRAS_API_KEY, env.CEREBRAS_MODEL || 'llama-3.3-70b'));
  return list;
}

function isQuotaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /quota|rate limit|429|limit exceeded|capacity|insufficient/i.test(message);
}

// ------------------------------------------------------------------- HTTP

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
      body = await request.json();
    } catch {
      return json(400, { error: 'Corps de requête illisible.' }, headers);
    }
    if (!isRecord(body) || !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
      return json(400, { error: 'Requête invalide.' }, headers);
    }
    const tools = Array.isArray(body.tools) ? body.tools.slice(0, MAX_TOOLS) : [];

    // Chaque fournisseur est tenté dans l'ordre ; le premier qui répond l'emporte.
    const errors: string[] = [];
    let quota = false;
    for (const provider of providers(env)) {
      try {
        const reply = await provider.run(body.messages, tools);
        return json(200, reply, headers);
      } catch (error) {
        quota ||= isQuotaError(error);
        errors.push(`${provider.name} : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.error(errors.join(' | '));
    return json(503, {
      error: quota
        ? 'Le quota gratuit du service d’IA est atteint pour aujourd’hui. Réessayez demain.'
        : 'Le service d’IA ne répond pas pour le moment. Réessayez dans quelques minutes.',
    }, headers);
  },
};
