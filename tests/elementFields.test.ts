import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateAppearanceRules, validateAppearanceRules } from '../src/data/appearanceRules.ts';
import { PropertyStore } from '../src/data/metadata.ts';
import { buildSystemPrompt } from '../src/assistant/prompt.ts';
import { resolveProperty, runTool, type ToolContext } from '../src/assistant/tools.ts';
import type { AppearanceRule } from '../src/data/appearanceRules.ts';

/** Le cas de la revue : trois « Mur pignon est » (un par niveau), le nom n'étant dans aucune propriété. */
function gables() {
  const keys = ['ouest-rdc', 'est-rdc', 'est-r1', '1LVqDbHM1SRg8h_tXAXntZ', 'dalle'];
  const labels = ['Mur pignon ouest', 'Mur pignon est', 'Mur pignon est', 'Mur pignon est', 'Dalle'];
  const levels = ['RDC', 'RDC', 'R+1', 'R+2', 'R+2'];
  const store = new PropertyStore(keys.length);
  keys.forEach((_, i) => store.set(i, { Catégorie: i === 4 ? 'Dalle' : 'Mur', Niveau: levels[i], 'Dimensions / Longueur (m)': 11.8 }, labels[i]));
  store.finalize();
  const selected: number[][] = [];
  let rules: AppearanceRule[] = [];
  const context: ToolContext = {
    store, count: keys.length, keys, labelOf: (i) => labels[i], selection: new Set(),
    select: (indices) => { selected.push(indices); },
    setVisible: () => {}, showAll: () => {},
    get appearanceRules() { return rules; },
    setAppearanceRules: (next) => { rules = next; },
  };
  return { store, keys, labels, context, selected, rulesOf: () => rules };
}

test('les règles d’apparence lisent le nom affiché (#nom) et l’identifiant (#id) des éléments', () => {
  const { store, keys, labels } = gables();
  const element = { keys, label: (i: number) => labels[i] };
  const byName = evaluateAppearanceRules(store, [{ id: 'a', enabled: true, conditions: [{ property: '#nom', op: 'equals', value: 'mur pignon EST' }], color: '#00ff00' }], element);
  assert.deepEqual([...byName.keys()], [1, 2, 3]);
  const byId = evaluateAppearanceRules(store, [{ id: 'b', enabled: true, conditions: [{ property: '#id', op: 'equals', value: '1LVqDbHM1SRg8h_tXAXntZ' }], color: '#00ff00' }], element);
  assert.deepEqual([...byId.keys()], [3]);
  // Validation : champs d'élément acceptés en condition, refusés pour l'opacité par propriété.
  assert.equal(validateAppearanceRules([{ id: 'c', enabled: true, conditions: [{ property: '#id', op: 'equals', value: 'x' }], color: '#123456' }], store).length, 1);
  assert.throws(() => validateAppearanceRules([{ id: 'd', enabled: true, conditions: [], opacityBy: { property: '#nom', scale: 'percent' } }], store), /numérique/);
});

test('resolveProperty : « #id », « identifiant » et « nom » désignent l’élément quand aucune propriété ne s’appelle ainsi', () => {
  const { store } = gables();
  assert.equal(resolveProperty(store, '#id'), '#id');
  assert.equal(resolveProperty(store, 'Identifiant'), '#id');
  assert.equal(resolveProperty(store, 'GlobalId'), '#id');
  assert.equal(resolveProperty(store, 'nom'), '#nom');
  assert.match((resolveProperty(store, 'Catégorie / Nom') as { error: string }).error, /#nom/);
  // Une vraie propriété « Nom » garde la priorité.
  const named = new PropertyStore(1);
  named.set(0, { Nom: 'Mur A' });
  named.finalize();
  assert.equal(resolveProperty(named, 'nom'), 'Nom');
});

test('mettre en évidence par identifiant vise un seul élément, même si son nom est partagé', () => {
  const { context, selected, rulesOf } = gables();
  const outcome = runTool('select_elements', { filters: [{ property: '#id', op: 'equals', value: '1LVqDbHM1SRg8h_tXAXntZ' }], highlight: true }, context);
  assert.deepEqual(selected, [[3]]);
  assert.equal(outcome.note, '1 élément mis en évidence');
  assert.deepEqual((outcome.result as { elements: string[] }).elements, ['Mur pignon est']);
  assert.deepEqual(rulesOf()[1].conditions, [{ property: '#id', op: 'equals', value: '1LVqDbHM1SRg8h_tXAXntZ' }]);
  // Par le nom : les trois pignons est, nommés dans le résultat pour que le modèle le voie.
  const byName = runTool('select_elements', { filters: [{ property: '#nom', op: 'equals', value: 'Mur pignon est' }], highlight: true }, context).result as { count: number; elements: string[] };
  assert.equal(byName.count, 3);
  assert.deepEqual(byName.elements, ['Mur pignon est', 'Mur pignon est', 'Mur pignon est']);
  // Nom + niveau : un seul.
  runTool('select_elements', { filters: [{ property: '#nom', op: 'equals', value: 'Mur pignon est' }, { property: 'Niveau', op: 'equals', value: 'R+2' }] }, context);
  assert.deepEqual(selected[selected.length - 1], [3]);
});

test('aucun élément trouvé : une erreur qui oriente, et rien n’est sélectionné ni atténué', () => {
  const { context, selected, rulesOf } = gables();
  const outcome = runTool('select_elements', { filters: [{ property: 'Catégorie', op: 'equals', value: 'Mur pignon est' }], highlight: true }, context);
  assert.equal(outcome.note, 'Aucun élément concerné');
  assert.match(String((outcome.result as { error: string }).error), /#nom/);
  assert.equal(selected.length, 0);
  assert.equal(rulesOf().length, 0);
  assert.match(runTool('count_by', { property: '#nom' }, context).note, /impossible/);
});

test('le message système donne un exemple réel de propriété imbriquée et explique #nom / #id', () => {
  const { store } = gables();
  const prompt = buildSystemPrompt({ fileName: 'demo.glb', count: 5, store });
  assert.doesNotMatch(prompt, /« Catégorie \/ Nom »/);
  assert.match(prompt, /« Dimensions \/ Longueur \(m\) »/);
  assert.match(prompt, /"#nom" et "#id"/);
});
