import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../worker/src/index.ts';

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const ORIGIN = 'https://zaidel-gaoual.github.io';
const tools = [{
  type: 'function',
  function: {
    name: 'get_element',
    description: 'Lire la fiche d’un élément.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
}];

function conversation() {
  return [
    { role: 'system', content: 'Réponds à partir des résultats des outils.' },
    { role: 'user', content: 'Quelle est la hauteur du mur ?' },
    {
      role: 'assistant', content: null,
      tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'get_element', arguments: '{"query":"Mur test"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_0', content: '{"height":2.77}' },
  ];
}

function request(messages: unknown[]) {
  return new Request('https://worker.test/chat', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, tools }),
  });
}

test('Workers AI accepte le retour d’outil avec un contenu vide et conserve les appels', async () => {
  const messages = conversation();
  const response = await worker.fetch(request(messages), {
    ALLOWED_ORIGINS: ORIGIN,
    MODEL,
    AI: {
      async run(model, input) {
        assert.equal(model, MODEL);
        // Le schéma du binding Workers AI rejette null avant même d'appeler le modèle.
        assert.ok((input.messages as { content: unknown }[]).every((message) => typeof message.content === 'string'));
        assert.deepEqual(input.messages, messages.map((message) => message.content === null ? { ...message, content: '' } : message));
        assert.deepEqual(input.tools, tools);
        return { response: 'Le mur mesure 2,77 m.', tool_calls: [] };
      },
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    content: 'Le mur mesure 2,77 m.', tool_calls: [], provider: 'Cloudflare Workers AI', model: MODEL,
    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
  });
});

test('le relais OpenAI reçoit toujours le contenu null et le dialogue d’origine', async (t) => {
  const messages = conversation();
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    assert.deepEqual(body.messages, messages);
    assert.deepEqual(body.tools, tools);
    return Response.json({ choices: [{ message: { content: 'Le mur mesure 2,77 m.' } }] });
  });
  const response = await worker.fetch(request(messages), {
    ALLOWED_ORIGINS: ORIGIN,
    MODEL,
    GROQ_API_KEY: 'test-key',
    AI: { async run() { throw new Error('Service unavailable'); } },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { provider: string }).provider, 'Groq');
});
