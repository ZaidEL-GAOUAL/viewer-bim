import assert from 'node:assert/strict';
import { test } from 'node:test';
import { trimHistory, type Message } from '../src/assistant/client.ts';
import { buildSystemPrompt, summarizeProperties } from '../src/assistant/prompt.ts';
import { TOOL_DEFINITIONS, resolveProperty, runTool, type ToolContext } from '../src/assistant/tools.ts';
import { PropertyStore, type PropValue } from '../src/data/metadata.ts';

function sampleContext() {
  const store = new PropertyStore(6);
  store.set(0, { 'Classe IFC': 'IfcWall', Nom: 'Mur A', Niveau: 'RDC', Matériaux: 'Béton', 'Pset_WallCommon / FireRating': 'REI 120', 'Qto_WallBaseQuantities / NetVolume': 5.6 }, 'Mur A');
  store.set(1, { 'Classe IFC': 'IfcWall', Nom: 'Mur B', Niveau: 'RDC', 'Pset_WallCommon / FireRating': '', 'Qto_WallBaseQuantities / NetVolume': 2.1 }, 'Mur B');
  store.set(2, { 'Classe IFC': 'IfcDoor', Nom: 'Porte 1', Niveau: 'R+1', Matériaux: 'Bois' }, 'Porte 1');
  store.set(3, { 'Classe IFC': 'IfcSlab', Nom: 'Dalle', Niveau: 'R+1', Matériaux: 'Béton' }, 'Dalle');
  store.set(4, { 'Classe IFC': 'IfcColumn', Nom: 'Poteau', Niveau: 'RDC', Matériaux: 'Béton' }, 'Poteau');
  store.finalize();
  store.readOnly = ['Classe IFC', 'Niveau', 'Matériaux', 'Qto_*'];

  const selected: number[][] = [];
  const isolated: boolean[] = [];
  const context: ToolContext = {
    store,
    count: 6,
    keys: ['a', 'b', 'c', 'd', 'e', 'f'],
    labelOf: (index) => store.labelOf(index) ?? `élément ${index}`,
    selection: new Set([0, 1]),
    select: (indices, isolate) => {
      selected.push(indices);
      isolated.push(isolate);
    },
    edit: (indices, path, value: PropValue) => {
      if (!store.isEditable(path)) return 'locked';
      let changed = 0;
      for (const index of indices) if (store.update(index, path, value)) changed++;
      return changed;
    },
  };
  return { store, context, selected, isolated };
}

test('resolveProperty retrouve un nom exact, approximatif ou par son dernier segment', () => {
  const { store } = sampleContext();
  assert.equal(resolveProperty(store, 'Niveau'), 'Niveau');
  assert.equal(resolveProperty(store, 'niveau'), 'Niveau');
  assert.equal(resolveProperty(store, 'materiaux'), 'Matériaux');
  assert.equal(resolveProperty(store, 'FireRating'), 'Pset_WallCommon / FireRating');
  assert.equal(resolveProperty(store, 'Pset_WallCommon/FireRating'), 'Pset_WallCommon / FireRating');
  assert.match((resolveProperty(store, 'Inconnue') as { error: string }).error, /introuvable/);
});

test('count_by et find_elements filtrent sur le modèle ou la sélection', () => {
  const { context } = sampleContext();
  const counts = runTool('count_by', { property: 'Niveau' }, context).result as { total: number; values: { value: unknown; count: number }[] };
  assert.equal(counts.total, 6);
  assert.deepEqual(counts.values, [
    { value: 'RDC', count: 3 },
    { value: 'R+1', count: 2 },
    { value: null, count: 1 },
  ]);

  const walls = runTool('find_elements', { filters: [{ property: 'classe ifc', op: 'equals', value: 'ifcwall' }], properties: ['Nom'] }, context);
  const found = walls.result as { count: number; elements: { label: string; Nom: string }[] };
  assert.equal(found.count, 2);
  assert.deepEqual(found.elements.map((item) => item.Nom), ['Mur A', 'Mur B']);
  assert.equal(walls.note, '2 éléments trouvés');

  // Valeur vide = manquante ; comparaison numérique ; périmètre « sélection ».
  const noRating = runTool('find_elements', { filters: [{ property: 'FireRating', op: 'missing' }] }, context).result as { count: number };
  assert.equal(noRating.count, 5);
  const big = runTool('find_elements', { filters: [{ property: 'NetVolume', op: 'greater', value: '3' }] }, context).result as { count: number };
  assert.equal(big.count, 1);
  const inSelection = runTool('count_by', { property: 'Matériaux', scope: 'selection' }, context).result as { total: number; values: { value: unknown; count: number }[] };
  assert.equal(inSelection.total, 2);
  assert.deepEqual(inSelection.values, [{ value: 'Béton', count: 1 }, { value: null, count: 1 }]);
});

