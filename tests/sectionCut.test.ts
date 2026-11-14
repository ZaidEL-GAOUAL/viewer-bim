import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Plane, Vector3 } from 'three';
import { assembleCut, chainLoops, cutJob, cutPlane, cutSegments, emptyPlaneCut, fillTriangles, planeBasis } from '../src/engine/sectionCut.ts';
import { CUBE, buildFromNodes } from './helpers.ts';

const close = (actual: number, expected: number, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

/** Aire signée d'une boucle 2D (x, y, x, y…). */
function area(points: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 2) {
    const j = (i + 2) % points.length;
    sum += points[i] * points[j + 1] - points[j] * points[i + 1];
  }
  return sum / 2;
}

const horizontal = (height: number) => new Plane(new Vector3(0, 1, 0), -height);

test('a cube cut at mid-height gives one closed square of the right size', async () => {
  const model = await buildFromNodes([{ mesh: 0, extras: { id: 'cube' } }], [0], CUBE);
  const cuts = cutSegments(model, horizontal(model.box.min.y + 0.5));
  assert.equal(cuts.length, 1);
  assert.equal(cuts[0].element, 0);
  assert.equal(cuts[0].points.length / 4, 8, 'two triangles per side face');
  const loops = chainLoops(cuts[0].points, 1e-5);
  assert.equal(loops.length, 1);
  assert.equal(loops[0].closed, true);
  assert.equal(loops[0].points.length / 2, 4, 'points along a straight side are dropped');
  close(Math.abs(area(loops[0].points)), 1);
  // The 2D points map back onto the plane, inside the cube.
  const { origin, u, v } = planeBasis(horizontal(model.box.min.y + 0.5));
  const corner = origin.clone().addScaledVector(u, loops[0].points[0]).addScaledVector(v, loops[0].points[1]);
  close(corner.y, model.box.min.y + 0.5);
  assert.ok(model.box.containsPoint(corner));
  // Filled: two triangles covering the square.
  const triangles = fillTriangles(loops);
  assert.equal(triangles.length, 2 * 3 * 2);
});

test('a cube cut along a face gives nothing, at its bottom face as at its top face', async () => {
  const model = await buildFromNodes([{ mesh: 0, extras: { id: 'cube' } }], [0], CUBE);
  assert.deepEqual(cutSegments(model, horizontal(model.box.min.y)), []);
  assert.deepEqual(cutSegments(model, horizontal(model.box.max.y)), []);
  // A plane that misses the cube gives nothing either.
  assert.deepEqual(cutSegments(model, horizontal(model.box.max.y + 1)), []);
});

test('an open mesh gives open polylines', async () => {
  // The cube without its two side faces at x = 0 and x = 1: cut at mid-height, two separate lines remain.
  const open = { positions: CUBE.positions, indices: new Uint32Array([...CUBE.indices!].slice(0, 24)) };
  const model = await buildFromNodes([{ mesh: 0, extras: { id: 'open' } }], [0], open);
  const [cut] = cutSegments(model, horizontal(model.box.min.y + 0.5));
  const loops = chainLoops(cut.points, 1e-5);
  assert.equal(loops.length, 2);
  assert.ok(loops.every((loop) => !loop.closed && loop.points.length === 4), 'two straight open lines, endpoints only');
  assert.equal(fillTriangles(loops).length, 0, 'an open line is not filled');
});

test('two elements stay separate, and hidden elements are left out', async () => {
  const model = await buildFromNodes([
    { mesh: 0, extras: { id: 'a' } },
    { mesh: 0, translation: [3, 0, 0], extras: { id: 'b' } },
  ], [0, 1], CUBE);
  const plane = horizontal(model.box.min.y + 0.25);
  const cuts = cutSegments(model, plane);
  assert.deepEqual(cuts.map((cut) => cut.element), [0, 1]);
  for (const cut of cuts) assert.equal(chainLoops(cut.points, 1e-5).length, 1);
  model.state.setVisible(1, false);
  assert.deepEqual(cutSegments(model, plane).map((cut) => cut.element), [0]);
  // All elements, visible or not, when the caller asks for them (the viewer caches the cut).
  assert.deepEqual(cutSegments(model, plane, { filter: () => true }).map((cut) => cut.element), [0, 1]);
});

