import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clashJob } from '../src/engine/clash.ts';
import { clashTopic, clashesToJson, mergeClashes, pairKey, parseClashes, parseClashTests, parseConditions, type ClashRecord } from '../src/data/clashes.ts';
import { parseMetadata } from '../src/data/metadata.ts';
import type { Model } from '../src/engine/Model.ts';
import { CUBE, buildFromNodes } from './helpers.ts';

function run<T>(job: Generator<number, T, unknown>): T {
  for (;;) {
    const next = job.next();
    if (next.done) return next.value;
  }
}

const cube = (id: string, x: number, extra: object = {}) => ({ mesh: 0, translation: [x, 0, 0], extras: { id }, ...extra });
const all = (model: Model) => Array.from({ length: model.count }, (_, i) => i);

test('two overlapping boxes clash with the expected depth; touching boxes do not at 10 mm', async () => {
  // a [0,1], b [0.5,1.5] : 0,5 m de recouvrement ; c [2,3] touche d [3,4] ; e recouvre f de 5 mm.
  const model = await buildFromNodes([cube('a', 0), cube('b', 0.5), cube('c', 2), cube('d', 3), cube('e', 6), cube('f', 6.995)], [0, 1, 2, 3, 4, 5], CUBE);
  const outcome = run(clashJob(model, all(model), all(model), { tolerance: 0.01 }));
  assert.deepEqual(outcome.clashes.map((clash) => [clash.a, clash.b]), [[0, 1]]);
  assert.ok(Math.abs(outcome.clashes[0].depth - 0.5) < 1e-4, `depth ${outcome.clashes[0].depth}`);
  const [x] = outcome.clashes[0].point;
  assert.ok(Math.abs(x + model.offset.x - 0.75) < 1e-4, 'the point is the centre of the overlap');
  assert.equal(outcome.capped, false);
  // 5 mm de recouvrement : un conflit au-delà d'une tolérance de 1 mm seulement.
  const fine = run(clashJob(model, all(model), all(model), { tolerance: 0.001 }));
  assert.deepEqual(fine.clashes.map((clash) => [clash.a, clash.b]), [[0, 1], [4, 5]]);
  assert.ok(Math.abs(fine.clashes[1].depth - 0.005) < 1e-4);
});

test('an element entirely inside a closed one clashes; sets A and B and exclusions are honoured; the cap is reported', async () => {
  const model = await buildFromNodes([
    { mesh: 0, scale: [4, 4, 4], extras: { id: 'bloc' } },
    { mesh: 0, translation: [1, 1, 1], scale: [0.2, 0.2, 0.2], extras: { id: 'noyé' } },
    cube('voisin', 3.5),
  ], [0, 1, 2], CUBE);
  const inside = run(clashJob(model, [0], [1, 2], { tolerance: 0.01 }));
  assert.deepEqual(inside.clashes.map((clash) => [clash.a, clash.b]), [[0, 1], [0, 2]]);
  assert.ok(Math.abs(inside.clashes[0].depth - 0.2) < 1e-4, 'the contained element’s smallest size');
  const onlyB = run(clashJob(model, [1], [2], { tolerance: 0.01 }));
  assert.deepEqual(onlyB.clashes, [], 'never a pair inside one set only');
  const excluded = run(clashJob(model, all(model), all(model), { tolerance: 0.01, exclude: (a, b) => a === 0 && b === 1 }));
  assert.deepEqual(excluded.clashes.map((clash) => [clash.a, clash.b]), [[0, 2]]);
  const capped = run(clashJob(model, all(model), all(model), { tolerance: 0.01, maxCandidates: 1 }));
  assert.equal(capped.capped, true);
  assert.equal(capped.candidates, 1);
});

