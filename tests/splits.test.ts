import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Box3, Color, Vector3 } from 'three';
import { runTool, type ToolContext } from '../src/assistant/tools.ts';
import { parseMetadata, type PropValue } from '../src/data/metadata.ts';
import { PropertyEdits } from '../src/data/PropertyEdits.ts';
import { parseScheduleDate } from '../src/data/schedule.ts';
import { applyOverlays, buildStore, modificationsFile, openingProps } from '../src/data/sidecar.ts';
import { toModelPoint, toViewerPoint, type Vec3 } from '../src/data/modelFrame.ts';
import { MAX_CUTS, MAX_PARTS, MIN_INTERVAL, PART_SEQUENCE, SplitSet, applyTailChange, describeOutcome, freeLineProblem, loadSplits, parseSplits, splitRefusalsOf, splitsOf, splitsToJson, type OriginalOf, type SplitDefinition, type SplitOutcome } from '../src/data/splits.ts';
import { splitJob, type ElementSplit, type SplitRefusal } from '../src/engine/derivedParts.ts';
import type { Model } from '../src/engine/Model.ts';
import { extendAcross } from '../src/engine/sketch.ts';
import type { CutPlane } from '../src/engine/splitMesh.ts';
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

test('a definition asking for too many cuts is dropped at reading and refused when computed, quickly and without parts', async () => {
  const hostile: SplitDefinition[] = [
    { id: 'pas', elements: ['dalle'], references: { axis: 'x', interval: 1e-9 } },
    { id: 'nombre', elements: ['dalle'], references: { axis: 'x', count: 1e9 } },
    { id: 'positions', elements: ['dalle'], references: { axis: 'x', positions: Array.from({ length: 10_000 }, (_, i) => i * 1e-4) } },
  ];
  const started = performance.now();
  const refusals: string[] = [];
  assert.deepEqual(parseSplits(splitsToJson(hostile), refusals), []);
  assert.equal(refusals.length, 3);
  assert.match(refusals[0], /« pas » ignoré : pas de moins de 1 cm/);
  assert.match(refusals[1], new RegExp(`« nombre » ignoré : plus de ${MAX_CUTS} coupes`));
  // Lu par parseMetadata : le fichier s'ouvre, sans découpage, et dit pourquoi.
  const metadata = parseMetadata({ elements: {}, splits: splitsToJson(hostile) });
  assert.equal(metadata.splits, undefined);
  assert.equal(splitRefusalsOf(metadata, []).length, 3);
  // Calculées directement (sans passer par la lecture), les mêmes définitions sont refusées avant toute boucle.
  const model = await build();
  const set = new SplitSet(model, select);
  for (const definition of [...hostile, { id: 'long', elements: ['dalle'], references: { axis: 'x' as const, interval: MIN_INTERVAL } }]) {
    const outcome = run(set.compute(definition, []));
    assert.equal(outcome.splits.length, 0, definition.id);
    assert.match(outcome.refused[0].reason, /plus de 200 coupes/, definition.id);
  }
  assert.equal(model.count, 2, 'no part was produced');
  assert.ok(performance.now() - started < 2000, 'refused quickly');
});

/** Un cube unité, et `n` lignes en plan (n/2 dans chaque sens) qui le traversent toutes. */
async function crossedCube(n: number) {
  const model = await buildFromNodes([{ mesh: 0, extras: { id: 'cube' } }], [0], CUBE);
  const lines: number[][][] = [];
  for (let k = 1; k <= n / 2; k++) {
    const t = k / (n / 2 + 1);
    lines.push([[t, 0, -1], [t, 0, 2]], [[-1, 0, t], [2, 0, t]]);
  }
  return { model, definition: parseSplits([{ id: 'grille', elements: ['cube'], lines }])[0] };
}

test('200 crossing lines from a file (10 201 parts) are refused before any cut, quickly', async () => {
  const { model, definition } = await crossedCube(MAX_CUTS);
  assert.ok(definition, 'the reading accepts 200 lines');
  const started = performance.now();
  const outcome = run(new SplitSet(model, select).compute(definition, []));
  assert.equal(outcome.splits.length, 0);
  assert.match(outcome.refused[0].reason, new RegExp(`plus de ${MAX_PARTS} pièces`));
  assert.ok(performance.now() - started < 1000, 'refused before cutting');
});

test('a definition stops at MAX_PARTS parts in all, the next elements are refused', async () => {
  const count = Math.ceil(MAX_PARTS / 10) + 5;
  const model = await buildFromNodes(Array.from({ length: count }, (_, i) => ({ mesh: 0, translation: [i * 2, 0, 0], extras: { id: `c${i}` } })), Array.from({ length: count }, (_, i) => i), CUBE);
  const outcome = run(new SplitSet(model, select).compute({ id: 'tous', elements: model.keys, references: { axis: 'z', count: 10 } }, []));
  const parts = outcome.splits.reduce((sum, split) => sum + split.parts.length, 0);
  assert.ok(parts <= MAX_PARTS && parts > 0, String(parts));
  assert.ok(outcome.refused.length > 0);
  assert.match(outcome.refused[0].reason, new RegExp(`plus de ${MAX_PARTS} pièces`));
});

