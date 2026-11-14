import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Box3, Color, Vector3 } from 'three';
import { MODEL_PROPERTY, addSource, documentsBySource, flatKeys, framesApart, rekeyMetadata, removeLastSource, sourceBox, sourceIndexOf, type FederationContext } from '../src/data/federation.ts';
import { parseMetadata } from '../src/data/metadata.ts';
import { PropertyEdits } from '../src/data/PropertyEdits.ts';
import { buildStore, modificationsFile, openingProps } from '../src/data/sidecar.ts';
import { SplitSet, applyTailChange, type OriginalOf } from '../src/data/splits.ts';
import { gltfSource } from '../src/engine/buildModel.ts';
import { loadModelFiles } from '../src/engine/loadModel.ts';
import type { Model } from '../src/engine/Model.ts';
import { CUBE, buildFromNodes, makeGlb } from './helpers.ts';

const select = { value: new Color() };

/** Maquette A : deux cubes « a » et « b », le premier découpable. */
const nodesA = [
  { mesh: 0, extras: { id: 'a', Niveau: 'RDC' } },
  { mesh: 0, translation: [3, 0, 0], extras: { id: 'b', Niveau: 'RDC' } },
];
/** Maquette B, ailleurs : « b » (même clé que dans A) et « c ». */
const nodesB = [
  { mesh: 0, translation: [20, 0, 0], extras: { id: 'b', Niveau: 'R+1' } },
  { mesh: 0, translation: [23, 0, 0], extras: { id: 'c', Niveau: 'R+1' } },
];

async function sceneOf(nodes: object[]) {
  const file = new File([makeGlb(nodes, nodes.map((_, i) => i), CUBE)], 'b.glb');
  return gltfSource((await loadModelFiles({ file, path: file.name }, [])).gltf);
}

async function session() {
  const model = await buildFromNodes(nodesA, [0, 1], CUBE);
  const splits = new SplitSet(model, select);
  const store = buildStore(model.keys, model.extras, null);
  const edits = new PropertyEdits(store, () => {});
  const original: OriginalOf = (i) => ({ props: store.propsOf(i), label: model.names[i] });
  const context: FederationContext = { model, splits, selectColor: select, original, first: { name: 'a.glb', kind: 'glb' }, maxTriangles: 1e6 };
  return { model, splits, store, edits, context };
}

/** Reporte un ajout ou un retrait sur les propriétés, comme `App.changeParts` avec les métadonnées de la maquette ajoutée. */
function apply(model: Model, store: ReturnType<typeof buildStore>, edits: PropertyEdits, change: Parameters<typeof applyTailChange>[0], metadata: Parameters<typeof applyTailChange>[4] = null) {
  applyTailChange(change, model, store, edits, metadata);
  edits.stamp(MODEL_PROPERTY, (i) => (model.sources.length ? model.sources[sourceIndexOf(model, i)].name : undefined));
}

test('a second model is appended: indices continue, ranges are recorded, colliding keys are prefixed, placement keeps original coordinates', async () => {
  const { model, store, edits, context } = await session();
  const triangles = model.triangleCount;
  const offset = model.offset.toArray();
  const added = addSource(context, { name: 'b.glb', kind: 'glb', geometry: await sceneOf(nodesB) });
  apply(model, store, edits, added.change);
  assert.deepEqual(model.keys, ['a', 'b', 'm2|b', 'c']);
  assert.equal(added.prefixed, 1);
  assert.deepEqual(model.sources.map(({ id, start, count, role }) => ({ id, start, count, role })), [
    { id: 'm1', start: 0, count: 2, role: 'model' }, { id: 'm2', start: 2, count: 2, role: 'model' },
  ]);
  assert.deepEqual(model.offset.toArray(), offset, 'one world frame: the first model keeps its offset');
  // « c » est à x = 23 dans son fichier : x = 23 − décalage dans le repère du viewer.
  assert.ok(Math.abs(model.boxes[3 * 6] - (23 - offset[0])) < 1e-4);
  assert.equal(model.triangleCount, triangles * 2);
  assert.equal(store.count, 4);
  assert.equal(store.propsOf(3)?.Niveau, 'R+1');
  assert.equal(store.propsOf(0)?.[MODEL_PROPERTY], 'a.glb');
  assert.equal(store.propsOf(2)?.[MODEL_PROPERTY], 'b.glb');
  assert.ok(sourceBox(model, model.sources[1]).min.x > 15);
  assert.equal(added.apart, 16, '16 m away from a 4 m model: worth a warning');
});