test('the whole job runs in bounded slices on thousands of boxes, and stops when cancelled', async () => {
  // 3 000 unit cubes on a grid, all crossed by one horizontal plane: 12 triangles and 8 cut segments each.
  const nodes = Array.from({ length: 3000 }, (_, i) => ({ mesh: 0, translation: [(i % 60) * 2, 0, Math.floor(i / 60) * 2], extras: { id: `b${i}` } }));
  const model = await buildFromNodes(nodes, nodes.map((_, i) => i), CUBE);
  const plane = horizontal(model.box.min.y + 0.5);
  const budget = 240;
  /** Runs a job to its end, counting how much `count()` grows between two pauses. */
  const slices = <T>(job: Generator<number, T>, count: () => number) => {
    let previous = count(), most = 0, pauses = 0, last = -1;
    for (let next = job.next(); ; next = job.next()) {
      most = Math.max(most, count() - previous);
      previous = count();
      if (next.done) return { most, pauses, value: next.value };
      assert.ok(next.value >= last && next.value <= 1, 'progress goes forward, from 0 to 1');
      last = next.value;
      pauses++;
    }
  };

  // Cutting: the box pass and the triangles pause every `budget` units, so a slice finishes at most budget / 12 + 1 cubes.
  const segments: { element: number; points: Float32Array }[] = [];
  const cutting = slices(cutJob(model, plane, { budget }, segments), () => segments.length);
  assert.equal(segments.length, 3000);
  assert.ok(cutting.pauses >= (3000 + 3000 * 12) / budget - 1, `${cutting.pauses} pauses`);
  assert.ok(cutting.most <= Math.ceil(budget / 12) + 1, `${cutting.most} cubes in one slice`);

  // Cutting then chaining and filling: at most budget / 9 + 1 cubes shaped in a slice (1 unit + 8 segments each).
  const cut = emptyPlaneCut();
  const shaping = slices(cutPlane(model, plane, cut, { budget }), () => cut.elements.length);
  assert.equal(cut.elements.length, 3000);
  assert.ok(shaping.most <= Math.ceil(budget / 9) + 1, `${shaping.most} cubes shaped in one slice`);
  assert.ok(cut.fills.every((fill) => fill.length === 2 * 3 * 3), 'each cube section is filled with two triangles');

  // Assembling the drawing: at most `budget` elements looked at, and coloured, in a slice; arrays allocated once.
  let looked = 0, coloured = 0;
  const counting = slices(assembleCut(cut, () => (looked++, true), () => true, () => (coloured++, [1, 0, 0]), budget), () => looked + coloured);
  assert.ok(counting.most <= budget, `${counting.most} elements in one slice`);
  const drawing = counting.value;
  assert.equal(drawing.solid.length, 3000 * 4 * 6, 'four sides per square, two 3D points per side');
  assert.equal(drawing.fill.length, 3000 * 18);
  assert.deepEqual([...drawing.colors.subarray(0, 3)], [1, 0, 0]);

  // Cancelling between two slices stops everything: nothing more is computed.
  const partial = emptyPlaneCut();
  const job = cutPlane(model, plane, partial, { budget });
  for (let i = 0; i < 200; i++) job.next();
  const before = partial.elements.length;
  job.return();
  assert.equal(job.next().done, true);
  assert.equal(partial.elements.length, before);
  assert.ok(before < 3000);
});

test('chainLoops joins segments given in any order and direction, within the tolerance', () => {
  // A unit square as four reversed, shuffled segments, with a 1e-7 gap.
  const segments = new Float32Array([1, 0, 1, 1, 0, 0, 1, 0.0000001, 0, 1, 0, 0, 1, 1, 0, 1]);
  const [loop] = chainLoops(segments, 1e-5);
  assert.equal(loop.closed, true);
  close(Math.abs(area(loop.points)), 1);
  // A square with a square hole: the hole is not filled.
  const outer = new Float32Array([0, 0, 4, 0, 4, 0, 4, 4, 4, 4, 0, 4, 0, 4, 0, 0]);
  const inner = new Float32Array([1, 1, 2, 1, 2, 1, 2, 2, 2, 2, 1, 2, 1, 2, 1, 1]);
  const both = new Float32Array([...outer, ...inner]);
  const triangles = fillTriangles(chainLoops(both, 1e-5));
  let filled = 0;
  for (let i = 0; i < triangles.length; i += 6) filled += Math.abs(area(triangles.subarray(i, i + 6)));
  close(filled, 16 - 1);
});
