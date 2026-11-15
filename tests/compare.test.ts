import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOOSE_TOLERANCE, STRICT_TOLERANCE, compareCsv, compareJob, compareReport, elementSignature, geometryStatus, statusLayer, type CompareSide, type GeometrySignature } from '../src/data/compare.ts';
import type { FlatProps } from '../src/data/metadata.ts';
import { CUBE, buildFromNodes } from './helpers.ts';

function run<T>(job: Generator<number, T, unknown>): T {
  for (;;) {
    const next = job.next();
    if (next.done) return next.value;
  }
}

interface Fixture { key: string; label?: string; props?: FlatProps; at?: number; size?: number; triangles?: number }

/** Un côté de comparaison sans géométrie réelle : une boîte par élément, déplacée de `at` en x. */
function side(items: Fixture[], base = 0): CompareSide {
  const signature = (item: Fixture): GeometrySignature => {
    const size = item.size ?? 1, at = item.at ?? 0;
    return { box: [at * 1000, 0, 0, (at + size) * 1000, size * 1000, size * 1000], triangles: item.triangles ?? 12, volume: size ** 3, area: 6 * size ** 2 };
  };
  return {
    elements: items.map((_, i) => base + i),
    key: (i) => items[i - base].key,
    label: (i) => items[i - base].label ?? items[i - base].key,
    props: (i) => items[i - base].props,
    category: (i) => String(items[i - base].props?.Catégorie ?? ''),
    signature: (i) => signature(items[i - base]),
  };
}

const before = side([
  { key: 'mur', props: { Catégorie: 'Mur', Matériau: 'Béton', Révision: 'A' } },
  { key: 'porte', props: { Catégorie: 'Porte', Largeur: 0.9 } },
  { key: 'poteau', props: { Catégorie: 'Poteau' }, at: 5 },
  { key: 'dalle', props: { Catégorie: 'Dalle' }, at: 10 },
  { key: 'fenetre', props: { Catégorie: 'Fenêtre' }, at: 20 },
  { key: 'old-id', label: 'Escalier', props: { Catégorie: 'Escalier' }, at: 30, triangles: 40 },
], 100);
const after = side([
  { key: 'mur', props: { Catégorie: 'Mur', Matériau: 'Brique', Révision: 'B' } },
  { key: 'porte', props: { Catégorie: 'Porte', Largeur: 0.9 } },
  { key: 'poteau', props: { Catégorie: 'Poteau' }, at: 6 },
  { key: 'dalle', props: { Catégorie: 'Dalle' }, at: 10, size: 2 },
  { key: 'new-id', label: 'Escalier', props: { Catégorie: 'Escalier' }, at: 30.01, triangles: 40 },
  { key: 'ajout', props: { Catégorie: 'Mur' }, at: 40 },
]);

test('pairs by key: added, removed, property change, moved, shape changed, regenerated id', () => {
  const result = run(compareJob(after, before, { ignore: ['Révision'] }));
  assert.deepEqual(result.added, [5], 'ajout');
  assert.deepEqual(result.removed, [104], 'fenetre');
  assert.deepEqual(result.modified.properties.map((pair) => [pair.current, pair.reference]), [[0, 100]]);
  assert.deepEqual(result.modified.properties[0].changes, [{ path: 'Matériau', before: 'Béton', after: 'Brique' }], 'Révision is ignored');
  assert.deepEqual(result.modified.moved.map((pair) => pair.current), [2]);
  assert.deepEqual(result.modified.geometry.map((pair) => pair.current), [3]);
  assert.deepEqual(result.unchanged.map((pair) => pair.current), [1]);
  assert.deepEqual(result.renamedIds.map((pair) => [pair.current, pair.reference]), [[4, 105]], 'same category, name and shape, 1 cm away: probably the same');
  assert.equal(result.unpairedShare < 0.5, true);
});

test('without ignore patterns every differing property counts; a prefix pattern ignores a whole family', () => {
  const plain = run(compareJob(after, before, {}));
  assert.deepEqual(plain.modified.properties[0].changes.map((change) => change.path), ['Matériau', 'Révision']);
  const prefixed = run(compareJob(after, before, { ignore: ['Mat*', 'Révision'] }));
  assert.deepEqual(prefixed.modified.properties, []);
  assert.deepEqual(prefixed.unchanged.map((pair) => pair.current), [0, 1]);
});