test('removing the last model restores indices, triangles and box; parts of the first model stay at the end and keep their edits', async () => {
  const { model, splits, store, edits, context } = await session();
  // Découpe « a » en deux : ses pièces vont à la fin.
  const definition = { id: 'd', elements: ['a'], references: { axis: 'x' as const, count: 2 } };
  const job = splits.compute(definition, []);
  let next = job.next();
  while (!next.done) next = job.next();
  applyTailChange(splits.put(definition, next.value.splits, context.original), model, store, edits, null);
  assert.deepEqual(model.keys, ['a', 'b', 'a~1', 'a~2']);
  edits.set([3], 'Niveau', 'R+3');
  const box = model.box.clone(), triangles = model.triangleCount;

  const added = addSource(context, { name: 'b.glb', kind: 'glb', geometry: await sceneOf(nodesB) });
  apply(model, store, edits, added.change);
  assert.deepEqual(model.keys, ['a', 'b', 'm2|b', 'c', 'a~1', 'a~2'], 'parts stay at the end');
  assert.deepEqual(model.parents, [-1, -1, -1, -1, 0, 0]);
  assert.equal(model.state.isReplaced(0), true);
  assert.equal(store.propsOf(5)?.Niveau, 'R+3', 'an edited part keeps its value');
  assert.equal(store.propsOf(5)?.[MODEL_PROPERTY], 'a.glb', 'a part belongs to its original’s model');
  assert.equal(Object.keys(edits.diff(model.keys).elements).join(), 'a~2');

  const change = removeLastSource(model, splits, context.original);
  apply(model, store, edits, change);
  assert.deepEqual(model.keys, ['a', 'b', 'a~1', 'a~2']);
  assert.deepEqual(model.sources, [], 'back to a single model');
  assert.equal(store.count, 4);
  assert.equal(store.propsOf(3)?.Niveau, 'R+3');
  assert.equal(store.propsOf(0)?.[MODEL_PROPERTY], undefined, 'no « Modèle » with a single model');
  assert.equal(model.triangleCount, triangles);
  assert.deepEqual([model.box.min.toArray(), model.box.max.toArray()], [box.min.toArray(), box.max.toArray()]);
  edits.undo();
  assert.equal(store.propsOf(3)?.Niveau, 'RDC', 'history followed the renumbering');
});

test('per-source exports keep each file’s own keys, without « Modèle »', async () => {
  const { model, store, edits, context } = await session();
  const metadataB = parseMetadata({ readOnly: ['Niveau'], elements: { b: { label: 'Poutre', properties: { Lot: 'CVC' } }, c: { properties: { Lot: 'CVC' } } } });
  const added = addSource(context, { name: 'b.glb', kind: 'glb', geometry: await sceneOf(nodesB) });
  const rekeyed = rekeyMetadata(metadataB, added.keyMap);
  assert.deepEqual([...rekeyed.elements.keys()], ['m2|b', 'c']);
  apply(model, store, edits, added.change, rekeyed);
  assert.equal(store.labelOf(2), 'Poutre');
  assert.equal(openingProps('m2|b', model.extras[2], rekeyed)?.Lot, 'CVC');
  store.readOnly = [...store.readOnly, MODEL_PROPERTY];
  edits.set([0, 2], 'Lot', 'GO');

  const full = documentsBySource(store.export(model.keys), model);
  assert.deepEqual(full.map(({ source, document }) => [source.name, Object.keys(document.elements as object)]), [['a.glb', ['a', 'b']], ['b.glb', ['b', 'c']]]);
  const b = (full[1].document.elements as Record<string, { properties: Record<string, unknown> }>).b;
  assert.equal(b.properties.Lot, 'GO');
  assert.equal(MODEL_PROPERTY in b.properties, false);
  assert.equal(full[0].document.readOnly, undefined, '« Modèle » is not a lock of the file');

  const changes = documentsBySource(modificationsFile(edits, model.keys, 'a.glb', [], { zones: [{ name: 'Z', points: [] }] }), model);
  assert.deepEqual(changes.map(({ document }) => Object.keys(document.elements as object)), [['a'], ['b']]);
  assert.deepEqual(changes.map(({ document }) => document.source), [{ name: 'a.glb', kind: 'glb' }, { name: 'b.glb', kind: 'glb' }]);
  assert.ok(changes[0].document.zones && !changes[1].document.zones, 'session sections go with the first model');
});

test('a model that would exceed the triangle budget is refused with the figures, nothing changes', async () => {
  const { model, context } = await session();
  const keys = [...model.keys];
  await assert.rejects(async () => addSource({ ...context, maxTriangles: model.triangleCount + 5 }, { name: 'b.glb', kind: 'glb', geometry: await sceneOf(nodesB) }), /budget de cet appareil/);
  assert.deepEqual(model.keys, keys);
  assert.deepEqual(model.sources, []);
});

test('key prefixes and frame consistency are plain functions', () => {
  assert.deepEqual(flatKeys(['a', 'b'], ['b', 'c'], 'm3'), ['m3|b', 'c']);
  const box = (x: number) => new Box3(new Vector3(x, 0, 0), new Vector3(x + 10, 3, 10));
  assert.equal(framesApart(box(0), box(12)), null, 'two neighbouring buildings');
  assert.ok((framesApart(box(0), box(5000)) ?? 0) > 4000, 'a shifted base point');
});

test('the same file added twice gets a distinct model name', async () => {
  const { model, context } = await session();
  addSource(context, { name: 'a.glb', kind: 'glb', geometry: await sceneOf(nodesA) });
  assert.deepEqual(model.sources.map((source) => source.name), ['a.glb', 'a.glb (2)']);
  assert.deepEqual(model.keys, ['a', 'b', 'm2|a', 'm2|b']);
});
