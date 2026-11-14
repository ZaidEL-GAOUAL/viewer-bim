// Enregistre la réponse brute d'un modèle à chaque phrase du corpus (première étape du protocole
// texte : le message système du viewer et la phrase), pour que les tests et le barème la relisent
// ensuite sans réseau. À LANCER À LA MAIN PAR LE PROPRIÉTAIRE : chaque phrase est un appel au modèle
// et consomme du quota. Jamais en CI, jamais dans les tests.
//
//   node scripts/record-assistant.ts --relay https://viewer-bim.<compte>.workers.dev [--origin https://zaidel-gaoual.github.io]
//        [--provider Groq] [--limit 20] [--yes]
//   Avec une API personnelle (passée par le relais, comme dans l'onglet Assistant) :
//        read -s ASSISTANT_API_KEY && export ASSISTANT_API_KEY
//        node scripts/record-assistant.ts --relay … --endpoint https://api.groq.com/openai/v1/chat/completions --model llama-3.3-70b-versatile
//
// Résultat : tests/fixtures/assistant/replies/recorded/<fournisseur — modèle>/<n° de phrase>.json,
// puis `node scripts/scorecard-assistant.ts` pour le barème.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { buildSystemPrompt } from '../src/assistant/prompt.ts';
import { PropertyStore, type FlatProps } from '../src/data/metadata.ts';

interface Model { readOnly: string[]; elements: { key: string; label: string | null; props: FlatProps | null }[] }

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const relay = option('relay')?.replace(/\/$/, '');
const origin = option('origin') ?? 'https://zaidel-gaoual.github.io';
const provider = option('provider');
const limit = Number(option('limit') ?? Infinity);
const endpoint = option('endpoint');
const apiModel = option('model');
// Le relais n'accepte que 20 requêtes par minute et par adresse.
const PAUSE_MS = 3500;

if (!relay) {
  console.error('Indiquez --relay https://… (l’adresse du worker). Voir l’en-tête de ce script.');
  process.exit(1);
}
const key = process.env.ASSISTANT_API_KEY?.trim();
if (endpoint && (!key || !apiModel)) {
  console.error('Avec --endpoint : --model, et la clé dans ASSISTANT_API_KEY (saisie masquée : read -s ASSISTANT_API_KEY).');
  process.exit(1);
}
const api = endpoint ? { endpoint, apiKey: key!, model: apiModel! } : undefined;

const corpus = JSON.parse(readFileSync(join(root, 'tests/fixtures/assistant/corpus.json'), 'utf8')) as { models: Record<string, Model>; cases: { model: string; text: string }[] };
const prompts = new Map(Object.entries(corpus.models).map(([name, model]) => {
  const store = new PropertyStore(model.elements.length);
  model.elements.forEach((element, i) => store.set(i, element.props ?? undefined, element.label ?? undefined));
  store.finalize();
  store.readOnly = model.readOnly;
  return [name, buildSystemPrompt({ fileName: `${name}.glb`, count: model.elements.length, store })];
}));
const cases = corpus.cases.slice(0, limit);

if (!args.includes('--yes')) {
  const ask = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await ask.question(`${cases.length} appels au modèle via ${relay}${provider ? ` (fournisseur ${provider})` : ''}${api ? ` (API ${new URL(api.endpoint).hostname}, ${api.model})` : ''} : cela consomme du quota. Continuer ? (o/N) `);
  ask.close();
  if (!/^o(ui)?$/i.test(answer.trim())) process.exit(0);
}

for (const [index, item] of cases.entries()) {
  const messages = [{ role: 'system', content: prompts.get(item.model)! }, { role: 'user', content: item.text }];
  const response = await fetch(`${relay}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ messages, ...(provider ? { provider } : {}), ...(api ? { api } : {}) }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => ({})) as { content?: string; provider?: string; model?: string; usage?: unknown; error?: string };
  const who = body.provider ?? provider ?? (api ? new URL(api.endpoint).hostname : 'inconnu');
  const folder = join(root, 'tests/fixtures/assistant/replies/recorded', `${who} — ${body.model ?? api?.model ?? 'modèle inconnu'}`.replace(/[\\/:*?"<>|@]+/g, '_'));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${String(index).padStart(3, '0')}.json`), `${JSON.stringify({
    source: 'recorded', recordedAt: new Date().toISOString(), provider: who, model: body.model ?? api?.model ?? null,
    case: index, corpusModel: item.model, text: item.text, raw: response.ok ? body.content ?? '' : null,
    ...(response.ok ? { usage: body.usage } : { status: response.status, error: body.error }),
  }, null, 2)}\n`);
  console.log(`${index + 1}/${cases.length} ${response.ok ? 'ok' : `HTTP ${response.status}`} « ${item.text} »`);
  if (response.status === 429 || response.status === 503) {
    console.error(`Arrêt : ${body.error ?? 'quota ou fournisseur indisponible'}.`);
    break;
  }
  await sleep(PAUSE_MS);
}
