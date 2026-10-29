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

test('un appel d’outil écrit dans le texte par Llama devient un vrai appel', async () => {
  const call = [{ id: 'call_text_0', name: 'get_element', arguments: { query: 'Mur test' } }];
  const cases: [unknown, unknown, unknown][] = [
    // Texte JSON au format natif de Llama, avec ou sans <|python_tag|>.
    ['<|python_tag|>{"name": "get_element", "parameters": {"query": "Mur test"}}', [], call],
    // Workers AI a déjà relu ce JSON en objet.
    [{ name: 'get_element', parameters: { query: 'Mur test' } }, [], call],
    // Appel normal dont les arguments s'appellent « parameters ».
    ['', [{ name: 'get_element', parameters: { query: 'Mur test' } }], [{ ...call[0], id: 'call_0' }]],
  ];
  for (const [responseText, toolCalls, expected] of cases) {
    const response = await worker.fetch(request(conversation()), {
      ALLOWED_ORIGINS: ORIGIN,
      MODEL,
      AI: { async run() { return { response: responseText, tool_calls: toolCalls }; } },
    });
    const reply = await response.json() as { content: string; tool_calls: unknown };
    assert.deepEqual(reply.tool_calls, expected);
    assert.equal(reply.content, '');
  }

  // Un JSON qui n'appelle pas un outil proposé reste du texte, au lieu d'une réponse vide.
  const other = await worker.fetch(request(conversation()), {
    ALLOWED_ORIGINS: ORIGIN,
    MODEL,
    AI: { async run() { return { response: { name: 'delete_everything', parameters: {} }, tool_calls: [] }; } },
  });
  const reply = await other.json() as { content: string; tool_calls: unknown[] };
  assert.deepEqual(reply.tool_calls, []);
  assert.equal(reply.content, '{"name":"delete_everything","parameters":{}}');
});
