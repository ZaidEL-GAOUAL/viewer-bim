import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateAppearanceRules, numericValue, validateAppearanceRules, type AppearanceRule } from '../src/data/appearanceRules.ts';
import { PropertyStore } from '../src/data/metadata.ts';
import { PropertyEdits } from '../src/data/PropertyEdits.ts';
import { runTool, TOOL_DEFINITIONS, type ToolContext } from '../src/assistant/tools.ts';

function fixture() {
  const store = new PropertyStore(5);
  store.set(0, { CO2: 1500, Bâtiment: 'A', Avancement: 100 }, 'Mur A');
  store.set(1, { CO2: '1 200', Bâtiment: 'B', Avancement: '50%' }, 'Mur B');
  store.set(2, { CO2: 500, Bâtiment: 'A', Avancement: 0 }, 'Dalle A');
  store.set(3, { CO2: 200, Bâtiment: 'C', Avancement: 'inconnu' }, 'Dalle C');
  store.finalize();
  const rules: AppearanceRule[] = [
    { id: 'co2', enabled: true, conditions: [{ property: 'CO2', op: 'greater', value: 1000 }], color: '#808080' },
    { id: 'building', enabled: true, conditions: [{ property: 'Bâtiment', op: 'equals', value: 'A' }], color: '#3366ff' },
    { id: 'progress', enabled: true, conditions: [], opacityBy: { property: 'Avancement', scale: 'percent' } },
  ];
  return { store, rules };
}

test('CO2, building and progress rules compose independently without changing metadata', () => {
  const { store, rules } = fixture();
  const before = JSON.stringify(store.export(['a', 'b', 'c', 'd', 'e']));
  const result = evaluateAppearanceRules(store, validateAppearanceRules(rules, store));
  assert.deepEqual(result.get(0), { color: '#3366ff', opacity: 1 });
  assert.deepEqual(result.get(1), { color: '#808080', opacity: .5 });
  assert.deepEqual(result.get(2), { color: '#3366ff', opacity: 0 });
  assert.equal(result.has(3), false, 'unknown progress does not invent opacity');
  assert.equal(result.has(4), false, 'missing metadata keeps original appearance');
  assert.equal(JSON.stringify(store.export(['a', 'b', 'c', 'd', 'e'])), before);
});

test('Reordering, disabling, editing and removing rules recomputes the result without stale overrides', () => {
  const { store, rules } = fixture();
  const reordered = [rules[1], rules[0], rules[2]];
  assert.equal(evaluateAppearanceRules(store, reordered).get(0)?.color, '#808080');
  assert.equal(evaluateAppearanceRules(store, [{ ...rules[0], enabled: false }, rules[2]]).get(0)?.color, undefined);
  assert.equal(evaluateAppearanceRules(store, [{ ...rules[1], color: '#ff0000' }, rules[2]]).get(0)?.color, '#ff0000');
  assert.deepEqual([...evaluateAppearanceRules(store, [])], []);
});

test('Saved rules remain manageable after their properties are deleted and match again after undo', () => {
  const { store, rules } = fixture();
  const edits = new PropertyEdits(store, () => {});
  const indices = [0, 1, 2, 3, 4];
  assert.equal(edits.delete(indices, 'CO2'), true);
  assert.equal(edits.delete(indices, 'Avancement'), true);
  assert.equal(store.paths.includes('CO2'), false);
  assert.equal(store.paths.includes('Avancement'), false);

  let current = validateAppearanceRules(rules.map((rule) => rule.id === 'co2' ? { ...rule, enabled: false } : rule));
  current = validateAppearanceRules([...current].reverse());
  current = validateAppearanceRules(current.filter((rule) => rule.id !== 'building'));
  assert.deepEqual(current.map((rule) => rule.id), ['progress', 'co2']);
  const edited = validateAppearanceRules([{ ...current[1], enabled: true, color: '#ff0000' }], store, current)[0];
  current = validateAppearanceRules([current[0], edited], store, current);
  assert.deepEqual([...evaluateAppearanceRules(store, current)], [], 'absent values do not invent a color or opacity');
  assert.throws(() => validateAppearanceRules([{ ...edited, id: 'new' }], store, current), /introuvable/);
  assert.throws(() => validateAppearanceRules([{ ...edited, conditions: [{ property: 'Unknown', op: 'present' }] }], store, current), /introuvable/);

  edits.undo();
  assert.deepEqual(evaluateAppearanceRules(store, current).get(0), { opacity: 1 });
  edits.undo();
  assert.deepEqual(evaluateAppearanceRules(store, current).get(0), { opacity: 1, color: '#ff0000' });
  assert.equal(current[1].conditions[0].property, 'CO2', 'the saved reference survives deletion and undo');
});

