import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeUsage, SessionUsage } from '../src/assistant/usage.ts';
import { normalizeApiSettings } from '../src/assistant/settings.ts';
import { runTurn, type Message } from '../src/assistant/client.ts';
import type { ToolContext } from '../src/assistant/tools.ts';
import { PropertyStore } from '../src/data/metadata.ts';
import worker, { validateEndpoint } from '../worker/src/index.ts';

const ORIGIN = 'https://viewer.example.com';
const context = (): ToolContext => ({ store: new PropertyStore(0), count: 0, keys: [], labelOf: String, selection: new Set(), select: () => {} });
const env = () => ({ ALLOWED_ORIGINS: ORIGIN, MODEL: 'mock-model', AI: { async run() { return { response: 'Réponse locale', usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } }; } } });
function request(api?: unknown) {
  return new Request('https://worker.example.com/chat', { method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Test hors ligne' }], tools: [], ...(api ? { api } : {}) }) });
}

test('provider counters are normalized without inventing absent usage', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 12, completion_tokens: 4 }), { inputTokens: 12, outputTokens: 4, totalTokens: 16 });
  assert.deepEqual(normalizeUsage({ input_tokens: 5, output_tokens: 0, total_tokens: 5 }), { inputTokens: 5, outputTokens: 0, totalTokens: 5 });
  assert.deepEqual(normalizeUsage({ prompt_tokens: '12', completion_tokens: -1 }), { inputTokens: null, outputTokens: null, totalTokens: null });
  const session = new SessionUsage();
  session.add({ prompt_tokens: 12, completion_tokens: 4 }); session.add(undefined);
  assert.equal(session.display('totalTokens'), '16 + ?');
  assert.equal(session.calls, 2);
});

test('tool rounds count every measured response and never place API credentials in history', async (t) => {
  let calls = 0;
  const secret = 'mock-session-key';
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://worker.example.com/chat');
    const body = JSON.parse(init.body as string);
    assert.equal(body.api.apiKey, secret);
    assert.equal(JSON.stringify(body.messages).includes(secret), false);
    calls++;
    return Response.json({ content: calls === 1 ? '' : 'Terminé.', tool_calls: calls === 1 ? [{ id: 'one', name: 'list_properties', arguments: {} }] : [],
      provider: 'mock', model: 'offline', usage: { inputTokens: calls * 10, outputTokens: 2, totalTokens: calls * 10 + 2 } });
  });
  const usage = new SessionUsage(), messages: Message[] = [];
  const answer = await runTurn('https://worker.example.com', messages, 'Lister', context(), { onProvider: () => {}, onTool: () => {}, onUsage: (value) => usage.add(value) }, undefined,
    { endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: secret, model: 'offline' });
  assert.equal(answer, 'Terminé.');
  assert.equal(calls, 2);
  assert.deepEqual(usage.totals, { inputTokens: 30, outputTokens: 4, totalTokens: 34 });
  assert.equal(JSON.stringify(messages).includes(secret), false);
});

test('Workers AI reports actual usage and keeps unavailable counts unknown', async () => {
  const response = await worker.fetch(request(), env());
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { usage: unknown }).usage, { inputTokens: 20, outputTokens: 3, totalTokens: 23 });
});

test('fallback attempts and missing provider counters remain visibly unknown', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ content: 'Terminé.', tool_calls: [], provider: 'mock', model: 'offline',
    usage: { inputTokens: 20, outputTokens: 4, totalTokens: 24 }, unreportedAttempts: 1 }));
  const usage = new SessionUsage();
  await runTurn('https://worker.example.com', [], 'Lister', context(), { onProvider: () => {}, onTool: () => {}, onUsage: (value) => usage.add(value) });
  assert.equal(usage.calls, 2);
  assert.equal(usage.display('totalTokens'), '24 + ?');
  assert.deepEqual(usage.missing, { inputTokens: 1, outputTokens: 1, totalTokens: 1 });
});

