import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactHistory, trimHistory, type Message } from '../src/assistant/client.ts';
import { compileExpression } from '../src/assistant/expression.ts';
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
  // Boîtes en mètres : les murs font 10 × 2,8 × 0,2 ; la dalle est à 3 m de haut ; le poteau fait 6 m ; l'élément 5 n'a pas de géométrie.
  const boxes: ([number, number, number, number, number, number] | null)[] = [
    [0, 0, 0, 10, 2.8, 0.2],
    [0, 0, 5, 10, 2.8, 5.2],
    [2, 0, 0, 3, 2.1, 0.2],
    [0, 2.8, 0, 10, 3, 5],
    [4, 0, 2, 4.4, 6, 2.4],
    null,
  ];
  const context: ToolContext = {
    store,
    count: 6,
    keys: ['a', 'b', 'c', 'd', 'e', 'f'],
    labelOf: (index) => store.labelOf(index) ?? `élément ${index}`,
    geometry: (index) => {
      const b = boxes[index];
      return b ? { min: [b[0], b[1], b[2]], max: [b[3], b[4], b[5]] } : null;
    },
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
  assert.match(summary, /Pset_WallCommon \(2 éléments\) : FireRating/);
  assert.match(summary, /Qto_WallBaseQuantities \[verrouillée\] \(2 éléments\) : NetVolume/);
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
  assert.match(wideSummary, /et 30 autres catégories/);

  // Des catégories portées par un seul élément (un jeu de propriétés par porte) sont comptées, pas listées.
  const doors = new PropertyStore(400);
  for (let i = 0; i < 400; i++) {
    const props: Record<string, PropValue> = { 'Classe IFC': 'IfcDoor', 'Pset_DoorCommon / IsExternal': i % 2 === 0 };
    props[`Porte ${i} / PanelOperation`] = 'SWING';
    doors.set(i, props);
  }
  doors.finalize();
  const doorSummary = summarizeProperties(doors);
  assert.match(doorSummary, /^- Pset_DoorCommon \(400 éléments\) : IsExternal$/m);
  assert.match(doorSummary, /et 400 catégories rares, portées chacune par moins de 4 éléments/);
  assert.doesNotMatch(doorSummary, /Porte 12 /);
  assert.ok(doorSummary.length < 1500, `résumé de ${doorSummary.length} caractères`);
  assert.match(wideSummary, /Identifiant : plus de 20 valeurs distinctes, ex\. ID-0/);
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
  assert.deepEqual(names, ['list_properties', 'count_by', 'find_elements', 'get_element', 'select_elements', 'compute', 'set_property']);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.parameters.type, 'object');
    for (const [name, schema] of Object.entries(tool.function.parameters.properties)) {
      assert.ok((schema as { description?: string }).description, `${tool.function.name}.${name} sans description`);
    }
  }
});

test('compactHistory abrège les résultats d’outils des tours précédents', () => {
  const long = JSON.stringify({ elements: Array.from({ length: 50 }, (_, i) => ({ label: `Élément ${i}` })) });
  const messages: Message[] = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'find_elements', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c', content: long },
    { role: 'assistant', content: 'r' },
  ];
  compactHistory(messages);
  const tool = messages[3] as { content: string };
  assert.ok(tool.content.length < 300, `${tool.content.length} caractères`);
  assert.ok(tool.content.startsWith(long.slice(0, 100)));
  assert.match(tool.content, /abrégé/);
  assert.equal(messages[4].content, 'r');
});

test('compileExpression : arithmétique, comparaisons, logique, fonctions, erreurs', () => {
  const resolve = (name: string) => ({ volume: 'Qto / NetVolume', l: 'L', h: 'H', porteur: 'Porteur', feu: 'Feu', classe: 'Classe IFC' })[name.toLowerCase()] ?? name;
  const props: Record<string, PropValue> = { 'Qto / NetVolume': 5.6, L: 10, H: 2.8, Porteur: true, Feu: '', 'Classe IFC': 'IfcWall' };
  const lookup = (path: string) => props[path];
  const evaluate = (text: string) => compileExpression(text, resolve).evaluate(lookup);
  assert.ok(Math.abs(evaluate('[volume] - [L] * [H] * 0.2') as number) < 1e-9);
  assert.equal(evaluate('round([L] / 3, 2)'), 3.33);
  assert.equal(evaluate('abs(-[L]) + min([L], [H]) + max(1, 2)'), 14.8);
  assert.equal(evaluate('[porteur] == true and [feu] == null'), true);
  assert.equal(evaluate('[classe] == "ifcwall" and not ([L] < 5 or [H] > 3)'), true);
  assert.equal(evaluate('[L] >= 10 and [L] != 11'), true);
  assert.equal(evaluate('[Inconnue] == null'), true, 'une propriété absente vaut null');
  assert.equal(evaluate('1,5 + 1'), 2.5, 'virgule décimale acceptée');
  assert.deepEqual(compileExpression('[volume] + [L]', resolve).paths, ['Qto / NetVolume', 'L']);
  assert.throws(() => compileExpression('[L] +', resolve), /incomplète/);
  assert.throws(() => compileExpression('volume * 2', resolve), /crochets/);
  assert.throws(() => compileExpression('[L] + (2', resolve), /parenthèse/);
  assert.throws(() => compileExpression('[L] $ 2', resolve), /inattendu/);
});

