import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../worker/src/index.ts';
import { describeFailure } from '../worker/src/diagnostics.ts';

const origin = 'https://viewer.example.com';
const request = () => new Request('https://relay.example.com/chat', {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'Message simulé' }], tools: [] }),
});
const environment = (error: unknown) => ({
  ALLOWED_ORIGINS: origin, MODEL: 'mock-model', AI: { async run() { throw error; } },
});

test('Cloudflare error codes survive the relay without upstream text, with distinct actionable causes', async (t) => {
  t.mock.method(console, 'error', () => {});
  for (const [code, kind, status] of [
    [3036, 'quota', 429], [3040, 'capacity', 429], [5035, 'access', 403],
    [5007, 'model', 400], [3006, 'invalid_request', 413], [3007, 'timeout', 408],
  ] as const) {
    const response = await worker.fetch(request(), environment(new Error(`AI_ERROR: ${code}: upstream-private-content`)));
    assert.equal(response.status, 503);
    const body = await response.json() as { error: string; failures: unknown[]; unreportedAttempts: number };
    assert.deepEqual(body.failures, [{ provider: 'Cloudflare Workers AI', kind, code, status }]);
    assert.match(body.error, new RegExp(String(code)));
    assert.equal(body.unreportedAttempts, 1);
    assert.equal(JSON.stringify(body).includes('upstream-private-content'), false);
  }
});

test('temporary capacity and rate limits do not tell users their daily free quota is exhausted', () => {
  const provider = 'Cloudflare Workers AI';
  assert.equal(describeFailure(provider, new Error('Capacity temporarily exceeded')).kind, 'capacity');
  assert.equal(describeFailure(provider, new Error('Rate limit exceeded')).kind, 'rate_limit');
  assert.equal(describeFailure(provider, { status: 429 }).kind, 'rate_limit');
  assert.equal(describeFailure(provider, { code: '3036', message: 'Unknown error' }).kind, 'quota');
  assert.equal(describeFailure('Groq', { status: 403, message: 'Unknown error' }).kind, 'access');
});

test('unknown errors expose no arbitrary messages, names, keys, stacks or numeric fragments', async (t) => {
  const logs: unknown[] = [];
  t.mock.method(console, 'error', (...values: unknown[]) => logs.push(...values));
  const error = Object.assign(new Error('private prompt includes 3036: secret-api-key'), {
    name: 'secret-api-key', code: 'secret-api-key', status: 'secret-api-key',
  });
  const response = await worker.fetch(request(), environment(error));
  const body = await response.json() as { failures: unknown[] };
  assert.deepEqual(body.failures, [{ provider: 'Cloudflare Workers AI', kind: 'unavailable' }]);
  assert.equal(JSON.stringify([body, logs]).includes('secret-api-key'), false);
  assert.equal(JSON.stringify([body, logs]).includes('private prompt'), false);
  assert.deepEqual(describeFailure('Cloudflare Workers AI', new Error('AiError: 5006: private content')),
    { provider: 'Cloudflare Workers AI', kind: 'unavailable', code: 5006 });
});

test('mixed fallback failures retain each safe cause instead of reporting only a quota', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(globalThis, 'fetch', async () => new Response('private upstream response', { status: 401 }));
  const response = await worker.fetch(request(), { ...environment({ code: 3036 }), GROQ_API_KEY: 'mock-key' });
  const body = await response.json() as { error: string; failures: unknown[]; unreportedAttempts: number };
  assert.equal(body.unreportedAttempts, 2);
  assert.deepEqual(body.failures, [
    { provider: 'Cloudflare Workers AI', kind: 'quota', code: 3036, status: 429 },
    { provider: 'Groq', kind: 'access', status: 401 },
  ]);
  assert.equal(body.error.includes('Réessayez demain'), false);
  assert.equal(JSON.stringify(body).includes('private upstream response'), false);
});

test('a successful fallback keeps usage accounting and does not return failure diagnostics', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ choices: [{ message: { content: 'Réponse simulée' } }] }));
  const response = await worker.fetch(request(), { ...environment({ code: 3040 }), GROQ_API_KEY: 'mock-key' });
  const body = await response.json() as { content: string; unreportedAttempts: number; failures?: unknown };
  assert.equal(response.status, 200);
  assert.equal(body.content, 'Réponse simulée');
  assert.equal(body.unreportedAttempts, 1);
  assert.equal(body.failures, undefined);
});