test('an endpoint rejected before a provider call adds no token usage', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Endpoint non autorisé.' }, { status: 400 }));
  const usage = new SessionUsage();
  await assert.rejects(runTurn('https://worker.example.com', [], 'Lister', context(), { onProvider: () => {}, onTool: () => {}, onUsage: (value) => usage.add(value) }), /non autorisé/);
  assert.equal(usage.calls, 0);
});

test('BYOK runs only on the backend and only against allowed exact endpoints', async (t) => {
  let called = false;
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    called = true;
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer mock-key');
    assert.equal(init.redirect, 'error');
    const payload = JSON.parse(init.body as string);
    assert.equal(payload.model, 'chosen-model');
    assert.equal('api' in payload, false);
    return Response.json({ choices: [{ message: { content: 'Réponse' } }], usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 } });
  });
  const response = await worker.fetch(request({ endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'mock-key', model: 'chosen-model' }), env());
  assert.equal(response.status, 200); assert.equal(called, true);
  const body = await response.json() as { usage: unknown };
  assert.deepEqual(body.usage, { inputTokens: 100, outputTokens: 8, totalTokens: 108 });
  assert.equal(JSON.stringify(body).includes('mock-key'), false);
});

test('unknown, private, insecure and redirecting destinations cannot become an open proxy', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network request'); });
  for (const endpoint of ['https://attacker.example.com/v1/chat/completions', 'http://api.openai.com/v1/chat/completions', 'https://127.0.0.1/v1/chat/completions',
    'https://[::1]/v1/chat/completions', 'https://service.internal/v1/chat/completions', 'https://name:password@api.openai.com/v1/chat/completions', 'https://api.openai.com/v1/chat/completions#other']) {
    const response = await worker.fetch(request({ endpoint, apiKey: 'mock-key', model: 'mock' }), env());
    assert.equal(response.status, 400, endpoint);
  }
  assert.throws(() => validateEndpoint('https://2130706433/v1/chat/completions'));
});

test('an operator may authorize one enterprise endpoint without allowing neighbouring paths', async (t) => {
  const endpoint = 'https://gateway.example.com/openai/v1/chat/completions';
  const configured = { ...env(), AI_ALLOWED_ENDPOINTS: endpoint };
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.equal(url, endpoint);
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  });
  const allowed = await worker.fetch(request({ endpoint, apiKey: 'mock-key', model: 'mock' }), configured);
  assert.equal(allowed.status, 200);
  assert.deepEqual((await allowed.json() as { usage: unknown }).usage, { inputTokens: null, outputTokens: null, totalTokens: null });
  assert.equal((await worker.fetch(request({ endpoint: endpoint + '/other', apiKey: 'mock-key', model: 'mock' }), configured)).status, 400);
});

test('provider failures neither disclose a key nor return upstream request content', async (t) => {
  const secret = 'secret-that-must-not-leak';
  const logs: unknown[] = [];
  t.mock.method(console, 'error', (...values: unknown[]) => logs.push(...values));
  t.mock.method(globalThis, 'fetch', async () => new Response(`Rejected key ${secret} and private prompt`, { status: 401 }));
  const response = await worker.fetch(request({ endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: secret, model: 'mock' }), env());
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes(secret), false);
  assert.equal(JSON.stringify(logs).includes(secret), false);
  assert.equal(JSON.stringify(logs).includes('private prompt'), false);
});

test('API form normalization accepts base URLs and requires secure transport', () => {
  assert.deepEqual(normalizeApiSettings('https://api.openai.com/v1/', ' key ', ' chosen '), { endpoint: 'https://api.openai.com/v1/chat/completions', apiKey: 'key', model: 'chosen' });
  assert.throws(() => normalizeApiSettings('http://example.com/v1', 'key', 'model'), /HTTPS/);
  assert.throws(() => normalizeApiSettings('https://example.com/v1', '', 'model'), /clé API/);
});
