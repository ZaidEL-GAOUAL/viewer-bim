import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTree, suggestGrouping } from '../src/data/grouping.ts';
import { PropertyStore, UNDEFINED_LABEL, compareValues, flattenProperties, formatValue, mergeProperties, parseMetadata } from '../src/data/metadata.ts';

test('flattenProperties aplatit les objets imbriqués et les tableaux', () => {
  const flat = flattenProperties({ Type: 'Mur', Dimensions: { Longueur: 4.2, Détail: { Unité: 'm' } }, Tags: ['a', 'b'], Vide: null });
  assert.deepEqual(flat, {
    Type: 'Mur',
    'Dimensions / Longueur': 4.2,
    'Dimensions / Détail / Unité': 'm',
    Tags: 'a, b',
    Vide: null,
  });
});

test('parseMetadata lit le contrat versionné', () => {
  const metadata = parseMetadata({
    version: 1,
    elements: { A: { label: 'Mur 1', properties: { Type: 'Mur', Dimensions: { Hauteur: 2.7 } } } },
  });
  assert.equal(metadata.elements.size, 1);
  assert.deepEqual(metadata.elements.get('A'), { label: 'Mur 1', props: { Type: 'Mur', 'Dimensions / Hauteur': 2.7 } });
});

test('parseMetadata accepte la forme simplifiée et la forme en liste', () => {
  const flat = parseMetadata({ A: { Type: 'Mur' }, B: { Type: 'Porte' } });
  assert.deepEqual(flat.elements.get('B')?.props, { Type: 'Porte' });

  const list = parseMetadata({ elements: [{ id: 12, label: 'Dalle', properties: { Type: 'Dalle' } }, { sansId: true }] });
  assert.equal(list.elements.size, 1);
  assert.equal(list.elements.get('12')?.label, 'Dalle');
});

test('parseMetadata refuse les fichiers invalides', () => {
  assert.throws(() => parseMetadata([1, 2]), /objet JSON/);
  assert.throws(() => parseMetadata({ version: 99, elements: {} }), /Version 99/);
  assert.throws(() => parseMetadata({ version: 1, elements: {} }), /Aucun élément/);
});

test('formatValue et compareValues', () => {
  assert.equal(formatValue(true), 'Oui');
  assert.equal(formatValue(0.1 + 0.2), '0,3');
  assert.equal(formatValue(2024), '2024');
  assert.equal(formatValue(undefined), UNDEFINED_LABEL);
  assert.equal(formatValue(0), '0');
  assert.deepEqual(['R+10', UNDEFINED_LABEL, 'R+2', 'RDC'].sort(compareValues), ['R+2', 'R+10', 'RDC', UNDEFINED_LABEL]);
});

function sampleStore(): PropertyStore {
  const store = new PropertyStore(5);
  store.set(0, { Niveau: 'RDC', Type: 'Mur' }, 'Mur A');
  store.set(1, { Niveau: 'RDC', Type: 'Porte' });
  store.set(2, { Niveau: 'R+1', Type: 'Mur' });
  store.set(3, { Niveau: 'R+1' });
  // l'élément 4 n'a aucune métadonnée
  store.finalize();
  return store;
}

test('PropertyStore indexe les valeurs par propriété', () => {
  const store = sampleStore();
  assert.deepEqual(store.paths, ['Niveau', 'Type']);
  assert.equal(store.matched, 4);
  assert.deepEqual([...store.groups('Type').entries()], [
    ['Mur', [0, 2]],
    ['Porte', [1]],
    [UNDEFINED_LABEL, [3, 4]],
  ]);
  assert.equal(store.labelOf(0), 'Mur A');
});

test('buildTree crée des groupes et des sous-groupes', () => {
  const store = sampleStore();
  const tree = buildTree(store, ['Niveau', 'Type'], [0, 1, 2, 3, 4]);
  assert.deepEqual(tree.map((g) => [g.label, g.elements]), [
    ['R+1', [2, 3]],
    ['RDC', [0, 1]],
    [UNDEFINED_LABEL, [4]],
  ]);
  assert.deepEqual(tree[1].children.map((g) => [g.label, g.elements]), [
    ['Mur', [0]],
    ['Porte', [1]],
  ]);
  assert.equal(new Set(tree.flatMap((g) => [g.key, ...g.children.map((c) => c.key)])).size, 8);
  assert.deepEqual(buildTree(store, [], [0, 1]), []);
});