test('regenerated identifiers everywhere: more than half unpaired, nothing merged silently', () => {
  const renamed = side([{ key: 'x1', label: 'A', props: { Catégorie: 'Mur' } }, { key: 'x2', label: 'B', props: { Catégorie: 'Mur' }, at: 5 }]);
  const old = side([{ key: 'y1', label: 'A', props: { Catégorie: 'Mur' } }, { key: 'y2', label: 'B', props: { Catégorie: 'Porte' }, at: 5 }], 10);
  const result = run(compareJob(renamed, old, {}));
  assert.equal(result.unpairedShare, 1);
  assert.deepEqual(result.renamedIds.map((pair) => [pair.current, pair.reference]), [[0, 10]]);
  assert.deepEqual(result.added, [1], 'a different category is not « probably the same »');
  assert.deepEqual(result.removed, [11]);
});

test('display layer and reports', () => {
  const result = run(compareJob(after, before, { ignore: ['Révision'] }));
  const layer = statusLayer(result);
  assert.equal(layer.get(5)?.color, '#16a34a', 'added green');
  assert.equal(layer.get(104)?.color, '#dc2626', 'removed red');
  assert.ok((layer.get(104)?.opacity ?? 1) < 1, 'removed is translucent');
  assert.equal(layer.get(0)?.color, '#f59e0b', 'modified orange');
  assert.equal(layer.get(100)?.opacity, 0, 'the reference of a pair is not drawn twice');
  assert.ok((layer.get(1)?.opacity ?? 1) < 1, 'unchanged dimmed');
  const csv = compareCsv(result, after, before);
  assert.match(csv, /^Statut;Clé;Nom;Clé avant;Détail/);
  assert.match(csv, /modifié;mur;mur;mur;Matériau : Béton → Brique/);
  assert.match(csv, /identifiant changé \(probablement le même\);new-id;Escalier;old-id;/);
  const report = compareReport(result, after, before);
  assert.deepEqual(report.added, ['ajout']);
  assert.deepEqual(report.removed, ['fenetre']);
  assert.equal(report.unchanged, 1);
});

test('the geometry signature of a real element: a moved copy keeps its shape, a scaled one does not', async () => {
  const model = await buildFromNodes([
    { mesh: 0, extras: { id: 'a' } },
    { mesh: 0, translation: [5, 0, 0], extras: { id: 'b' } },
    { mesh: 0, scale: [2, 1, 1], extras: { id: 'c' } },
  ], [0, 1, 2], CUBE);
  const offset = model.offset.toArray();
  const [a, b, c] = [0, 1, 2].map((i) => elementSignature(model, i, offset)!);
  assert.equal(a.triangles, 12);
  assert.ok(Math.abs(a.volume - 1) < 1e-6 && Math.abs(a.area - 6) < 1e-6);
  assert.deepEqual([a.box[0], a.box[3]], [0, 1000], 'in millimetres, model frame');
  assert.equal(b.volume, a.volume);
  assert.notEqual(c.volume, a.volume);
});

