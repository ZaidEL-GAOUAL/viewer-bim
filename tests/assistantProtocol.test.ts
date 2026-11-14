// Couche 2 : le modèle répond par un objet JSON en texte. Ces tests rejouent des réponses écrites à
// la main dans chaque dialecte rencontré, sans appeler aucun modèle ni aucun réseau.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { AssistantError, runTurn, type Message, type TurnEvents } from '../src/assistant/client.ts';
import { MAX_RESULT_CHARS, capResult, parseAction, retryMessage, toolLines } from '../src/assistant/protocol.ts';
import { coerceArgs, toIsoDate } from '../src/assistant/schema.ts';
import { runTool, type ToolContext } from '../src/assistant/tools.ts';
import { PropertyStore } from '../src/data/metadata.ts';

const REPLIES = new URL('./fixtures/assistant/replies/', import.meta.url);

test('chaque dialecte de réponse enregistré se relit en une action validée, ou en une erreur exacte', () => {
  const files = readdirSync(REPLIES).filter((name) => name.endsWith('.json') && !name.startsWith('._'));
  assert.ok(files.length >= 10, `${files.length} échantillons`);
  for (const file of files) {
    const sample = JSON.parse(readFileSync(new URL(file, REPLIES), 'utf8')) as { raw: string; expect: { error?: string; tool?: string } & Record<string, unknown> };
    const action = parseAction(sample.raw);
    if (sample.expect.error !== undefined) {
      assert.ok('error' in action, `${file} : erreur attendue`);
      assert.ok(action.error.includes(sample.expect.error), `${file} : « ${action.error} »`);
      assert.equal(action.tool, sample.expect.tool, `${file} : outil visé par la seconde chance`);
    } else {
      assert.deepEqual(action, sample.expect, file);
    }
  }
});

test('coerceArgs : booléen, nombre et date en texte, liste réduite, opérateur en symbole, « sélection »', () => {
  assert.deepEqual(coerceArgs('select_elements', { filters: { property: 'Niveau', op: '>=', value: 2 }, isolate: 'oui', highlight: 0, scope: 'Sélection' }), {
    args: { filters: [{ property: 'Niveau', op: 'greater_or_equal', value: 2 }], scope: 'selection', isolate: true, highlight: false },
  });
  assert.deepEqual(coerceArgs('plan_dates', { start: '4 janvier 2026', end: '12/12/2027', minDays: '15', maxDays: '45,0', orderBy: 'Code étage' }), {
    args: { start: '2026-01-04', end: '2027-12-12', minDays: 15, maxDays: 45, orderBy: ['Code étage'] },
  });
  // Les règles d'apparence aussi : règle seule, enabled par défaut, conditions en texte JSON.
  assert.deepEqual(coerceArgs('update_view', { rules: { id: 'r', conditions: '[{"property":"Niveau","op":"!=","value":"RDC"}]', opacity: '0.4' } }), {
    args: { rules: [{ id: 'r', enabled: true, conditions: [{ property: 'Niveau', op: 'not_equals', value: 'RDC' }], opacity: 0.4 }] },
  });
  // null ou texte vide sur un champ facultatif : absent. null reste une valeur là où le schéma l'admet.
  assert.deepEqual(coerceArgs('set_property', { filters: [], property: 'Lot', value: null, scope: '', dryRun: null }), { args: { filters: [], property: 'Lot', value: null } });
});

