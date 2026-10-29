import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compactHistory, trimHistory, type Message } from '../src/assistant/client.ts';
import { compileExpression } from '../src/assistant/expression.ts';
import { buildSystemPrompt, summarizeProperties } from '../src/assistant/prompt.ts';
import { TOOL_DEFINITIONS, resolveProperty, runTool, type ToolContext } from '../src/assistant/tools.ts';
import type { AppearanceRule } from '../src/data/appearanceRules.ts';
import { PropertyStore, type PropValue } from '../src/data/metadata.ts';
import { PropertyEdits } from '../src/data/PropertyEdits.ts';
import { parseScheduleDate } from '../src/data/schedule.ts';
import { createViewerApi, registerWebMcp } from '../src/assistant/agentApi.ts';

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
  const visibility: [number[], boolean][] = [];
  let shownAll = 0;
  let rules: AppearanceRule[] = [];
  const context: ToolContext = {
    store, count: 6, keys: ['a', 'b', 'c', 'd', 'e', 'f'],
    labelOf: (index) => store.labelOf(index) ?? `élément ${index}`,
    selection: new Set([0, 1]),
    select: (indices, isolate) => { selected.push(indices); isolated.push(isolate); },
    setVisible: (indices, visible) => { visibility.push([indices, visible]); },
    showAll: () => { shownAll++; },
    get appearanceRules() { return rules; },
    setAppearanceRules: (next) => { rules = next; },
  };
  return { store, context, selected, isolated, visibility, rulesOf: () => rules, shownAllCount: () => shownAll };
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

test('les comparaisons numériques excluent les propriétés absentes, vides, booléennes ou non numériques', () => {
  const values: (PropValue | undefined)[] = [undefined, null, '', '   ', false, true, 'inconnu', '0x10', 0, '750,5', 1500];
  const store = new PropertyStore(values.length);
  values.forEach((value, index) => store.set(index, value === undefined ? {} : { CO2: value }));
  store.finalize();
  const context: ToolContext = {
    store, count: values.length, keys: values.map((_, index) => String(index)),
    labelOf: (index) => String(index), selection: new Set(), select: () => {},
  };
  const count = (op: 'less' | 'greater', value?: PropValue) => (runTool('find_elements', {
    filters: [{ property: 'CO2', op, value }],
  }, context).result as { count: number }).count;
  assert.equal(count('less', 1000), 2);
  assert.equal(count('greater', -1), 3);
  for (const invalid of [undefined, null, '', '   ', false, true, 'inconnu', '0x10']) {
    assert.equal(count('less', invalid), 0);
    assert.equal(count('greater', invalid), 0);
  }
});