test('status and comment are kept across re-runs by pairing on the two keys; disappeared clashes are resolved', () => {
  const ref = (key: string) => ({ key, model: 'm.ifc' });
  const record = (a: string, b: string, status: ClashRecord['status'] = 'new', comment = ''): ClashRecord => ({ a: ref(a), b: ref(b), status, comment, depth: 0.1, point: [0, 0, 0] });
  assert.equal(pairKey(ref('x'), ref('y')), pairKey(ref('y'), ref('x')));
  const first = mergeClashes([], [record('a', 'b'), record('c', 'd')], () => true);
  assert.deepEqual(first.map((item) => item.status), ['new', 'new']);
  first[1].status = 'ignored';
  first[1].comment = 'réservation prévue';
  const second = mergeClashes(first, [record('d', 'c'), record('e', 'f')], (item) => item.a.key !== 'z');
  assert.deepEqual(second.map((item) => [item.a.key, item.status, item.comment]), [['c', 'ignored', 'réservation prévue'], ['e', 'new', ''], ['a', 'resolved', '']]);
  // A clash outside the scope of this run (a model not loaded) is left as it was.
  const third = mergeClashes([record('z', 'y', 'active', 'à voir')], [], (item) => item.a.key !== 'z');
  assert.deepEqual(third.map((item) => [item.status, item.comment]), [['active', 'à voir']]);
});

test('clash sections round-trip through the metadata contract; conditions parse from text; a BCF topic gets its data', () => {
  const records: ClashRecord[] = [{ test: 't1', a: { key: 'a', model: 's.ifc' }, b: { key: 'b', model: 'r.ifc' }, status: 'active', comment: 'ok', depth: 0.05, point: [1, 2, 3] }];
  const tests = [{ id: 't1', name: 'Structure × réseaux', a: { model: 's.ifc', conditions: parseConditions('Catégorie = Poutre') }, b: { conditions: parseConditions('Lot != Structure ; Niveau = R+1') }, type: 'hard' as const, tolerance: 0.01, exclude: [] }];
  assert.deepEqual(tests[0].b.conditions, [{ property: 'Lot', op: 'not_equals', value: 'Structure' }, { property: 'Niveau', op: 'equals', value: 'R+1' }]);
  const json = clashesToJson(tests, records);
  const metadata = parseMetadata(JSON.parse(JSON.stringify({ elements: {}, ...json })));
  assert.deepEqual(metadata.clashTests, tests);
  assert.deepEqual(metadata.clashes, records);
  assert.deepEqual(parseClashes([{ a: { key: 'x' } }, 'nope']), [], 'an unreadable entry is dropped');
  assert.deepEqual(parseClashTests([{ id: 'x', tolerance: -1 }]), []);
  const topic = clashTopic(records[0], (ref) => `${ref.key} (${ref.model})`);
  assert.equal(topic.title, 'a (s.ifc) × b (r.ifc)');
  assert.deepEqual(topic.components, ['a', 'b']);
  assert.equal(topic.status, 'active');
});

test('curved surfaces: two spheres overlapping by 10 cm clash about 10 cm deep, though they meet along a flat circle', async () => {
  const seg = 24, positions: number[] = [], indices: number[] = [];
  for (let i = 0; i <= seg; i++) for (let j = 0; j <= seg; j++) {
    const t = (i / seg) * Math.PI, p = (j / seg) * 2 * Math.PI;
    positions.push(0.5 * Math.sin(t) * Math.cos(p), 0.5 * Math.cos(t), 0.5 * Math.sin(t) * Math.sin(p));
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < seg; j++) {
    const a = i * (seg + 1) + j, b = a + seg + 1;
    indices.push(a, b, a + 1, b, b + 1, a + 1);
  }
  const model = await buildFromNodes([cube('a', 0), cube('b', 0.9)], [0, 1], { positions: new Float32Array(positions), indices: new Uint32Array(indices) });
  const [clash] = run(clashJob(model, [0], [1], { tolerance: 0.01 })).clashes;
  assert.ok(clash && Math.abs(clash.depth - 0.1) < 0.02, `depth ${clash?.depth}`);
});