test('coerceArgs refuse avec un message exact : rien n’est deviné', () => {
  const error = (name: string, args: unknown) => (coerceArgs(name, args) as { error: string }).error;
  assert.equal(error('isoler', {}), 'Outil inconnu « isoler ». Outils : list_properties, count_by, find_elements, get_element, select_elements, set_visibility, compute, get_view_settings, update_view, set_property, plan_dates.');
  assert.match(error('select_elements', { isolate: true }), /^select_elements — filters : argument obligatoire manquant \(\[\] pour tous les éléments\)\.$/);
  assert.match(error('select_elements', { filters: [], isolate: 'peut-être' }), /isolate : « peut-être » n’est pas un booléen/);
  assert.match(error('find_elements', { filters: [{ property: 'Niveau', op: 'environ', value: 1 }] }), /filters\[0\]\.op : « environ » inconnu, attendu equals, /);
  assert.match(error('find_elements', { filters: [], zoom: true }), /zoom : argument inconnu\. Arguments possibles : filters, properties, scope, limit\./);
  assert.match(error('plan_dates', { start: 'janvier', end: '2027-01-01', minDays: 1, maxDays: 2 }), /start : date « janvier » illisible/);
  assert.match(error('plan_dates', { start: '2026-02-30', end: '2027-01-01', minDays: 1, maxDays: 2 }), /illisible/);
  assert.match(error('count_by', '{"property":'), /objet JSON/);
  assert.match(error('find_elements', { filters: [{ property: 'Niveau', value: { a: 1 } }] }), /value : .* n’est pas une valeur simple/);
});

