import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Color } from 'three';
import { runTool, type ToolContext } from '../src/assistant/tools.ts';
import { parseMetadata, type PropValue } from '../src/data/metadata.ts';
import { PropertyEdits } from '../src/data/PropertyEdits.ts';
import { parseScheduleDate } from '../src/data/schedule.ts';
import { applyOverlays, buildStore, modificationsFile, openingProps } from '../src/data/sidecar.ts';
import { PART_SEQUENCE, SplitSet, applyTailChange, parseSplits, splitsOf, splitsToJson, type OriginalOf, type SplitDefinition } from '../src/data/splits.ts';
import type { Model } from '../src/engine/Model.ts';
import { writeGlb } from '../src/engine/writeGlb.ts';
import { CUBE, buildFromNodes, loadGlb } from './helpers.ts';

/** Une dalle 4 × 0,2 × 2 m (centrée en x = 2, z = 1) et un mur 1 × 1 × 1 plus loin. */
const nodes = [
  { mesh: 0, scale: [4, 0.2, 2], extras: { id: 'dalle', Niveau: 'RDC' } },
  { mesh: 0, translation: [10, 0, 0], extras: { id: 'mur', Niveau: 'RDC' } },
];
const build = () => buildFromNodes(nodes, [0, 1], CUBE);
const select = { value: new Color() };
const fromExtras = (model: Model): OriginalOf => (i) => ({ props: openingProps(model.keys[i], model.extras[i], null), label: model.names[i] });

/** Deux lignes en plan, en croix, dans le repère du modèle : quatre pièces. */
const cross: SplitDefinition = { id: 'coulage', elements: ['dalle'], lines: [[[1, 0.2, -1], [1, 0.2, 3]], [[-1, 0.2, 1], [5, 0.2, 1]]] };

function run<T>(job: Generator<number, T, unknown>): T {
  for (;;) {
    const next = job.next();
    if (next.done) return next.value;
  }
}

/** Ouvre le modèle comme l'application : les pièces des définitions d'abord, puis les propriétés de tous les éléments. */
async function open(definitions: SplitDefinition[]) {
  const model = await build();
  const set = new SplitSet(model, select);
  const refused: string[] = [];
  for (const definition of definitions) {
    const outcome = run(set.compute(definition, []));
    refused.push(...outcome.refused.map((item) => item.reason));
    set.put(definition, outcome.splits, fromExtras(model));
  }
  const store = buildStore(model.keys, model.extras, null);
  const edits = new PropertyEdits(store, () => {});
  return { model, set, store, edits, refused };
}

test('a definition gives parts with stable keys, the original hidden; a reload gives the same keys and keeps their edits', async () => {
  const first = await open([cross]);
  const { model, store, edits, set } = first;
  assert.deepEqual(model.keys, ['dalle', 'mur', 'dalle~1', 'dalle~2', 'dalle~3', 'dalle~4']);
  assert.deepEqual(model.parents, [-1, -1, 0, 0, 0, 0]);
  assert.equal(model.state.isReplaced(0), true, 'the original is hidden, not removed');
  assert.equal(model.state.isRendered(0), false);
  assert.equal(model.state.isRendered(2), true);
  assert.equal(store.count, model.count);
  // Parts copy the original's properties and get their own.
  assert.equal(store.propsOf(2)?.Niveau, 'RDC');
  assert.equal(store.propsOf(3)?.['Pièce / Numéro'], 2);
  assert.equal(store.propsOf(3)?.[PART_SEQUENCE], 2);
  assert.equal(store.propsOf(3)?.['Pièce / Maillage valide'], true);
  assert.equal(store.propsOf(2)?.['Quantités calculées / Fiabilité'], 'exact');
  const volumes = [2, 3, 4, 5].map((i) => store.propsOf(i)?.['Quantités calculées / Volume net (m³)'] as number);
  assert.deepEqual(volumes.map((v) => +v.toFixed(6)), [0.2, 0.6, 0.2, 0.6], 'south-west first, then south-east, north-west, north-east');

  edits.set([4], PART_SEQUENCE, 7);
  const file = JSON.parse(JSON.stringify(modificationsFile(edits, model.keys, 'maquette.glb', [], { splits: splitsToJson(set.definitions) })));
  assert.deepEqual(Object.keys(file.elements), ['dalle~3']);

  // Reload: the file carries the definition and the part's edit, never a mesh.
  const overlay = parseMetadata(file);
  const second = await open(splitsOf(null, [overlay]));
  assert.deepEqual(second.model.keys, model.keys);
  applyOverlays(second.edits, [overlay], second.model.keys);
  assert.equal(second.store.propsOf(4)?.[PART_SEQUENCE], 7, 'a value written on a part survives');
  assert.deepEqual(parseSplits(splitsToJson(second.set.definitions)), [cross]);
});