test('cutting one element pauses between plane cuts, not only between elements', async () => {
  const model = await buildFromNodes([{ mesh: 0, extras: { id: 'cube' } }], [0], CUBE);
  const [min, max] = [model.boxes[0], model.boxes[3]];
  const planes: CutPlane[] = Array.from({ length: 20 }, (_, k) => ({ normal: [1, 0, 0], constant: -(min + ((k + 1) * (max - min)) / 21) }));
  const out: { splits: ElementSplit[]; refused: SplitRefusal[] } = { splits: [], refused: [] };
  let pauses = 0;
  for (const _ of splitJob(model, [0], () => planes, out, 50)) pauses++;
  assert.equal(out.splits[0].parts.length, 21);
  assert.ok(pauses > 5, `${pauses} pauses`);
});

test('an element whose key another element carries too is refused, the other is not cut', async () => {
  const model = await buildFromNodes([{ mesh: 0, name: 'Mur' }, { mesh: 0, name: 'Mur', translation: [10, 0, 0] }], [0, 1], CUBE);
  assert.deepEqual(model.keys, ['Mur', 'Mur']);
  const outcome = run(new SplitSet(model, select).compute({ id: 'd', elements: ['Mur'], references: { axis: 'x', count: 2 } }, []));
  assert.equal(outcome.splits.length, 0);
  assert.match(outcome.refused[0].reason, /identifiant en double/);
});

test('splits of a JSON dropped on the open model go through loadSplits; its edits of parts then land on them', async () => {
  const { model, set, store, edits } = await open([]);
  edits.set([1], 'Lot', 'GO');
  const overlay = parseMetadata({ elements: { 'dalle~3': { properties: { Lot: 'Coulage 3' } } }, splits: splitsToJson([cross]) });
  const source: OriginalOf = (i) => ({ props: store.propsOf(i), label: model.names[i] });
  const apply = { source, onChange: (change: Parameters<typeof applyTailChange>[0]) => applyTailChange(change, model, store, edits, null) };
  assert.deepEqual(await loadSplits(set, splitsOf(null, [overlay]), null, [], undefined, apply), []);
  assert.deepEqual(model.keys, ['dalle', 'mur', 'dalle~1', 'dalle~2', 'dalle~3', 'dalle~4']);
  assert.equal(store.count, model.count);
  assert.equal(store.propsOf(1)?.Lot, 'GO', 'the edit made before stays');
  edits.import(overlay, model.keys);
  assert.equal(store.propsOf(4)?.Lot, 'Coulage 3');
  // The same JSON dropped again: the definition is already there, nothing is cut twice.
  const again = await loadSplits(set, splitsOf(null, [overlay]), null, [], undefined, apply);
  assert.match(again.join(' '), /déjà en place/);
  assert.equal(model.count, 6);
  assert.equal(store.propsOf(4)?.Lot, 'Coulage 3');
});

test('a failing reshape (a model that cannot be added) puts the parts back as they were', async () => {
  const { model, set, store } = await open([cross]);
  const keys = [...model.keys], parents = [...model.parents];
  assert.throws(() => set.reshape(() => { throw new Error('mémoire'); }, (i) => ({ props: store.propsOf(i), label: model.names[i] })), /mémoire/);
  assert.deepEqual(model.keys, keys);
  assert.deepEqual(model.parents, parents);
  assert.equal(model.state.isReplaced(0), true);
  assert.deepEqual(set.tailStart.element, 2);
});

/** Une coupe en plan, repère du viewer → définition (repère du modèle), comme la carte l'enregistre. */
const toDefinition = (model: Model, id: string, lines: [Vector3, Vector3][]): SplitDefinition => {
  const offset = model.offset.toArray();
  return { id, elements: ['dalle'], lines: lines.map(([a, b]) => [toModelPoint(a.toArray(), offset), toModelPoint(b.toArray(), offset)] as [Vec3, Vec3]) };
};
const volumesOf = (outcome: SplitOutcome) => outcome.splits.flatMap((split) => split.parts.map((part) => +part.volume.toFixed(6)));