test('le message système résume les propriétés sans dépasser quelques milliers de caractères', () => {
  const { store } = sampleContext();
  const summary = summarizeProperties(store);
  assert.match(summary, /- Niveau \[verrouillée\] : RDC \(3\), R\+1 \(2\) ; non défini \(1\)/);
  assert.match(summary, /Pset_WallCommon \(2 éléments\) : FireRating/);
  assert.match(summary, /Qto_WallBaseQuantities \[verrouillée\] \(2 éléments\) : NetVolume/);
  const prompt = buildSystemPrompt({ fileName: 'test.glb', count: 6, store });
  assert.match(prompt, /« test.glb », 6 éléments, 5 avec des propriétés/);
  assert.match(prompt, /Champs verrouillés .* : Classe IFC, Niveau, Matériaux, Qto_\*/);
  // Demande dictée sans « ne » (« affiche que les éléments en R1 ») : elle isole.
  assert.match(prompt, /« affiche que X » \(à l’oral, sans « ne »\).* → select_elements avec isolate:true/);
  assert.match(prompt, /n’écris « isolés » que si isolated vaut true/);

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
  assert.deepEqual(names, ['list_properties', 'count_by', 'find_elements', 'get_element', 'select_elements', 'set_visibility', 'compute', 'get_view_settings', 'update_view', 'set_property', 'plan_dates']);
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

test('set_visibility masque, réaffiche ou montre tout sans toucher à la sélection', () => {
  const { context, visibility, selected, shownAllCount } = sampleContext();
  const hidden = runTool('set_visibility', { filters: [{ property: 'Niveau', op: 'equals', value: 'R+1' }], visible: false }, context);
  assert.deepEqual(visibility, [[[2, 3], false]]);
  assert.equal(hidden.note, '2 éléments masqués');
  runTool('set_visibility', { filters: [{ property: 'Niveau', op: 'equals', value: 'R+1' }], visible: true }, context);
  assert.deepEqual(visibility[1], [[2, 3], true]);
  assert.equal(runTool('set_visibility', { filters: [], showAll: true }, context).note, 'Toute la maquette est réaffichée');
  assert.equal(shownAllCount(), 1);
  assert.match(runTool('set_visibility', { filters: [{ property: 'Niveau', op: 'equals', value: 'R+9' }], visible: false }, context).note, /Aucun élément/);
  assert.equal(selected.length, 0, 'la sélection n’a pas bougé');
});

test('les booléens envoyés en texte (« "true" », Llama) comptent comme des booléens', () => {
  // « affiche que les éléments en R1 » : le modèle envoyait isolate:"true", ignoré, et ne faisait que sélectionner.
  const { context, selected, isolated, visibility, shownAllCount } = sampleContext();
  const isolatedOutcome = runTool('select_elements', { filters: [{ property: 'Niveau', op: 'equals', value: 'R+1' }], isolate: 'true' }, context);
  assert.deepEqual(selected, [[2, 3]]);
  assert.deepEqual(isolated, [true]);
  assert.equal(isolatedOutcome.note, '2 éléments isolés');
  assert.equal((isolatedOutcome.result as { isolated: boolean }).isolated, true);

  runTool('select_elements', { filters: [{ property: 'Niveau', op: 'equals', value: 'R+1' }], isolate: 'false' }, context);
  assert.deepEqual(isolated[1], false);
  assert.equal(runTool('select_elements', { filters: [{ property: 'Niveau', op: 'equals', value: 'R+1' }], highlight: 'True' }, context).note, '2 éléments mis en évidence');

  // « masque X » avec visible:"false" réaffichait X au lieu de le masquer.
  assert.equal(runTool('set_visibility', { filters: [{ property: 'Niveau', op: 'equals', value: 'R+1' }], visible: 'false' }, context).note, '2 éléments masqués');
  assert.deepEqual(visibility[0], [[2, 3], false]);
  runTool('set_visibility', { filters: [], showAll: 'true' }, context);
  assert.equal(shownAllCount(), 1);
});

test('les autres écarts courants des modèles sont tolérés : liste réduite, opérateur en symbole, « sélection »', () => {
  const { context, rulesOf } = sampleContext();
  // Un filtre seul au lieu d'une liste, « >= » au lieu de greater_or_equal (accepté par les règles, pas par les filtres).
  const big = runTool('find_elements', { filters: { property: 'NetVolume', op: '>=', value: 5.6 } }, context).result as { count: number };
  assert.equal(big.count, 1);
  // « sélection » avec accent visait toute la maquette.
  assert.equal((runTool('count_by', { property: 'Niveau', scope: 'sélection' }, context).result as { total: number }).total, 2);

  // update_view : règle seule, enabled et opacité en texte, condition seule en symbole, regroupement en texte simple.
  let grouped: string[] = [];
  context.groupBy = (paths) => { grouped = paths; };
  const outcome = runTool('update_view', { rules: { id: 'beton', enabled: 'true', conditions: { property: 'Matériaux', op: '=', value: 'Béton' }, opacity: '0.5' }, groupBy: 'Niveau' }, context);
  assert.equal(outcome.note, 'Présentation mise à jour : règles et regroupement');
  assert.deepEqual(rulesOf().map((rule) => [rule.id, rule.enabled, rule.opacity, rule.conditions[0].op]), [['beton', true, 0.5, 'equals']]);
  assert.deepEqual(grouped, ['Niveau']);
  // Sans « enabled », la règle ajoutée est active (elle était refusée).
  runTool('update_view', { rules: [{ id: 'bois', conditions: [{ property: 'Matériaux', op: 'equals', value: 'Bois' }], color: '#00ff00' }] }, context);
  assert.equal(rulesOf().find((rule) => rule.id === 'bois')?.enabled, true);
});

test('sans résultat, les valeurs présentes de la propriété filtrée accompagnent l’erreur', () => {
  // « R1 » au lieu de « R+1 » : le modèle corrige d'après existingValues, sans appel count_by de plus.
  const { context } = sampleContext();
  const outcome = runTool('select_elements', { filters: [{ property: 'Niveau', op: 'equals', value: 'R1' }], isolate: true }, context);
  assert.equal(outcome.note, 'Aucun élément concerné');
  assert.deepEqual((outcome.result as { existingValues: Record<string, string[]> }).existingValues, { Niveau: ['RDC', 'R+1'] });
});

test('select_elements avec highlight atténue le reste par deux règles empilées, retirables par id', () => {
  const { context, selected, isolated, rulesOf } = sampleContext();
  const outcome = runTool('select_elements', { filters: [{ property: 'Matériaux', op: 'equals', value: 'Béton' }], highlight: true }, context);
  assert.deepEqual(selected, [[0, 3, 4]]);
  assert.deepEqual(isolated, [false]);
  assert.equal(outcome.note, '3 éléments mis en évidence');
  const rules = rulesOf();
  assert.deepEqual(rules.map((rule) => rule.id), ['assistant-dim-others', 'assistant-highlight']);
  assert.deepEqual(rules[0].conditions, []);
  assert.equal(rules[0].opacity, 0.15);
  assert.deepEqual(rules[1].conditions, [{ property: 'Matériaux', op: 'equals', value: 'Béton' }]);
  assert.equal(rules[1].opacity, 1);
  // Le résultat donne les identifiants des règles posées et les noms des éléments visés.
  assert.deepEqual((outcome.result as { rules: string[] }).rules, ['assistant-dim-others', 'assistant-highlight']);
  assert.deepEqual((outcome.result as { elements: string[] }).elements, ['Mur A', 'Dalle', 'Poteau']);
  // Une seconde mise en évidence remplace la précédente sans l'empiler.
  runTool('select_elements', { filters: [{ property: 'Niveau', op: 'equals', value: 'RDC' }], highlight: true }, context);
  assert.equal(rulesOf().length, 2);
  assert.deepEqual(rulesOf()[1].conditions, [{ property: 'Niveau', op: 'equals', value: 'RDC' }]);
  // Les règles de l'utilisateur restent, en dessous.
  context.setAppearanceRules!([{ id: 'u1', enabled: true, conditions: [], color: '#ff0000' }, ...rulesOf()]);
  runTool('select_elements', { filters: [{ property: 'Classe IFC', op: 'equals', value: 'IfcDoor' }], highlight: true }, context);
  assert.deepEqual(rulesOf().map((rule) => rule.id), ['u1', 'assistant-dim-others', 'assistant-highlight']);
  // Dans la sélection seulement : pas de règle d'atténuation (le périmètre n'est pas exprimable en conditions).
  context.setAppearanceRules!([]);
  runTool('select_elements', { filters: [], scope: 'selection', highlight: true }, context);
  assert.equal(rulesOf().length, 0);
});

/** Contexte où les outils peuvent écrire, par le même historique annulable que l'application. */
function writableContext() {
  const sample = sampleContext();
  const edits = new PropertyEdits(sample.store, () => {});
  const plannings: [string, string][] = [];
  sample.context.writeProperties = (updates) => edits.setMany(updates);
  sample.context.openPlanning = (start, end) => { plannings.push([start, end]); return 6; };
  return { ...sample, edits, plannings };
}

test('set_property crée ou modifie une propriété, calcule par élément et refuse les champs verrouillés', () => {
  const { context, store, edits } = writableContext();
  const walls = [{ property: 'Classe IFC', op: 'equals', value: 'IfcWall' }];
  const added = runTool('set_property', { filters: walls, property: 'Lot / Nom', value: 'Gros œuvre' }, context);
  assert.equal(added.note, '« Lot / Nom » ajoutée sur 2 éléments');
  assert.equal((added.result as { created: boolean }).created, true);
  assert.equal(store.propsOf(0)?.['Lot / Nom'], 'Gros œuvre');
  assert.equal(store.propsOf(2)?.['Lot / Nom'], undefined);

  // Nom approché d'une propriété existante : on l'écrit, sans créer de doublon.
  const renamed = runTool('set_property', { filters: walls, property: 'lot/nom', value: 'GO' }, context);
  assert.equal((renamed.result as { created: boolean }).created, false);
  assert.equal(store.propsOf(1)?.['Lot / Nom'], 'GO');
  assert.equal(store.paths.filter((path) => path.toLowerCase().startsWith('lot')).length, 1);

  const doubled = runTool('set_property', { filters: [{ property: 'NetVolume', op: 'present' }], property: 'Volume double', expression: '[NetVolume] * 2' }, context);
  assert.equal((doubled.result as { count: number }).count, 2);
  assert.equal(store.propsOf(0)?.['Volume double'], 11.2);

  assert.match((runTool('set_property', { filters: walls, property: 'niveau', value: 'R+3' }, context).result as { error: string }).error, /verrouillée/);
  assert.match((runTool('set_property', { filters: walls, property: '#nom', value: 'X' }, context).result as { error: string }).error, /ne s’écrivent pas/);
  assert.match((runTool('set_property', { filters: walls, property: 'Lot / Nom' }, context).result as { error: string }).error, /value ou expression/);

  edits.undo();
  assert.equal(store.paths.includes('Volume double'), false);
  assert.equal(store.propsOf(1)?.['Lot / Nom'], 'GO');
});

test('plan_dates écrit des dates ordonnées par étage, dans le chantier, en une étape annulable, puis ouvre le planning', () => {
  const { context, store, edits, plannings } = writableContext();
  const args = { filters: [], start: '04/01/2026', end: '2027-12-12', minDays: '15', maxDays: 45, orderBy: 'Niveau', order: ['RDC', 'R+1'] };
  const outcome = runTool('plan_dates', args, context);
  const result = outcome.result as { elements: number; periods: { value: string; elements: number }[]; planning: { opened: boolean; tasks: number }; from: string; to: string };
  assert.equal(outcome.note, 'Dates de planning écrites sur 6 éléments (3 périodes)');
  assert.deepEqual(result.periods.map((period) => [period.value, period.elements]), [['RDC', 3], ['R+1', 2], ['(non défini)', 1]]);
  assert.deepEqual(result.planning, { opened: true, tasks: 6 });
  assert.deepEqual(plannings, [['Planning / Date début', 'Planning / Date fin']]);
  assert.equal(result.from, '2026-01-04');
  assert.equal(result.to, '2027-12-12', 'la dernière tâche finit le jour de fin du chantier');

  const day = (index: number, path: string) => parseScheduleDate(store.propsOf(index)?.[path]);
  const [first, last] = [parseScheduleDate('2026-01-04'), parseScheduleDate('2027-12-12')];
  for (let index = 0; index < 6; index++) {
    const start = day(index, 'Planning / Date début'), end = day(index, 'Planning / Date fin');
    assert.ok(start >= first && end <= last, `élément ${index} hors du chantier`);
    assert.ok(end - start + 1 >= 15 && end - start + 1 <= 45, `élément ${index} : durée ${end - start + 1} j`);
  }
  assert.equal(day(0, 'Planning / Date début'), first);
  // Le rez-de-chaussée (éléments 0, 1, 4) commence avant le R+1 (2, 3).
  assert.ok(Math.max(...[0, 1, 4].map((i) => day(i, 'Planning / Date début'))) < Math.min(...[2, 3].map((i) => day(i, 'Planning / Date début'))));

  // Mêmes arguments, mêmes dates : rien ne change.
  assert.ok((runTool('plan_dates', args, context).result as { unchanged?: string }).unchanged);
  edits.undo();
  assert.equal(store.paths.includes('Planning / Date début'), false);
  assert.equal(store.paths.includes('Planning / Date fin'), false);

  assert.match((runTool('plan_dates', { ...args, maxDays: 900 }, context).result as { error: string }).error, /dépasse la durée du chantier/);
  assert.match((runTool('plan_dates', { ...args, start: 'janvier' }, context).result as { error: string }).error, /illisible/);
});

test('plan_dates construit du bas vers le haut d’après la hauteur réelle des étages, quels que soient leurs noms', () => {
  // Noms qui ne se trient pas d'eux-mêmes : F.G.L (terrain fini), GF (rez), 1F, 2F, RF (toiture).
  // Les éléments 9 et 10 n'ont pas de niveau.
  const levels = ['1F', 'GF', 'RF', 'F.G.L', '2F', 'GF', '1F', 'GF', 'GF', '', ''];
  // Bas de chaque élément ; une fondation du GF descend sous le terrain, les éléments 7 et 10 n'ont pas de géométrie.
  const bottoms = [3.2, 0.5, 9.6, 0, 6.4, -1.5, 3.5, undefined, 0.45, 3.3, undefined];
  const store = new PropertyStore(levels.length);
  levels.forEach((level, index) => store.set(index, level ? { Niveau: level } : { Nom: 'sans niveau' }, `élément ${index}`));
  store.finalize();
  const edits = new PropertyEdits(store, () => {});
  const context: ToolContext = {
    store, count: levels.length, keys: levels.map((_, index) => `k${index}`), labelOf: (index) => `élément ${index}`,
    selection: new Set(), select: () => {}, writeProperties: (updates) => edits.setMany(updates), heightOf: (index) => bottoms[index],
  };
  const args = { filters: [], start: '2026-01-04', end: '2027-12-12', minDays: 15, maxDays: 45, orderBy: ['Niveau'] };
  const periods = (outcome: { result: unknown }) => (outcome.result as { periods: { value: string }[] }).periods.map((period) => period.value);
  const outcome = runTool('plan_dates', args, context);
  assert.deepEqual(periods(outcome), ['F.G.L', 'GF', '1F', '2F', 'RF', '(non défini)']);
  assert.match((outcome.result as { placedByHeight: string }).placedByHeight, /1 élément/);

  // Dans un étage aussi, du bas vers le haut ; l'élément sans géométrie passe après les autres.
  // L'élément 9, sans niveau, rejoint le 1F où il est posé ; le 10, sans niveau ni géométrie, finit le chantier.
  const start = (index: number) => parseScheduleDate(store.propsOf(index)?.['Planning / Date début']);
  const sequence = [3, 5, 8, 1, 7, 0, 9, 6, 4, 2, 10].map(start);
  assert.ok(sequence.every((day, i) => i === 0 || sequence[i - 1] < day), sequence.join(', '));

  // Un ordre dicté par l'utilisateur l'emporte ; les autres étages suivent, du plus bas au plus haut.
  assert.deepEqual(periods(runTool('plan_dates', { ...args, order: ['RF'] }, context)), ['RF', 'F.G.L', 'GF', '1F', '2F', '(non défini)']);
});

test('l’API des agents expose les outils du chat, en direct et par WebMCP', async () => {
  const { context, store } = writableContext();
  const api = createViewerApi(() => context);
  assert.deepEqual(api.tools.map((tool) => tool.name), TOOL_DEFINITIONS.map((tool) => tool.function.name));
  assert.equal((api.call('count_by', { property: 'Niveau' }).result as { total: number }).total, 6);
  assert.equal((api.call('count_by', '{"property":"Niveau"}').result as { total: number }).total, 6);
  assert.match((createViewerApi(() => null).call('count_by', { property: 'Niveau' }).result as { error: string }).error, /Aucun modèle/);

  const registered: { name: string; execute(args: Record<string, unknown>): Promise<{ content: { text: string }[] }> }[] = [];
  assert.equal(registerWebMcp(api, { registerTool: (tool: (typeof registered)[number]) => { registered.push(tool); } }), api.tools.length);
  const reply = await registered.find((tool) => tool.name === 'set_property')!.execute({ filters: [], property: 'Lot', value: 'A' });
  assert.equal(JSON.parse(reply.content[0].text).result.count, 6);
  assert.equal(store.propsOf(5)?.Lot, 'A');
  assert.equal(registerWebMcp(api, undefined), 0);
});