test('removing a split restores the original; later parts are renumbered with their properties and history', async () => {
  const halves: SplitDefinition = { id: 'murs', elements: ['mur'], references: { axis: 'x', count: 2 } };
  const { model, set, store, edits } = await open([cross, halves]);
  assert.deepEqual(model.keys.slice(6), ['mur~1', 'mur~2']);
  edits.set([7], 'Lot', 'Gros œuvre');
  const change = set.remove('coulage', (i) => ({ props: store.propsOf(i), label: model.names[i] }))!;
  applyTailChange(change, model, store, edits, null);
  assert.deepEqual(model.keys, ['dalle', 'mur', 'mur~1', 'mur~2']);
  assert.equal(model.state.isReplaced(0), false, 'the original is back');
  assert.equal(model.state.isRendered(0), true);
  assert.equal(model.state.isReplaced(1), true);
  assert.equal(store.count, 4);
  assert.equal(store.propsOf(3)?.Lot, 'Gros œuvre', 'the edit followed its part');
  assert.equal(edits.isModified(3, 'Lot'), true);
  edits.undo();
  assert.equal(store.propsOf(3)?.Lot, undefined, 'undo reaches the renumbered part');
  assert.equal(model.chunks.every((chunk) => chunk.mesh.parent === model.group), true);
});

test('merging two neighbouring parts keeps the smaller number; non-neighbours are refused', async () => {
  const { model, set, store } = await open([cross]);
  const source: OriginalOf = (i) => ({ props: store.propsOf(i), label: model.names[i] });
  assert.match(String(set.mergeDefinition(2, 5)), /ne se touchent pas/, 'diagonal quarters');
  store.set(4, { ...store.propsOf(4), Lot: 'GO' });
  const { definition, renew } = set.mergeDefinition(2, 3) as { definition: SplitDefinition; renew: string[] };
  assert.deepEqual(definition.merged, [['dalle~1', 'dalle~2']]);
  applyTailChange(set.put(definition, null, source, renew), model, store, null, null);
  assert.deepEqual(model.keys.slice(2), ['dalle~1', 'dalle~3', 'dalle~4']);
  assert.equal(store.propsOf(2)?.['Quantités calculées / Volume net (m³)'], 0.8);
  assert.equal(store.propsOf(2)?.['Pièce / Maillage valide'], true);
  assert.equal(model.state.isReplaced(0), true);
  assert.equal(store.propsOf(3)?.Lot, 'GO', 'an untouched part keeps its properties');
});

test('a missing original is reported, the other elements are still cut', async () => {
  const { model, refused } = await open([{ ...cross, elements: ['absent', 'dalle'] }]);
  assert.equal(model.keys.length, 6);
  assert.deepEqual(refused, ['élément d’origine « absent » introuvable dans ce modèle']);
});

test('plan_dates orders parts by « Pièce / Séquence » like any property', async () => {
  const { model, store, edits } = await open([cross]);
  edits.setMany([[2, PART_SEQUENCE, 4], [3, PART_SEQUENCE, 3], [4, PART_SEQUENCE, 2], [5, PART_SEQUENCE, 1]]);
  const context: ToolContext = {
    store, count: model.count, keys: model.keys, labelOf: (i) => model.names[i], selection: new Set(), select: () => {},
    writeProperties: (updates) => edits.setMany(updates as [number, string, PropValue][]), heightOf: () => 0,
  };
  const outcome = runTool('plan_dates', { filters: [{ property: PART_SEQUENCE, op: 'present' }], start: '2027-01-04', end: '2027-03-26', minDays: 5, maxDays: 5, orderBy: [PART_SEQUENCE] }, context);
  assert.equal((outcome.result as { elements: number }).elements, 4);
  const start = (i: number) => parseScheduleDate(store.propsOf(i)?.['Planning / Date début']);
  assert.ok(start(5) < start(4) && start(4) < start(3) && start(3) < start(2), 'sequence 1 is poured first');
});

test('the GLB export contains the parts instead of their original; reopened with its definition, nothing is cut twice', async () => {
  const { model } = await open([cross]);
  const glb = writeGlb(model, undefined, { skip: (i) => model.state.isReplaced(i) });
  const reopened = (await loadGlb(glb)).model;
  assert.deepEqual(reopened.keys, ['mur', 'dalle~1', 'dalle~2', 'dalle~3', 'dalle~4']);
  const set = new SplitSet(reopened, select);
  const outcome = run(set.compute(cross, []));
  assert.deepEqual(outcome, { splits: [], refused: [], missingLevels: [] }, 'the parts are already in the file');
});
