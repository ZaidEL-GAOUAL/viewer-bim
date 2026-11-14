import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateAppearanceRules } from '../src/data/appearanceRules.ts';
import { matchesCondition, numericValue, plainNumber, valueAt, type RuleCondition } from '../src/data/conditions.ts';
import { PropertyStore } from '../src/data/metadata.ts';
import { runTool, type ToolContext } from '../src/assistant/tools.ts';

const is = (value: Parameters<typeof matchesCondition>[0], condition: RuleCondition) => matchesCondition(value, condition);

test('numericValue : virgule, espaces fines et insécables, signe, pourcentage', () => {
  assert.equal(numericValue('1 234,5'), 1234.5);
  assert.equal(numericValue('1 234'), 1234);
  assert.equal(numericValue('-3,5'), -3.5);
  assert.equal(numericValue('+2'), 2);
  assert.equal(numericValue('.5'), 0.5);
  assert.equal(numericValue('1e3'), 1000);
  assert.equal(numericValue('12 %'), 12);
  assert.equal(numericValue('12 %', 'percent'), 0.12);
  assert.equal(numericValue('12 %', 'fraction'), 0.12);
  assert.equal(numericValue(0.12, 'fraction'), 0.12);
  assert.equal(numericValue('12abc'), undefined);
  assert.equal(numericValue('0x10'), undefined);
  assert.equal(numericValue('Infinity'), undefined);
  assert.equal(numericValue('   '), undefined);
  assert.equal(numericValue(false), undefined);
});

test('plainNumber ne reconnaît que les nombres écrits tout simplement', () => {
  assert.equal(plainNumber('12'), 12);
  assert.equal(plainNumber('-3,5'), -3.5);
  assert.equal(plainNumber('3.25'), 3.25);
  assert.equal(plainNumber('50 %'), undefined);
  assert.equal(plainNumber('+33612345678'), undefined);
  assert.equal(plainNumber('1 234'), undefined);
  assert.equal(plainNumber(''), undefined);
});

test('égalité : sans accents ni casse, nombres écrits de plusieurs façons, booléens', () => {
  assert.equal(is('Béton', { property: 'm', op: 'equals', value: ' beton ' }), true);
  assert.equal(is('Béton', { property: 'm', op: 'equals', value: 'Bois' }), false);
  assert.equal(is('10', { property: 'n', op: 'equals', value: 10 }), true);
  assert.equal(is('10,0', { property: 'n', op: 'equals', value: '10.0' }), true);
  assert.equal(is('1 200', { property: 'n', op: 'equals', value: 1200 }), true);
  assert.equal(is(true, { property: 'b', op: 'equals', value: 'True' }), true);
  assert.equal(is(true, { property: 'b', op: 'equals', value: false }), false);
  assert.equal(is('50%', { property: 'p', op: 'equals', value: 0.5, numericScale: 'fraction' }), true);
  assert.equal(is('abc', { property: 'p', op: 'equals' }), false, 'sans valeur attendue, rien n’est égal');
});

test('une valeur absente n’est égale à rien : « ≠ » la retient, tous les autres opérateurs non', () => {
  for (const absent of [undefined, null, '']) {
    assert.equal(is(absent, { property: 'p', op: 'not_equals', value: 'A' }), true);
    assert.equal(is(absent, { property: 'p', op: 'equals', value: 'A' }), false);
    assert.equal(is(absent, { property: 'p', op: 'equals', value: '' }), false);
    assert.equal(is(absent, { property: 'p', op: 'contains', value: '' }), false);
    assert.equal(is(absent, { property: 'p', op: 'greater', value: 0 }), false);
    assert.equal(is(absent, { property: 'p', op: 'less', value: 0 }), false);
    assert.equal(is(absent, { property: 'p', op: 'missing' }), true);
    assert.equal(is(absent, { property: 'p', op: 'present' }), false);
  }
  assert.equal(is('A', { property: 'p', op: 'not_equals', value: 'A' }), false);
  assert.equal(is('B', { property: 'p', op: 'not_equals', value: 'A' }), true);
  assert.equal(is('B', { property: 'p', op: 'not_equals' }), true, 'rien de comparable : différent');
});

test('contient et comparaisons numériques', () => {
  assert.equal(is('Mur extérieur', { property: 'p', op: 'contains', value: 'EXTERIEUR' }), true);
  assert.equal(is('Mur', { property: 'p', op: 'contains', value: 'dalle' }), false);
  assert.equal(is('1 500', { property: 'p', op: 'greater', value: 1000 }), true);
  assert.equal(is(1000, { property: 'p', op: 'greater', value: 1000 }), false);
  assert.equal(is(1000, { property: 'p', op: 'greater_or_equal', value: '1000' }), true);
  assert.equal(is('abc', { property: 'p', op: 'less', value: 5 }), false);
  assert.equal(is(true, { property: 'p', op: 'less', value: 5 }), false);
  assert.equal(is(3, { property: 'p', op: 'less_or_equal', value: 'abc' }), false);
  assert.equal(is('50 %', { property: 'p', op: 'less', value: 80, numericScale: 'percent' }), true, 'les deux côtés dans la même échelle');
});

test('valueAt lit une propriété, le nom affiché ou l’identifiant', () => {
  const store = new PropertyStore(2);
  store.set(0, { Niveau: 'RDC' }, 'Mur A');
  store.finalize();
  const element = { keys: ['guid-a', 'guid-b'], label: (index: number) => `élément ${index}` };
  assert.equal(valueAt(store, element, 0, 'Niveau'), 'RDC');
  assert.equal(valueAt(store, element, 0, '#id'), 'guid-a');
  assert.equal(valueAt(store, element, 1, '#nom'), 'élément 1');
  assert.equal(valueAt(store, undefined, 0, '#nom'), 'Mur A', 'sans identité, le nom des métadonnées');
  assert.equal(valueAt(store, undefined, 0, '#id'), undefined);
  assert.equal(valueAt(store, element, 1, 'Niveau'), undefined);
});

// Bug D1 : l'assistant et les règles d'apparence lisaient « ≠ » sur une valeur absente de façons opposées.
test('« ≠ » sur une valeur absente : même réponse pour les règles et pour l’assistant', () => {
  const store = new PropertyStore(3);
  store.set(0, { Statut: 'Fini' }, 'a');
  store.set(1, { Statut: 'En cours' }, 'b');
  store.set(2, { Autre: 1 }, 'c');
  store.finalize();
  const rule = { id: 'r', enabled: true, conditions: [{ property: 'Statut', op: 'not_equals' as const, value: 'Fini' }], color: '#ff0000' };
  const byRule = [...evaluateAppearanceRules(store, [rule]).keys()].sort();
  assert.deepEqual(byRule, [1, 2]);

  const context: ToolContext = { store, count: 3, keys: ['a', 'b', 'c'], labelOf: (i) => store.labelOf(i) ?? '', selection: new Set(), select: () => {} };
  const found = runTool('find_elements', { filters: [{ property: 'Statut', op: 'not_equals', value: 'Fini' }] }, context).result as { count: number };
  assert.equal(found.count, byRule.length);
});