test('set_property respecte les verrous, crée des propriétés et convertit les valeurs', () => {
  const { store, context } = sampleContext();
  const locked = runTool('set_property', { filters: [], property: 'Niveau', value: 'R+2' }, context);
  assert.match(locked.note, /verrouillée/);
  assert.equal(store.propsOf(0)?.Niveau, 'RDC');

  const lot = runTool('set_property', { filters: [{ property: 'Classe IFC', op: 'equals', value: 'IfcWall' }], property: 'Chantier / Lot', value: 'Gros œuvre' }, context);
  assert.deepEqual(lot.result, { property: 'Chantier / Lot', value: 'Gros œuvre', elements: 2, changed: 2 });
  assert.equal(store.propsOf(1)?.['Chantier / Lot'], 'Gros œuvre');
  assert.equal(store.propsOf(2)?.['Chantier / Lot'], undefined);

  const numeric = runTool('set_property', { filters: [], scope: 'selection', property: 'Pset_WallCommon / FireRating', value: '90' }, context);
  assert.equal((numeric.result as { changed: number }).changed, 2);
  assert.equal(store.propsOf(0)?.['Pset_WallCommon / FireRating'], 90);
  const flag = runTool('set_property', { filters: [], scope: 'selection', property: 'Pset_WallCommon / IsExternal', value: 'true' }, context);
  assert.equal((flag.result as { changed: number }).changed, 2);
  assert.equal(store.propsOf(0)?.['Pset_WallCommon / IsExternal'], true);
});

test('select_elements et get_element agissent sur la vue et lisent une fiche', () => {
  const { context, selected, isolated } = sampleContext();
  const outcome = runTool('select_elements', { filters: [{ property: 'Matériaux', op: 'equals', value: 'Béton' }], isolate: true }, context);
  assert.deepEqual(selected, [[0, 3, 4]]);
  assert.deepEqual(isolated, [true]);
  assert.equal(outcome.note, '3 éléments isolés');

  const sheet = runTool('get_element', { query: 'porte' }, context).result as { elements: { label: string; properties: Record<string, unknown> }[] };
  assert.equal(sheet.elements[0].label, 'Porte 1');
  assert.equal(sheet.elements[0].properties['Matériaux'], 'Bois');
  assert.match((runTool('get_element', { query: 'zzz' }, context).result as { error: string }).error, /Aucun élément/);
  assert.match((runTool('inconnu', {}, context).result as { error: string }).error, /inconnu/);
});

test('le message système résume les propriétés sans dépasser quelques milliers de caractères', () => {
  const { store } = sampleContext();
  const summary = summarizeProperties(store);
  assert.match(summary, /- Niveau \[verrouillée\] : RDC \(3\), R\+1 \(2\) ; non défini \(1\)/);
  assert.match(summary, /Pset_WallCommon : FireRating/);
  assert.match(summary, /Qto_WallBaseQuantities \[verrouillée\] : NetVolume/);
  const prompt = buildSystemPrompt({ fileName: 'test.glb', count: 6, store });
  assert.match(prompt, /« test.glb », 6 éléments, 5 avec des propriétés/);
  assert.match(prompt, /verrouillées .* : Classe IFC, Niveau, Matériaux, Qto_\*/);

  // Un modèle aux valeurs toutes différentes ne liste que des exemples, et la taille reste bornée.
  const wide = new PropertyStore(3000);
  for (let i = 0; i < 3000; i++) {
    const props: Record<string, PropValue> = { Identifiant: `ID-${i}` };
    for (let p = 0; p < 80; p++) props[`Prop ${p}`] = i % 7;
    for (let c = 0; c < 60; c++) props[`Pset_${c} / Valeur`] = i;
    wide.set(i, props);
  }
  wide.finalize();
  const wideSummary = summarizeProperties(wide);
  assert.ok(wideSummary.length < 8000, `résumé de ${wideSummary.length} caractères`);
  assert.match(wideSummary, /et 41 autres propriétés générales/);
  assert.match(wideSummary, /et 20 autres catégories/);
  assert.match(wideSummary, /Identifiant : plus de 10 valeurs distinctes, ex\. ID-0/);
});

test('trimHistory garde le message système et des échanges complets', () => {
  const messages: Message[] = [{ role: 'system', content: 'S' }];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'user', content: `q${i}` });
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'count_by', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: `c${i}`, content: '{}' });
    messages.push({ role: 'assistant', content: `r${i}` });
  }
  const trimmed = trimHistory(messages);
  assert.equal(trimmed[0].role, 'system');
  assert.equal(trimmed[1].role, 'user');
  assert.ok(trimmed.length <= 41);
  assert.equal(trimmed[trimmed.length - 1], messages[messages.length - 1]);
});

test('les définitions d’outils sont au format OpenAI et nomment des outils implémentés', () => {
  const names = TOOL_DEFINITIONS.map((tool) => tool.function.name);
  assert.deepEqual(names, ['list_properties', 'count_by', 'find_elements', 'get_element', 'select_elements', 'set_property']);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.parameters.type, 'object');
    for (const [name, schema] of Object.entries(tool.function.parameters.properties)) {
      assert.ok((schema as { description?: string }).description, `${tool.function.name}.${name} sans description`);
    }
  }
});
