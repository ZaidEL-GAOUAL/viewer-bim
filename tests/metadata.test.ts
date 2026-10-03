import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTree, suggestGrouping } from '../src/data/grouping.ts';
import { PropertyStore, UNDEFINED_LABEL, compareValues, flattenProperties, formatValue, isReadOnly, mergeProperties, parseMetadata, unflattenProperties } from '../src/data/metadata.ts';

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

test('isReadOnly verrouille un nom exact, une catégorie entière ou un préfixe', () => {
  const patterns = ['Classe IFC', 'Qto_*', 'Structure'];
  assert.equal(isReadOnly('Classe IFC', patterns), true);
  assert.equal(isReadOnly('Classe IFC bis', patterns), false);
  assert.equal(isReadOnly('Qto_WallBaseQuantities / NetVolume', patterns), true);
  assert.equal(isReadOnly('Structure / Niveau', patterns), true);
  assert.equal(isReadOnly('Pset_WallCommon / FireRating', patterns), false);
  assert.equal(isReadOnly('Nom', []), false);
});

test('parseMetadata lit la liste readOnly et l’export la restitue avec les modifications', () => {
  const metadata = parseMetadata({
    version: 1,
    readOnly: ['Classe IFC', 'Qto_*', 42],
    elements: {
      a: { label: 'Mur A', properties: { 'Classe IFC': 'IfcWall', Nom: 'Mur A', Pset_WallCommon: { IsExternal: true }, Qto_WallBaseQuantities: { NetVolume: 5.6 } } },
      b: { properties: { 'Classe IFC': 'IfcDoor' } },
    },
  });
  assert.deepEqual(metadata.readOnly, ['Classe IFC', 'Qto_*']);

  const store = new PropertyStore(3);
  store.set(0, metadata.elements.get('a')!.props, 'Mur A');
  store.set(1, metadata.elements.get('b')!.props);
  store.finalize();
  store.readOnly = metadata.readOnly!;
  assert.equal(store.isEditable('Classe IFC'), false);
  assert.equal(store.isEditable('Qto_WallBaseQuantities / NetVolume'), false);
  assert.equal(store.isEditable('Pset_WallCommon / IsExternal'), true);

  // Modifier, créer (dans une catégorie nouvelle), et sur un élément sans métadonnées.
  assert.equal(store.update(0, 'Pset_WallCommon / IsExternal', false), true);
  assert.equal(metadata.elements.get('a')!.props['Pset_WallCommon / IsExternal'], true, 'le fichier chargé reste intact');
  assert.equal(store.update(0, 'Pset_WallCommon / IsExternal', false), false, 'même valeur : rien ne change');
  assert.equal(store.update(1, 'Chantier / Lot', 'Gros œuvre'), true);
  assert.equal(store.update(2, 'Chantier / Lot', 'Gros œuvre'), true);
  assert.equal(store.matched, 3);
  assert.ok(store.paths.includes('Chantier / Lot'));
  assert.deepEqual([...store.groups('Chantier / Lot').entries()], [['Gros œuvre', [1, 2]], [UNDEFINED_LABEL, [0]]]);
  store.setLabel(0, 'Mur A bis');

  const exported = store.export(['a', 'b', 'c']) as { version: number; readOnly: string[]; elements: Record<string, { label?: string; properties: Record<string, unknown> }> };
  assert.equal(exported.version, 1);
  assert.deepEqual(exported.readOnly, ['Classe IFC', 'Qto_*']);
  assert.deepEqual(exported.elements.a, {
    label: 'Mur A bis',
    properties: { 'Classe IFC': 'IfcWall', Nom: 'Mur A', Pset_WallCommon: { IsExternal: false }, Qto_WallBaseQuantities: { NetVolume: 5.6 } },
  });
  assert.deepEqual(exported.elements.b, { properties: { 'Classe IFC': 'IfcDoor', Chantier: { Lot: 'Gros œuvre' } } });
  assert.deepEqual(exported.elements.c, { properties: { Chantier: { Lot: 'Gros œuvre' } } });
  // Relu par le viewer, l'export redonne les mêmes propriétés aplaties.
  const again = parseMetadata(JSON.parse(JSON.stringify(exported)));
  assert.deepEqual(again.elements.get('b')!.props, { 'Classe IFC': 'IfcDoor', 'Chantier / Lot': 'Gros œuvre' });
  assert.deepEqual(again.readOnly, ['Classe IFC', 'Qto_*']);
});

test('unflattenProperties ne se laisse pas piéger par des noms de membres de Object', () => {
  const nested = unflattenProperties({ '__proto__ / x': 1, constructor: 'c', 'A / toString': 2 });
  assert.deepEqual(Object.keys(nested), ['__proto__', 'constructor', 'A']);
  assert.equal(JSON.stringify(nested), '{"__proto__":{"x":1},"constructor":"c","A":{"toString":2}}');
  assert.equal(Object.getPrototypeOf(nested), Object.prototype);
  assert.equal('x' in {}, false, 'Object.prototype n’a pas été modifié');
});
