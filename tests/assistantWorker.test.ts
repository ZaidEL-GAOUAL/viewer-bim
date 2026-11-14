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
  const call = { name: 'get_element', arguments: { query: 'Mur test' } };
  const cases: [unknown, unknown, RegExp][] = [
    // Texte JSON au format natif de Llama, avec ou sans <|python_tag|>.
    ['<|python_tag|>{"name": "get_element", "parameters": {"query": "Mur test"}}', [], /^call_[0-9a-f]{8}_text$/],
    // Workers AI a déjà relu ce JSON en objet.
    [{ name: 'get_element', parameters: { query: 'Mur test' } }, [], /^call_[0-9a-f]{8}_text$/],
    // Appel normal dont les arguments s'appellent « parameters ».
    ['', [{ name: 'get_element', parameters: { query: 'Mur test' } }], /^call_[0-9a-f]{8}_0$/],
  ];
  const ids = new Set<string>();
  for (const [responseText, toolCalls, id] of cases) {
    for (let round = 0; round < 2; round++) {
      const response = await worker.fetch(request(conversation()), {
        ALLOWED_ORIGINS: ORIGIN,
        MODEL,
        AI: { async run() { return { response: responseText, tool_calls: toolCalls }; } },
      });
      const reply = await response.json() as { content: string; tool_calls: { id: string; name: string; arguments: unknown }[] };
      assert.equal(reply.tool_calls.length, 1);
      assert.deepEqual({ name: reply.tool_calls[0].name, arguments: reply.tool_calls[0].arguments }, call);
      assert.match(reply.tool_calls[0].id, id);
      ids.add(reply.tool_calls[0].id);
      assert.equal(reply.content, '');
    }
  }
  assert.equal(ids.size, 6, 'un identifiant ne se répète pas d’une étape à l’autre (call_text_0 à chaque fois)');

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

test('des arguments illisibles ne deviennent jamais un appel à arguments vides', async () => {
  const response = await worker.fetch(request(conversation()), {
    ALLOWED_ORIGINS: ORIGIN,
    MODEL,
    AI: { async run() { return { response: '', tool_calls: [{ name: 'get_element', arguments: '{"query": "Mur' }] }; } },
  });
  const reply = await response.json() as { content: string; tool_calls: unknown[] };
  assert.deepEqual(reply.tool_calls, []);
  assert.match(reply.content, /get_element avec des arguments illisibles ; rien n’a été fait/);
});

/** Requête du viewer actuel : pas de `tools`, réponse en texte. */
function plainRequest(extra: Record<string, unknown> = {}) {
  return new Request('https://worker.test/chat', {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'masque le niveau R+2' }], ...extra }),
  });
}

test('sans tools : simple conversation, mode JSON chez un fournisseur compatible OpenAI, rien d’autre ne change', async (t) => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return Response.json({ choices: [{ message: { content: '{"tool":"set_visibility","args":{"filters":[],"visible":false}}' } }] });
  });
  let workersInput: Record<string, unknown> = {};
  const response = await worker.fetch(plainRequest(), {
    ALLOWED_ORIGINS: ORIGIN, MODEL, GROQ_API_KEY: 'test-key',
    AI: { async run(_model, input) { workersInput = input; throw new Error('Service unavailable'); } },
  });
  assert.equal('tools' in workersInput, false);
  assert.equal('response_format' in workersInput, false, 'mode JSON de Workers AI non vérifié : pas demandé');
  assert.deepEqual(bodies[0].response_format, { type: 'json_object' });
  assert.equal('tools' in bodies[0], false);
  const reply = await response.json() as { content: string; tool_calls: unknown[]; provider: string };
  assert.deepEqual([reply.content, reply.tool_calls, reply.provider], ['{"tool":"set_visibility","args":{"filters":[],"visible":false}}', [], 'Groq']);
});

test('mode JSON refusé par le service (HTTP 400) : une seconde demande sans', async (t) => {
  const formats: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    formats.push(body.response_format);
    return body.response_format ? new Response('json_validate_failed', { status: 400 }) : Response.json({ choices: [{ message: { content: '{"answer":"ok"}' } }] });
  });
  const response = await worker.fetch(plainRequest(), { ALLOWED_ORIGINS: ORIGIN, MODEL, GROQ_API_KEY: 'k', AI: { async run() { throw new Error('down'); } } });
  assert.equal(response.status, 200);
  assert.deepEqual(formats, [{ type: 'json_object' }, undefined]);
});

test('un fournisseur épinglé par le tour est le seul tenté : le tour ne change pas de modèle en route', async (t) => {
  t.mock.method(console, 'error', () => {});
  let groq = 0;
  t.mock.method(globalThis, 'fetch', async () => { groq++; return Response.json({ choices: [{ message: { content: '{"answer":"Groq"}' } }] }); });
  const env = { ALLOWED_ORIGINS: ORIGIN, MODEL, GROQ_API_KEY: 'k', AI: { async run(): Promise<unknown> { throw new Error('AI_ERROR: 3040: busy'); } } };
  const pinned = await worker.fetch(plainRequest({ provider: 'Cloudflare Workers AI' }), env);
  assert.equal(pinned.status, 503);
  assert.equal(groq, 0, 'pas de repli vers Groq au milieu d’un tour');
  // Sans épingle (première étape), ou avec un nom inconnu, l'ordre habituel s'applique.
  assert.equal((await (await worker.fetch(plainRequest({ provider: 'inconnu' }), env)).json() as { provider: string }).provider, 'Groq');
});

test('un fournisseur qui ne répond pas est abandonné après 25 s', async (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = worker.fetch(plainRequest(), { ALLOWED_ORIGINS: ORIGIN, MODEL, AI: { run: () => new Promise(() => {}) } });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(25_000);
  const response = await pending;
  assert.equal(response.status, 503);
  assert.deepEqual((await response.json() as { failures: unknown[] }).failures, [{ provider: 'Cloudflare Workers AI', kind: 'timeout' }]);
});