test('plan_dates : une durée par groupe se passe de end ; « end: "" » reste refusé', () => {
  assert.deepEqual(parseAction('{"tool":"plan_dates","args":{"start":"2027-03-02","daysPerGroup":21,"orderBy":["Niveau"]}}'), {
    tool: 'plan_dates', args: { start: '2027-03-02', daysPerGroup: 21, orderBy: ['Niveau'] },
  });
  // Ce que le modèle a envoyé lors de l'essai : une fin vide n'est pas une date.
  const trial = parseAction('{"tool":"plan_dates","args":{"filters":[],"start":"2027-03-02","end":"","orderBy":"Niveau","order":"asc","minDays":21,"maxDays":21}}');
  assert.deepEqual(trial, { error: 'plan_dates — end : date «  » illisible, attendu AAAA-MM-JJ.', tool: 'plan_dates' });
  assert.match((parseAction('{"tool":"plan_dates","args":{"start":"2027-03-02","end":"","daysPerGroup":21,"orderBy":["Niveau"]}}') as { error: string }).error, /end : date «  » illisible/);
  assert.match((parseAction('{"tool":"plan_dates","args":{"start":"2027-03-02","daysPerGroup":21}}') as { error: string }).error, /orderBy : argument obligatoire avec daysPerGroup/);
  assert.match(toolLines(), /- count_by\(property, filters\?, scope\?\)/);
  assert.match(toolLines(), /- plan_dates\(filters\?, scope\?, start, end\?, minDays\?, maxDays\?, daysPerGroup\?, orderBy\?/);
});

test('toIsoDate lit les dates à la française, en ISO et en anglais, et refuse les dates impossibles', () => {
  assert.equal(toIsoDate('2026-1-4'), '2026-01-04');
  assert.equal(toIsoDate('04/01/2026'), '2026-01-04');
  assert.equal(toIsoDate('4.1.2026'), '2026-01-04');
  assert.equal(toIsoDate('1er mars 2026'), '2026-03-01');
  assert.equal(toIsoDate('12 Décembre 2027'), '2027-12-12');
  assert.equal(toIsoDate('January 4, 2026'), '2026-01-04');
  assert.equal(toIsoDate('31/02/2026'), undefined);
  assert.equal(toIsoDate('demain'), undefined);
});

test('capResult garde un objet lisible sous 8 000 caractères : listes raccourcies et signalées', () => {
  const big = { count: 400, elements: Array.from({ length: 400 }, (_, i) => ({ label: `Élément ${i}`, Niveau: 'R+1' })) };
  const capped = capResult(big) as { count: number; elements: unknown[]; truncated: string };
  assert.ok(JSON.stringify(capped).length <= MAX_RESULT_CHARS);
  assert.equal(capped.count, 400);
  assert.ok(capped.elements.length > 10 && capped.elements.length < 400);
  assert.match(capped.truncated, /coupé/);
  const small = { count: 1 };
  assert.equal(capResult(small), small, 'un résultat court passe tel quel');
  const text = capResult({ properties: { a: 'x'.repeat(9000) } }) as { partial: string };
  assert.equal(text.partial.length, MAX_RESULT_CHARS);
});

test('la seconde chance donne le schéma complet de l’outil visé, ou la liste des outils', () => {
  const known = retryMessage({ error: 'select_elements — filters : argument obligatoire manquant.', tool: 'select_elements' });
  assert.match(known, /^\[Réponse invalide\] select_elements — filters/);
  assert.match(known, /"isolate":\{"type":"boolean"/);
  const unknown = retryMessage({ error: 'Outil inconnu « isolate ».' });
  assert.match(unknown, /- select_elements\(filters, scope\?, isolate\?, highlight\?\)/);
  assert.equal(toolLines().split('\n').length, 11);
});

// --------------------------------------------------------------- tour complet

function sample() {
  const store = new PropertyStore(3);
  ['RDC', 'R+1', 'R+1'].forEach((level, i) => store.set(i, { Niveau: level }, `élément ${i}`));
  store.finalize();
  const hidden: number[][] = [];
  const context: ToolContext = { store, count: 3, keys: ['a', 'b', 'c'], labelOf: (i) => `élément ${i}`, selection: new Set(), select: () => {}, setVisible: (indices) => { hidden.push(indices); }, showAll: () => {} };
  const ran: string[] = [];
  const events: TurnEvents = { execute: (name, args) => { ran.push(name); return { outcome: runTool(name, args, context) }; }, onProvider: () => {} };
  return { context, hidden, ran, events };
}

/** Relais simulé : rend les réponses dans l'ordre et garde les corps envoyés. */
function relay(t: { mock: { method: (...args: never[]) => unknown } }, replies: string[], provider = 'Groq') {
  const bodies: { messages: Message[]; provider?: string; tools?: unknown }[] = [];
  (t.mock.method as (object: object, name: string, impl: unknown) => unknown)(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    const content = replies.shift();
    if (content === undefined) throw new Error('appel de trop');
    return Response.json({ content, provider, model: 'simulé', usage: {} });
  });
  return bodies;
}

test('un tour : JSON relu, outil exécuté, résultat renvoyé, fournisseur épinglé, aucun « tools » envoyé', async (t) => {
  const { events, hidden } = sample();
  const bodies = relay(t, ['<|python_tag|>{"name": "set_visibility", "parameters": {"filters": [{"property": "Niveau", "value": "R+1"}], "visible": "false"}}', '{"answer": ""}']);
  const messages: Message[] = [{ role: 'system', content: 'S' }];
  const turn = await runTurn('https://relay.test', messages, 'masque le R+1', events);
  assert.deepEqual(turn, { answer: '', ran: ['set_visibility'] });
  assert.deepEqual(hidden, [[1, 2]]);
  assert.equal('tools' in bodies[0], false);
  assert.equal(bodies[0].provider, undefined);
  assert.equal(bodies[1].provider, 'Groq', 'la seconde étape demande le même fournisseur');
  assert.match(bodies[1].messages[3].content, /^\[Résultat de set_visibility\] \{"changed":2/);
});

test('sortie invalide : une seconde chance avec le message exact, puis un message honnête sans rien exécuter', async (t) => {
  const { events, ran } = sample();
  const bodies = relay(t, ['{"tool": "select_elements", "args": {"isolate": true}}', '{"tool": "select_elements", "args": {"isolate": true}}']);
  const messages: Message[] = [{ role: 'system', content: 'S' }];
  const turn = await runTurn('https://relay.test', messages, 'isole', events);
  assert.equal(turn.ending, 'invalid');
  assert.match(turn.invalid!, /filters : argument obligatoire manquant/);
  assert.deepEqual(ran, [], 'jamais un appel à arguments vides');
  assert.equal(bodies.length, 2);
  assert.match(bodies[1].messages[3].content, /^\[Réponse invalide\] select_elements — filters : argument obligatoire manquant.*\nSchéma des arguments de select_elements : \{/s);
  assert.deepEqual(messages, [{ role: 'system', content: 'S' }], 'la demande sort de l’historique');
});

test('quatre étapes au plus ; une écriture à confirmer arrête le tour', async (t) => {
  const { events, ran } = sample();
  relay(t, Array(5).fill('{"tool": "count_by", "args": {"property": "Niveau"}}'));
  const turn = await runTurn('https://relay.test', [], 'boucle', events);
  assert.deepEqual([turn.ending, ran.length], ['rounds', 4]);

  t.mock.restoreAll();
  relay(t, ['{"tool": "list_properties", "args": {}}', '{"answer": "jamais lu"}']);
  const messages: Message[] = [];
  const waiting = await runTurn('https://relay.test', messages, 'écris', { ...events, execute: (name, args) => ({ outcome: runTool(name, args, sample().context), stop: true }) });
  assert.deepEqual([waiting.ending, waiting.answer], ['confirm', null]);
  assert.equal(messages[messages.length - 1].role, 'assistant', 'l’historique reste alterné');
});

test('une écriture demandée juste après une réponse invalide est marquée pour l’aperçu ; au premier essai, non', async (t) => {
  const calls: [string, boolean][] = [];
  const execute: TurnEvents['execute'] = (name, _args, preview) => { calls.push([name, preview]); return { outcome: { result: { count: 1 }, note: '' } }; };
  const write = '{"tool": "set_property", "args": {"filters": [], "property": "Lot", "value": "GO"}}';
  relay(t, ['{"tool": "set_property", "args": {"property": "Lot"}}', write, write, '{"answer": ""}']);
  await runTurn('https://relay.test', [], 'mets Lot à GO', { execute, onProvider: () => {} });
  assert.deepEqual(calls, [['set_property', true], ['set_property', false]], 'seule l’étape qui suit le refus est marquée');

  t.mock.restoreAll();
  calls.length = 0;
  relay(t, [write, '{"answer": ""}']);
  await runTurn('https://relay.test', [], 'mets Lot à GO', { execute, onProvider: () => {} });
  assert.deepEqual(calls, [['set_property', false]]);
});

test('un relais muet au-delà de 60 s : erreur claire, panneau en commandes seulement', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('signal timed out', 'TimeoutError'); });
  const messages: Message[] = [];
  await assert.rejects(runTurn('https://relay.test', messages, 'question', sample().events), (error: unknown) => error instanceof AssistantError && error.unreachable && /60 s/.test(error.message));
  assert.deepEqual(messages, []);
});