test('end to end on the bundled demo: demo-v2 (fixture) opened, demo.glb added as reference, one change of each kind', async () => {
  const { readFile } = await import('node:fs/promises');
  const { Color } = await import('three');
  const { gltfSource, buildModel } = await import('../src/engine/buildModel.ts');
  const { loadModelFiles } = await import('../src/engine/loadModel.ts');
  const { parseMetadata } = await import('../src/data/metadata.ts');
  const { buildStore } = await import('../src/data/sidecar.ts');
  const { PropertyEdits } = await import('../src/data/PropertyEdits.ts');
  const { SplitSet, applyTailChange } = await import('../src/data/splits.ts');
  const { addSource, rekeyMetadata, sourceIndexOf, sourceKey } = await import('../src/data/federation.ts');
  const load = async (path: string) => {
    const file = new File([await readFile(new URL(`../${path}`, import.meta.url))], path.split('/').pop()!);
    return (await loadModelFiles({ file, path: file.name }, [])).gltf;
  };
  const json = async (path: string) => parseMetadata(JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8')));
  const select = { value: new Color() };
  const model = buildModel(gltfSource(await load('tests/fixtures/compare/demo-v2.glb')), select);
  const store = buildStore(model.keys, model.extras, await json('tests/fixtures/compare/demo-v2.json'));
  const edits = new PropertyEdits(store, () => {});
  const splits = new SplitSet(model, select);
  const added = addSource({ model, splits, selectColor: select, original: (i) => ({ props: store.propsOf(i), label: model.names[i] }), first: { name: 'demo-v2.glb', kind: 'glb' }, maxTriangles: 1e7 },
    { name: 'demo.glb', kind: 'glb', role: 'reference', geometry: gltfSource(await load('public/samples/demo.glb')) });
  applyTailChange(added.change, model, store, edits, rekeyMetadata(await json('public/samples/demo.json'), added.keyMap));
  assert.equal(added.apart, null, 'the two versions share their frame');
  const offset = model.offset.toArray();
  const side = (elements: number[]): CompareSide => ({
    elements, key: (i) => sourceKey(model.keys[i], model.sources[sourceIndexOf(model, i)]), label: (i) => store.labelOf(i) ?? model.names[i],
    props: (i) => store.propsOf(i), category: (i) => store.displayValue(i, 'Catégorie'), signature: (i) => elementSignature(model, i, offset),
  });
  const all = Array.from({ length: model.count }, (_, i) => i);
  const result = run(compareJob(side(all.filter((i) => sourceIndexOf(model, i) === 0)), side(all.filter((i) => sourceIndexOf(model, i) === 1)), {}));
  const names = (list: number[]) => list.map((i) => store.labelOf(i) ?? model.names[i]);
  assert.deepEqual(names(result.added), ['Poteau ajouté']);
  assert.deepEqual(names(result.removed), ['Poteau 1-6']);
  assert.deepEqual(names(result.modified.moved.map((pair) => pair.current)), ['Poteau 1-3']);
  assert.deepEqual(names(result.modified.geometry.map((pair) => pair.current)), ['Poteau 1-9']);
  assert.deepEqual(result.modified.properties.map((pair) => pair.changes), [[{ path: 'Résistance au feu', before: 'REI 120', after: 'REI 180' }]]);
  assert.deepEqual(names(result.renamedIds.map((pair) => pair.current)), ['Poteau 2-3']);
  assert.equal(result.unchanged.length, model.sources[0].count - 5);
});

test('the CSV defuses formulas in keys and names', () => {
  const evil = side([{ key: '=1+1', label: '+cmd', props: {} }], 500);
  const empty = side([], 900);
  const csv = compareCsv(run(compareJob(evil, empty)), evil, empty);
  assert.equal(csv.split('\r\n')[1], "ajouté;'=1+1;'+cmd;;");
});

// ------------------------------------------------------------- deux formats d'un même modèle (corrections, 13)

test('same box, volume and area with another triangle count: « même forme, maillage différent », not modified', () => {
  const result = run(compareJob(side([{ key: 'mur', triangles: 14 }]), side([{ key: 'mur', triangles: 12 }], 100)));
  assert.deepEqual(result.modified.geometry, []);
  assert.deepEqual(result.unchanged, []);
  assert.deepEqual(result.remeshed.map((pair) => [pair.current, pair.reference, pair.geometry, pair.triangles]), [[0, 100, 'remeshed', [12, 14]]]);
  assert.equal(statusLayer(result).get(0)?.color, '#9ca3af', 'dimmed like unchanged');
  assert.match(compareCsv(result, side([{ key: 'mur' }]), side([{ key: 'mur' }], 100)), /même forme, maillage différent;mur;mur;mur;même forme, maillage différent \(12 → 14 triangles\)/);
});

test('a 5 mm move is a move under both tolerances; +1 % volume is a change under the strict one', () => {
  const moved = (tolerance: typeof STRICT_TOLERANCE) => run(compareJob(side([{ key: 'p', at: 0.005 }]), side([{ key: 'p' }], 100), { tolerance })).modified.moved.length;
  assert.equal(moved(STRICT_TOLERANCE), 1);
  assert.equal(moved(LOOSE_TOLERANCE), 1, 'the looser tolerance never hides a move of more than 2 mm');
  const fatter: CompareSide = { ...side([{ key: 'p' }]), signature: () => ({ box: [0, 0, 0, 1000, 1000, 1000], triangles: 12, volume: 1.01, area: 6 }) };
  assert.equal(geometryStatus(fatter.signature(0), side([{ key: 'p' }]).signature(0), STRICT_TOLERANCE), 'changed');
  assert.equal(run(compareJob(fatter, side([{ key: 'p' }], 100))).modified.geometry.length, 1, 'strict by default');
  assert.equal(geometryStatus(fatter.signature(0), side([{ key: 'p' }]).signature(0), LOOSE_TOLERANCE), 'same', 'within 1 % between two engines');
});

test('the pieces of a split are compared as their original, with the note « découpé en 2 pièces »', () => {
  const original = { Catégorie: 'Mur', Matériau: 'Béton', 'Quantités calculées / Longueur (m)': 4 };
  const piece = (number: number, extra: FlatProps = {}): FlatProps => ({ ...original, 'Quantités calculées / Longueur (m)': 2, 'Pièce / Numéro': number, 'Pièce / Origine': 'Mur (w)', ...extra });
  // Deux moitiés d'un cube de 2 m de long : la boîte réunie et le volume sont ceux de l'original ; la surface a les faces de la coupe.
  const halves: CompareSide = {
    elements: [0, 1], key: (i) => `w~${i + 1}`, label: () => 'Mur', props: (i) => (i === 0 ? piece(1) : piece(2, { Matériau: 'Brique' })),
    signature: (i) => ({ box: [i * 1000, 0, 0, (i + 1) * 1000, 1000, 1000], triangles: 12, volume: 1, area: 6 }),
  };
  const whole: CompareSide = { elements: [100], key: () => 'w', label: () => 'Mur', props: () => original, signature: () => ({ box: [0, 0, 0, 2000, 1000, 1000], triangles: 12, volume: 2, area: 10 }) };
  const result = run(compareJob(halves, whole));
  assert.deepEqual([result.added, result.removed], [[], []], 'never one removed plus two added');
  assert.equal(result.modified.properties.length, 1);
  const [pair] = result.modified.properties;
  assert.deepEqual(pair.changes, [{ path: 'Matériau', before: 'Béton', after: 'Brique' }], 'what the split wrote is not a change, the hand edit on one piece is');
  assert.equal(pair.geometry, 'same');
  assert.deepEqual(pair.pieces, { side: 'current', elements: [0, 1] });
  assert.match(compareCsv(result, halves, whole), /découpé en 2 pièces/);
  const layer = statusLayer(result);
  assert.equal(layer.get(1)?.color, '#f59e0b', 'every piece carries the status');
  // Dans l'autre sens : l'original ouvert, ses pièces dans la référence.
  const back = run(compareJob(whole, halves));
  assert.deepEqual(back.modified.properties[0].pieces, { side: 'reference', elements: [0, 1] });
});

test('duplicate keys inside one model are reported as such, not as added or removed', () => {
  const twice = side([{ key: 'x' }, { key: 'x', at: 5 }, { key: 'y', at: 10 }]);
  const result = run(compareJob(twice, side([{ key: 'x' }, { key: 'y', at: 10 }], 100)));
  assert.deepEqual(result.duplicates, { current: [1], reference: [] });
  assert.deepEqual([result.added, result.removed], [[], []]);
  assert.equal(result.unchanged.length, 2);
  assert.match(compareCsv(result, twice, twice), /identifiant en double;x;x;;/);
});

test('the second pass still refuses two elements of the same type and size far apart, and pairs them within 50 cm', () => {
  const far = run(compareJob(side([{ key: 'n', label: 'Poteau', props: { Catégorie: 'Poteau' }, at: 10 }]), side([{ key: 'o', label: 'Poteau', props: { Catégorie: 'Poteau' } }], 100)));
  assert.deepEqual([far.added, far.removed, far.renamedIds], [[0], [100], []]);
  // Un millimètre de plus sur la taille, de part et d'autre d'un arrondi au centimètre : toujours « probablement le même ».
  const near = run(compareJob(side([{ key: 'n', label: 'Poteau', props: { Catégorie: 'Poteau' }, at: 0.1, size: 1.0151 }]), side([{ key: 'o', label: 'Poteau', props: { Catégorie: 'Poteau' }, size: 1.0149 }], 100), { tolerance: LOOSE_TOLERANCE }));
  assert.deepEqual(near.renamedIds.map((pair) => [pair.current, pair.reference]), [[0, 100]]);
});

test('an element drawn as its box only is « non comparable (forme approchée) », never changed', () => {
  const boxed: CompareSide = { ...side([{ key: 'b', triangles: 12 }]), approximate: () => true };
  const read = side([{ key: 'b', size: 3, triangles: 900 }], 100);
  const result = run(compareJob(boxed, read));
  assert.deepEqual(result.modified.geometry, []);
  assert.deepEqual(result.approximate.map((pair) => pair.geometry), ['approximate']);
  assert.match(compareCsv(result, boxed, read), /non comparable \(forme approchée\);b;b;b;non comparable \(forme approchée\)/);
});

test('two engines: differences on locked paths are conversion gaps, apart; an edited property is still one change', () => {
  const opened = side([{ key: 'm', props: { 'Classe IFC': 'IfcWall', Qto_WallBaseQuantities: 1, Résistance: 'REI 60' } }]);
  const before = side([{ key: 'm', props: { 'Classe IFC': 'IfcWallStandardCase', Qto_WallBaseQuantities: 1.001, Résistance: 'REI 30' } }], 100);
  const result = run(compareJob(opened, before, { conversionPaths: ['Classe IFC', 'Qto_*'] }));
  assert.deepEqual(result.modified.properties.map((pair) => pair.changes.map((change) => change.path)), [['Résistance']]);
  assert.deepEqual(result.conversion.map((pair) => pair.conversion.map((change) => change.path)), [['Classe IFC', 'Qto_WallBaseQuantities']]);
  const report = compareReport(result, opened, before, ['Ouverte : « a.ifc »', 'Référence : « a.glb »']);
  assert.deepEqual(report.origins, ['Ouverte : « a.ifc »', 'Référence : « a.glb »']);
  assert.equal(report.conversion.length, 1);
  assert.match(compareCsv(result, opened, before, ['Ouverte : « a.ifc »']), /^Ouverte : « a\.ifc »\r\nStatut;/);
});