test('compute : sommes et conditions calculées par le viewer, pas par le modèle', () => {
  const { context } = sampleContext();
  const total = runTool('compute', { filters: [{ property: 'Classe IFC', op: 'equals', value: 'IfcWall' }], expression: '[NetVolume]' }, context);
  const sum = total.result as { computed: number; skipped: number; sum: number; mean: number; min: number; max: number; examples: { label: string; value: number }[] };
  assert.equal(sum.computed, 2);
  assert.equal(sum.sum, 7.7);
  assert.equal(sum.mean, 3.85);
  assert.deepEqual([sum.min, sum.max], [2.1, 5.6]);
  assert.deepEqual(sum.examples.map((item) => [item.label, item.value]), [['Mur A', 5.6], ['Mur B', 2.1]]);
  assert.equal(total.note, 'Calcul sur 2 éléments : somme 7,7');

  // Éléments sans la propriété : ignorés et comptés, pas inventés.
  const all = runTool('compute', { filters: [], expression: '[NetVolume] * 2' }, context).result as { computed: number; skipped: number; note: string };
  assert.equal(all.computed, 2);
  assert.equal(all.skipped, 4);
  assert.match(all.note, /4 éléments ignorés/);

  // Condition logique entre propriétés : murs sans résistance au feu.
  const check = runTool('compute', { filters: [], where: '[Classe IFC] == "IfcWall" and [FireRating] == null' }, context);
  const found = check.result as { matching: number; examples: { label: string }[] };
  assert.equal(found.matching, 1);
  assert.equal(found.examples[0].label, 'Mur B');
  assert.equal(check.note, 'Condition vraie pour 1 élément sur 6');

  // Formule et condition ensemble : seuls les éléments retenus sont calculés.
  const both = runTool('compute', { filters: [], expression: '[NetVolume]', where: '[NetVolume] > 3' }, context).result as { matching: number; sum: number };
  assert.deepEqual([both.matching, both.sum], [1, 5.6]);

  assert.match(runTool('compute', { filters: [], expression: '[Inexistante] + 1' }, context).note, /introuvable/);
  assert.match(runTool('compute', { filters: [], expression: '[NetVolume] +' }, context).note, /illisible/);
  assert.match(runTool('compute', { filters: [] }, context).note, /manquante/);
});

test('les propriétés calculées depuis la 3D servent aux filtres, aux formules et aux fiches, jamais aux modifications', () => {
  const { context } = sampleContext();
  assert.equal(resolveProperty(context.store, 'haut'), 'Géométrie / Haut');
  assert.equal(resolveProperty(context.store, 'hauteur'), 'Géométrie / Emprise Y (hauteur)');

  const tall = runTool('find_elements', { filters: [{ property: 'Haut', op: 'greater', value: 3 }], properties: ['Emprise Y (hauteur)'] }, context);
  const found = tall.result as { count: number; elements: Record<string, unknown>[] };
  assert.equal(found.count, 1);
  assert.equal(found.elements[0].label, 'Poteau');
  assert.equal(found.elements[0]['Géométrie / Emprise Y (hauteur)'], 6);

  const volume = runTool('compute', { filters: [{ property: 'Classe IFC', op: 'equals', value: 'IfcWall' }], expression: '[Emprise X] * [Emprise Y (hauteur)] * [Emprise Z]' }, context).result as { computed: number; sum: number };
  assert.equal(volume.computed, 2);
  assert.ok(Math.abs(volume.sum - 11.2) < 1e-9);

  // Un élément sans géométrie n'a pas de valeur calculée : il est ignoré, pas mis à zéro.
  const all = runTool('compute', { filters: [], expression: '[Centre Y]' }, context).result as { computed: number; skipped: number };
  assert.deepEqual([all.computed, all.skipped], [5, 1]);
  const above = runTool('compute', { filters: [], where: '[Bas] >= 2.8' }, context).result as { matching: number; examples: { label: string }[] };
  assert.deepEqual(above.examples.map((item) => item.label), ['Dalle']);

  assert.match(runTool('count_by', { property: 'Centre X' }, context).note, /calculée/);
  assert.match(runTool('set_property', { filters: [], property: 'Géométrie / Haut', value: '9' }, context).note, /calculée/);
  assert.equal(context.store.paths.includes('Géométrie / Haut'), false);
  const listed = runTool('list_properties', { search: 'géom' }, context).result as { total: number; properties: { property: string; computed?: boolean }[] };
  assert.equal(listed.total, 8);
  assert.ok(listed.properties.every((item) => item.computed));
});