test('le barème compare l’action relue à l’attente du corpus, sans réseau', async () => {
  const { scoreAction } = await import('../scripts/scorecard-assistant.ts');
  const expect = { tool: 'select_elements', args: { filters: [{ property: 'Niveau', op: 'equals', value: 'R+1' }], isolate: true } };
  assert.equal(scoreAction(parseAction('{"tool":"select_elements","args":{"filters":[{"property":"niveau","value":"R+1"}],"isolate":"true","scope":"model"}}'), expect), 'ok');
  assert.equal(scoreAction(parseAction('{"tool":"select_elements","args":{"filters":[{"property":"Niveau","value":"R+1"}]}}'), expect), 'wrong', 'sélectionner n’est pas isoler');
  assert.equal(scoreAction(parseAction('{"tool":"select_elements","args":{"filters":[{"property":"Niveau","value":"R+1"}],"isolate":true,"highlight":true}}'), expect), 'wrong');
  assert.equal(scoreAction(parseAction('{"tool": "select_elements"'), expect), 'invalid');
  assert.equal(scoreAction(parseAction('{"answer":"Quel niveau ?"}'), { ambiguity: ['a', 'b'] }), 'ok');
  assert.equal(scoreAction(parseAction('{"answer":"Non"}'), null), 'skipped');
  const colour = { tool: 'update_view', args: { rules: [{ id: 'x', name: 'n', enabled: true, conditions: [{ property: 'Catégorie', op: 'equals', value: 'Murs' }], color: '#e53935' }] } };
  assert.equal(scoreAction(parseAction('{"tool":"update_view","args":{"rules":[{"id":"murs-rouges","conditions":[{"property":"Categorie","value":"murs"}],"color":"#E53935"}]}}'), colour), 'ok');
});