test('suggestGrouping choisit une propriété lisible', () => {
  const store = new PropertyStore(8);
  for (let i = 0; i < 8; i++) store.set(i, { Id: `e${i}`, Niveau: i < 4 ? 'RDC' : 'R+1', Projet: 'P' });
  store.finalize();
  assert.equal(suggestGrouping(store), 'Niveau');
});

test('suggestGrouping écarte les propriétés rarement renseignées et préfère plus de deux valeurs', () => {
  const store = new PropertyStore(12);
  for (let i = 0; i < 12; i++) {
    store.set(i, {
      Porteur: i % 2 === 0,
      Catégorie: ['Mur', 'Dalle', 'Poteau'][i % 3],
      ...(i < 2 ? { Diamètre: i === 0 ? 0.4 : 0.6 } : {}),
    });
  }
  store.finalize();
  assert.equal(suggestGrouping(store), 'Catégorie');
});

test('des propriétés nommées comme des membres de Object ne perturbent rien', () => {
  const flat = flattenProperties(JSON.parse('{"__proto__": "valeur", "constructor": "Dupont", "Détail": {"toString": 3}}'));
  assert.deepEqual(Object.keys(flat).sort(), ['Détail / toString', '__proto__', 'constructor']);
  assert.equal(Object.getPrototypeOf(flat), Object.prototype);

  const store = new PropertyStore(2);
  store.set(0, flat);
  store.set(1, { Autre: 1 });
  store.finalize();
  assert.equal(store.displayValue(0, 'constructor'), 'Dupont');
  assert.equal(store.displayValue(0, '__proto__'), 'valeur');
  // L'élément 1 n'a pas ces propriétés : il ne doit pas hériter des méthodes de Object.
  assert.equal(store.displayValue(1, 'constructor'), UNDEFINED_LABEL);
  assert.equal(store.displayValue(1, 'toString'), UNDEFINED_LABEL);
  assert.deepEqual([...store.groups('constructor').keys()], ['Dupont', UNDEFINED_LABEL]);
});

test('formatValue ne produit pas de zéro négatif', () => {
  assert.equal(formatValue(-0.00001), '0');
  assert.equal(formatValue(-0), '0');
  assert.equal(formatValue(-2.5), '-2,5');
});

test('distinctCount s’arrête dès que la limite est dépassée', () => {
  const store = new PropertyStore(1000);
  for (let i = 0; i < 1000; i++) store.set(i, { Id: `e${i}`, Niveau: i % 4, ...(i % 10 === 0 ? {} : { Lot: 'A' }) });
  store.finalize();
  assert.equal(store.distinctCount('Id', 50).count, 51);
  assert.deepEqual(store.distinctCount('Niveau', 50), { count: 4, undefinedCount: 0 });
  assert.deepEqual(store.distinctCount('Lot', 50), { count: 1, undefinedCount: 100 });
});

test('mergeProperties place les propriétés du GLB avant celles du JSON, le JSON l’emportant', () => {
  const merged = mergeProperties({ Source: 'GLB', Niveau: 'RDC' }, { Niveau: 'R+1', Type: 'Mur' });
  assert.deepEqual(merged, { Source: 'GLB', Niveau: 'R+1', Type: 'Mur' });
  assert.deepEqual(Object.keys(merged!), ['Source', 'Niveau', 'Type']);
  assert.deepEqual(mergeProperties({ A: 1 }, undefined), { A: 1 });
  assert.deepEqual(mergeProperties(undefined, { B: 2 }), { B: 2 });
  assert.equal(mergeProperties(undefined, undefined), undefined);
});

test('suggestGrouping préfère une propriété générale à une propriété rangée dans une catégorie', () => {
  const store = new PropertyStore(12);
  for (let i = 0; i < 12; i++) {
    store.set(i, flattenProperties({ 'Classe IFC': ['IfcWall', 'IfcSlab', 'IfcBeam', 'IfcColumn'][i % 4], Identification: { Mode: ['A', 'B', 'C'][i % 3] } }));
  }
  store.finalize();
  assert.equal(suggestGrouping(store), 'Classe IFC');
});
