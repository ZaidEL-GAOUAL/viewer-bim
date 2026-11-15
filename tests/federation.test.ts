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

// ------------------------------------------------------------ origines, Revit ajouté, formes approchées (corrections, 13 et 14)

test('the origin line of each kind of source, and engines compared', async () => {
  const { REVIT_ENGINE, enginesDiffer, generatorOf, originLine, producerOf } = await import('../src/data/federation.ts');
  const { metadataUse } = await import('../src/data/sidecar.ts');
  const browser = { ...producerOf('ifc', 'viewer-bim ifc_to_glb (IfcOpenShell 0.8.5)'), metadata: 'de la conversion' };
  const cli = { ...producerOf('glb', generatorOf({ asset: { version: '2.0', generator: 'viewer-bim ifc_to_glb (IfcOpenShell 0.9.0)' } })), metadata: 'JSON complet' };
  assert.equal(originLine({ name: 'demo.ifc', origin: browser }), '« demo.ifc », converti dans le navigateur (IfcOpenShell 0.8.5) ; métadonnées : de la conversion.');
  assert.equal(originLine({ name: 'demo.glb', origin: cli }), '« demo.glb », glTF écrit par « viewer-bim ifc_to_glb (IfcOpenShell 0.9.0) » ; métadonnées : JSON complet.');
  assert.deepEqual(producerOf('revit'), { producer: 'lu nativement (Revit)', engine: REVIT_ENGINE });
  assert.equal(producerOf('usd').producer, 'USD');
  assert.equal(producerOf('glb').producer, 'glTF sans convertisseur indiqué');
  assert.equal(enginesDiffer(browser, cli), true, 'two IfcOpenShell versions');
  assert.equal(enginesDiffer(cli, { ...cli, metadata: 'de la conversion' }), false, 'same generator, whatever the metadata');
  assert.equal(enginesDiffer({ ...producerOf('revit'), metadata: '' }, { ...producerOf('glb', REVIT_ENGINE), metadata: '' }), false, 'a GLB ↓ of a Revit read compares to its .rvt');
  assert.equal(generatorOf({ asset: {} }), undefined);
  // Les métadonnées utilisées.
  const own = parseMetadata({ elements: { a: {} } }), json = parseMetadata({ elements: { a: {} } });
  assert.equal(metadataUse(own, own, []), 'de la conversion');
  assert.equal(metadataUse(own, json, []), 'conversion + JSON appliqué');
  assert.equal(metadataUse(own, own, [json]), 'conversion + JSON appliqué');
  assert.equal(metadataUse(null, json, []), 'JSON complet');
  assert.equal(metadataUse(null, null, []), 'propriétés du fichier');
});

/** La maquette Revit d'essai (licence MIT), lue par le module WebAssembly livré ; `triangleBudget` comme le lecteur le reçoit. */
async function revitDemo(triangleBudget?: number) {
  const { readFileSync } = await import('node:fs');
  const { initSync, readRevit } = await import('../src/revit/pkg/revit.js');
  const { rawFromOutput } = await import('../src/revit/readRevit.ts');
  initSync({ module: readFileSync(new URL('../src/revit/pkg/revit_bg.wasm', import.meta.url)) });
  const output = readRevit(new Uint8Array(readFileSync(new URL('../public/samples/revit-demo.rvt', import.meta.url))), triangleBudget === undefined ? undefined : { triangleBudget });
  return { output, raw: rawFromOutput(output), metadata: parseMetadata(JSON.parse(output.metadata)) };
}

test('a Revit file is added to an open GLB, as a model or as the reference of a comparison, with its metadata', async () => {
  const { model, store, edits, context } = await session();
  const { output, raw, metadata } = await revitDemo();
  const added = addSource(context, { name: 'revit-demo.rvt', kind: 'revit', role: 'reference', geometry: raw });
  apply(model, store, edits, added.change, rekeyMetadata(metadata, added.keyMap));
  assert.equal(added.source.count, output.keys.length);
  assert.equal(added.source.role, 'reference');
  assert.equal(added.source.triangles, output.report.triangles);
  assert.deepEqual(model.keys.slice(2), output.keys, 'the Revit keys, none taken by the GLB');
  const first = 2 + output.keys.findIndex((key) => Object.keys(metadata.elements.get(key)?.props ?? {}).length > 0);
  assert.ok(Object.keys(store.propsOf(first) ?? {}).length > 1, 'its own properties');
  assert.equal(store.propsOf(first)?.[MODEL_PROPERTY], 'revit-demo.rvt');
  // Retirée, la session revient au GLB seul.
  apply(model, store, edits, removeLastSource(model, context.splits, context.original));
  assert.equal(model.count, 2);
});