test('a straight two-point cut shorter than the element cuts it completely; drawn short without the tool, it is refused as before', async () => {
  const model = await build();
  const set = new SplitSet(model, select);
  const offset = model.offset.toArray();
  // Deux clics à 40 cm l'un de l'autre, au milieu de la dalle (2 m de large en z) : x = 1.
  const [a, b] = [[1, 0.2, 0.8], [1, 0.2, 1.2]].map((point) => new Vector3(...toViewerPoint(point, offset)));
  const box = model.boxOf([0], new Box3());
  const straight = run(set.compute(toDefinition(model, 'droite', [extendAcross(a, b, box)]), []));
  assert.deepEqual(straight.refused, []);
  assert.deepEqual(volumesOf(straight), [0.4, 1.2], 'the whole line through the two points: two parts, west and east');
  const short = run(set.compute(toDefinition(model, 'courte', [[a, b]]), []));
  assert.equal(short.splits.length, 0);
  assert.match(short.refused[0].reason, /aucune coupe ne traverse/, 'a stored line keeps its meaning (bounded by its two points): definitions saved before load the same');
});

test('a definition saved before (crossing lines) gives the same parts as before, and as the same lines drawn with the tool', async () => {
  const model = await build();
  const set = new SplitSet(model, select);
  const legacy = run(set.compute(cross, []));
  assert.deepEqual(legacy.refused, []);
  assert.deepEqual(volumesOf(legacy), [0.2, 0.6, 0.2, 0.6]);
  const offset = model.offset.toArray(), box = model.boxOf([0], new Box3());
  const drawn = cross.lines!.map(([p, q]) => extendAcross(new Vector3(...toViewerPoint(p, offset)), new Vector3(...toViewerPoint(q, offset)), box));
  assert.deepEqual(volumesOf(run(set.compute(toDefinition(model, 'trace', drawn), []))), [0.2, 0.6, 0.2, 0.6]);
});

test('a free stroke that does not cross is refused with the reason, while drawing and when cut', async () => {
  const model = await build();
  const offset = model.offset.toArray();
  const at = (x: number, z: number) => { const [vx, , vz] = toViewerPoint([x, 0.2, z], offset); return [vx, vz] as [number, number]; };
  const elements = [{ label: 'Dalle', parts: model.parts(0) }, { label: 'Mur', parts: model.parts(1) }];
  assert.equal(freeLineProblem(elements, at(1, -1), at(1, 3)), null, 'across the slab');
  assert.match(String(freeLineProblem(elements, at(1, -1), at(1, 1))), /coupe partielle de « Dalle »/, 'stops in the middle');
  assert.match(String(freeLineProblem(elements, at(1, -1), at(1, -0.5))), /ne traverse aucun élément/);
  // A bent stroke: its first segment crosses, its second stops inside.
  const bent: [Vector3, Vector3][] = [[[1, -1], [1, 3]], [[1, 3], [3, 1]]].map((line) => line.map(([x, z]) => new Vector3(...toViewerPoint([x, 0.2, z], offset))) as [Vector3, Vector3]);
  assert.match(String(freeLineProblem(elements, [bent[1][0].x, bent[1][0].z], [bent[1][1].x, bent[1][1].z])), /coupe partielle/);
  const outcome = run(new SplitSet(model, select).compute(toDefinition(model, 'coude', bent), []));
  assert.equal(outcome.splits.length, 0);
  assert.match(outcome.refused[0].reason, /coupe partielle/);
});

test('editing a split recomputes it under the same id: its elements are not refused as already cut, its parts are replaced', async () => {
  const { model, set, store } = await open([cross]);
  const halves: SplitDefinition = { id: 'coulage', elements: ['dalle'], references: { axis: 'x', count: 2 } };
  const outcome = run(set.compute(halves, []));
  assert.deepEqual(outcome.refused, []);
  const renew = model.keys.filter((_, i) => model.parents[i] === 0);
  applyTailChange(set.put(halves, outcome.splits, fromExtras(model), renew), model, store, null, null);
  assert.deepEqual(model.keys, ['dalle', 'mur', 'dalle~1', 'dalle~2']);
  assert.equal(store.propsOf(2)?.['Quantités calculées / Volume net (m³)'], 0.8, 'the renewed part has its new quantities');
  assert.match(run(set.compute({ ...halves, id: 'autre' }, [])).refused[0].reason, /déjà découpé/, 'another split of the same element is still refused');
});

test('a reason shared by several elements is said once', () => {
  const refused = [{ element: 0, reason: 'aucune coupe ne traverse l’élément' }, { element: 1, reason: 'aucune coupe ne traverse l’élément' }, { element: 2, reason: 'maillage ouvert' }];
  assert.deepEqual(describeOutcome({ splits: [], refused, missingLevels: [] }, (i) => `Poteau ${i + 1}`), [
    '2 éléments non découpés (« Poteau 1 », « Poteau 2 ») : aucune coupe ne traverse l’élément.',
    '« Poteau 3 » non découpé : maillage ouvert.',
  ]);
});