test('Percentage normalization is explicit; absent values keep earlier opacity and bounds are clamped', () => {
  const { store } = fixture();
  assert.equal(numericValue(50, 'percent'), .5);
  assert.equal(numericValue(.5, 'fraction'), .5);
  assert.equal(numericValue(.5, 'percent'), .005);
  assert.equal(numericValue('50 %', 'percent'), .5);
  assert.equal(numericValue('50%', 'fraction'), .5);
  assert.equal(numericValue('1 234,5'), 1234.5);
  assert.equal(numericValue(null), undefined);
  assert.equal(numericValue(''), undefined);
  assert.equal(numericValue(true), undefined);
  store.update(0, 'Avancement', 150); store.update(1, 'Avancement', -20);
  const result = evaluateAppearanceRules(store, [
    { id: 'base', enabled: true, conditions: [], opacity: .8 },
    { id: 'mapped', enabled: true, conditions: [], opacityBy: { property: 'Avancement', scale: 'percent' } },
  ]);
  assert.equal(result.get(0)?.opacity, 1);
  assert.equal(result.get(1)?.opacity, 0);
  assert.equal(result.get(3)?.opacity, .8);
  assert.equal(result.get(4)?.opacity, .8);
});

test('Conditions combine comparisons, strings and missing values without matching inherited properties', () => {
  const { store } = fixture();
  const rules = validateAppearanceRules([
    { id: 'condition', enabled: true, conditions: [{ property: 'CO2', op: 'greater_or_equal', value: 500 }, { property: 'Bâtiment', op: 'contains', value: 'a' }], opacity: .3 },
    { id: 'missing', enabled: true, conditions: [{ property: 'CO2', op: 'missing' }], color: '#dddddd' },
  ], store);
  const result = evaluateAppearanceRules(store, rules);
  assert.equal(result.get(0)?.opacity, .3); assert.equal(result.get(2)?.opacity, .3);
  assert.equal(result.has(1), false);
  assert.equal(result.get(4)?.color, '#dddddd');
  assert.throws(() => validateAppearanceRules([{ ...rules[0], conditions: [{ property: 'constructor', op: 'present' }] }], store), /introuvable/);
});

test('Invalid rule lists fail validation atomically', () => {
  const { store, rules } = fixture();
  assert.throws(() => validateAppearanceRules([rules[0], rules[0]], store), /double/);
  assert.throws(() => validateAppearanceRules([{ ...rules[0], color: 'blue' }], store), /#rrggbb/);
  assert.throws(() => validateAppearanceRules([{ ...rules[0], opacity: NaN }], store), /opacité/);
  assert.throws(() => validateAppearanceRules([{ ...rules[2], opacity: .5 }], store), /fixe ou liée/);
  assert.throws(() => validateAppearanceRules([{ ...rules[0], conditions: [{ property: 'CO2', op: 'greater', value: 'later' }] }], store), /numérique/);
});

test('Assistant can only read metadata and modify view rules/grouping, never properties or geometry', () => {
  const { store, rules } = fixture();
  let current = rules, grouping: string[] = [];
  const context: ToolContext = {
    store, count: 5, keys: ['a', 'b', 'c', 'd', 'e'], labelOf: (index) => store.labelOf(index) ?? '', selection: new Set(), select: () => {},
    get appearanceRules() { return current; }, setAppearanceRules: (next) => { current = next; },
    get grouping() { return grouping; }, groupBy: (paths) => { grouping = paths; },
  };
  const before = JSON.stringify(store.export(context.keys));
  const unavailable = ['set_property', 'move_elements', 'duplicate_elements', 'add_boxes', 'create_elements', 'delete_elements', 'rotate_elements', 'update_parameters', 'edit_history'];
  for (const name of unavailable) {
    assert.equal(TOOL_DEFINITIONS.some((tool) => tool.function.name === name), false);
    assert.match(runTool(name, { filters: [], property: 'CO2', value: 0 }, context).note, /inconnu/);
  }
  assert.match(runTool('compute', { filters: [], expression: '[Géométrie / Haut]' }, context).note, /introuvable/);
  const view = runTool('update_view', { rules: [{ id: 'co2', enabled: true, conditions: [{ property: 'CO2', op: 'greater', value: 1000 }], color: '#ff0000' }], groupBy: ['bâtiment', 'Avancement'] }, context);
  assert.doesNotMatch(view.note, /Erreur/);
  assert.equal(current.length, 3, 'other rules remain');
  assert.equal(current[0].color, '#ff0000');
  assert.deepEqual(grouping, ['Bâtiment', 'Avancement']);
  runTool('update_view', { ruleOrder: ['progress', 'building', 'co2'] }, context);
  assert.deepEqual(current.map((rule) => rule.id), ['progress', 'building', 'co2']);
  const snapshot = JSON.stringify(current);
  assert.match(runTool('update_view', { ruleOrder: ['co2'] }, context).note, /exactement une fois/);
  assert.equal(JSON.stringify(current), snapshot);
  runTool('update_view', { removeRuleIds: ['building'] }, context);
  assert.deepEqual(current.map((rule) => rule.id), ['progress', 'co2']);
  assert.equal(JSON.stringify(store.export(context.keys)), before);
});

test('A delayed tool call cannot change the view of a replacement model', () => {
  const { store } = fixture();
  const context: ToolContext = { store, count: 5, keys: [], labelOf: () => '', selection: new Set(), select: () => { throw new Error('Should not run'); }, isCurrent: () => false };
  assert.match(runTool('select_elements', { filters: [] }, context).note, /Ancien modèle/);
});