test('a Revit file that does not fit is refused with the figures, before reading and after', async () => {
  const { revitBudget, FederationError } = await import('../src/data/federation.ts');
  assert.throws(() => revitBudget('maquette.rvt', 2_000_000, 2_500_000), (error: Error) => error instanceof FederationError
    && error.message === '« maquette.rvt » n’est pas ajouté : les 2,5 millions de triangles déjà affichés atteignent le budget de cet appareil (2 millions de triangles).');
  assert.equal(revitBudget('maquette.rvt', 10_000_000, 2_500_000), 7_500_000, 'what is left is the budget of the reading');
  const { model, context } = await session();
  const { raw } = await revitDemo();
  const before = model.count;
  assert.throws(() => addSource({ ...context, maxTriangles: model.triangleCount + 100 }, { name: 'revit-demo.rvt', kind: 'revit', geometry: raw }),
    /« revit-demo\.rvt » n’est pas ajouté : ses [\d\s]+ triangles, avec les 24 triangles déjà affichés, dépasseraient le budget de cet appareil \(124 triangles\)\./);
  assert.equal(model.count, before, 'nothing changed');
});

test('a Revit file read with what is left of a study\'s budget fits it: its boxes do not count (bringModel)', async () => {
  const { output, raw } = await revitDemo(200);
  const { buildModel } = await import('../src/engine/buildModel.ts');
  const { meshedTriangles } = await import('../src/engine/Model.ts');
  const model = buildModel(raw, select);
  assert.ok(output.report.sources.unknown > 0, 'some elements drawn as boxes');
  assert.ok(model.triangleCount > 200, 'more triangles than the budget, boxes included');
  assert.ok(meshedTriangles(model) <= 200, 'the meshed part fits the budget it was read with');
  model.dispose();
});

test('elements the reader drew as their box are flagged on the model: indicative quantities, out of clashes, not compared, not split', async () => {
  const { model, store, edits, context } = await session();
  // Un tout petit budget : passé lui, le lecteur montre les éléments par leur boîte et le dit.
  const { output, raw } = await revitDemo(200);
  assert.ok(output.report.sources.unknown > 0, 'some elements drawn as boxes');
  // Lu avec ce qui reste du budget, il entre : ses boîtes (12 triangles par élément) n'y comptent pas.
  const added = addSource({ ...context, maxTriangles: model.triangleCount + 200 }, { name: 'revit-demo.rvt', kind: 'revit', geometry: raw });
  assert.ok(added.source.triangles > 200, 'more triangles than the budget, all of them boxes');
  apply(model, store, edits, added.change);
  const boxed = [...model.boxOnly];
  assert.equal(boxed.length, output.report.sources.unknown);
  assert.ok(boxed.every((i) => i >= 2 && output.sources[i - 2] === 3), 'the flag comes from the reader, per element');
  const { boxOnlyReason } = await import('../src/engine/Model.ts');
  assert.match(boxOnlyReason(model, boxed[0]) ?? '', /seule sa boîte englobante/);
  assert.equal(boxOnlyReason(model, 0), null);
  const { computeQuantities } = await import('../src/engine/quantities.ts');
  const quantities = await computeQuantities(model, [boxed[0], 0]);
  assert.deepEqual([quantities.get(boxed[0])?.exact, quantities.get(boxed[0])?.approximate], [false, true], 'indicatif');
  assert.equal(quantities.get(0)?.approximate, undefined);
  const { clashJob } = await import('../src/engine/clash.ts');
  const everything = Array.from({ length: model.count }, (_, i) => i);
  const finish = <T>(job: Generator<number, T, unknown>): T => { for (;;) { const next = job.next(); if (next.done) return next.value; } };
  const withoutBoxes = finish(clashJob(model, everything, everything));
  assert.ok(withoutBoxes.boxOnly >= boxed.length, 'counted, out of the clash sets');
  assert.ok(withoutBoxes.clashes.every((clash) => !model.boxOnly.has(clash.a) && !model.boxOnly.has(clash.b)));
  assert.equal(finish(clashJob(model, everything, everything, { includeBoxOnly: true })).boxOnly, 0, 'unless asked');
  // Retirée, la maquette n'en laisse aucun.
  apply(model, store, edits, removeLastSource(model, context.splits, context.original));
  assert.equal(model.boxOnly.size, 0);
});
