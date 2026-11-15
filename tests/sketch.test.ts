import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Box3, PerspectiveCamera, Vector3 } from 'three';
import { Sketch, extendAcross, lockAxis, planePoint, resolvePoint, sharpEdges, type SketchHost, type SnapCandidate } from '../src/engine/sketch.ts';
import { CUBE } from './helpers.ts';

test('a ray meets the work plane in front of it only', () => {
  assert.deepEqual(planePoint(new Vector3(1, 10, 2), new Vector3(0, -1, 0), 3)?.toArray(), [1, 3, 2]);
  assert.equal(planePoint(new Vector3(0, 10, 0), new Vector3(0, 1, 0), 3), null, 'behind the eye');
  assert.equal(planePoint(new Vector3(0, 10, 0), new Vector3(1, 0, 0), 3), null, 'parallel to the plane');
});

test('Shift keeps a line parallel to X or Z', () => {
  const from = new Vector3(0, 1, 0);
  assert.deepEqual(lockAxis(from, new Vector3(5, 1, 1)).toArray(), [5, 1, 0]);
  assert.deepEqual(lockAxis(from, new Vector3(1, 1, -5)).toArray(), [0, 1, -5]);
});

test('snapping takes the strongest catch within reach and says what it caught; off, the raw point is kept; Shift constrains', () => {
  const raw = new Vector3(1.02, 0, 0.03);
  const candidates: SnapCandidate[] = [
    { point: new Vector3(1, 0, 0.03), kind: 'arête' },
    { point: new Vector3(1, 0, 0), kind: 'sommet' },
    { point: new Vector3(5, 0, 5), kind: 'point' },
  ];
  const on = resolvePoint(raw, candidates, { snap: true, tolerance: 0.1 });
  assert.deepEqual([on.point.toArray(), on.label], [[1, 0, 0], 'sommet'], 'a vertex beats a nearer edge; a point out of reach is ignored');
  const off = resolvePoint(raw, candidates, { snap: false, tolerance: 0.1 });
  assert.deepEqual([off.point.toArray(), off.label], [raw.toArray(), ''], 'snapping off returns the raw point');
  assert.notEqual(off.point, raw, 'a copy, not the caller’s vector');
  const locked = resolvePoint(new Vector3(4, 0, 0.4), [], { snap: true, tolerance: 0.1, from: new Vector3(0, 0, 0), lock: true });
  assert.deepEqual([locked.point.toArray(), locked.label], [[4, 0, 0], 'horizontal']);
  assert.equal(resolvePoint(new Vector3(0.4, 0, -4), [], { snap: true, tolerance: 0.1, from: new Vector3(0, 0, 0), lock: true }).label, 'vertical');
});

test('a straight cut is extended across the box, never shortened; a line outside it is left as drawn', () => {
  const box = new Box3(new Vector3(0, 0, 0), new Vector3(10, 1, 4));
  const [a, b] = extendAcross(new Vector3(5, 1, 1.8), new Vector3(5, 1, 2.2), box);
  assert.ok(a.z < 0 && b.z > 4, 'crosses the whole box along Z');
  assert.deepEqual([a.x, b.x, a.y], [5, 5, 1]);
  const [c, d] = extendAcross(new Vector3(4, 0, 2), new Vector3(6, 0, 2), box);
  assert.ok(c.x < 0 && d.x > 10 && c.z === 2 && d.z === 2);
  const far = extendAcross(new Vector3(-50, 0, 2), new Vector3(60, 0, 2), box);
  assert.deepEqual(far.map((p) => p.x), [-50, 60], 'longer than the box: kept');
  const outside = extendAcross(new Vector3(20, 0, 0), new Vector3(20, 0, 1), box);
  assert.deepEqual(outside.map((p) => p.toArray()), [[20, 0, 0], [20, 0, 1]]);
});

test('the sharp edges of a box are its 12 edges, not the diagonals of its faces', () => {
  const index = CUBE.indices!;
  const edges = sharpEdges([{ positions: CUBE.positions, index, start: 0, count: index.length }]);
  assert.equal(edges.length / 4, 12);
  for (let e = 0; e < edges.length; e += 4) {
    const dx = Math.abs(edges[e + 2] - edges[e]), dz = Math.abs(edges[e + 3] - edges[e + 1]);
    assert.ok(!(dx > 0 && dz > 0), 'seen from above, an edge is a point or runs along X or Z');
  }
});

/** Juste assez de DOM pour construire l'esquisse : Node n'en a pas. */
class FakeElement {
  readonly classList = { add: () => {} };
  append(): void {}
  addEventListener(): void {}
  setAttribute(): void {}
  replaceChildren(): void {}
}

test('Backspace removes the last cut, then the one before; Escape drops the point being placed', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { createElementNS: () => new FakeElement() }, configurable: true, writable: true });
  try {
    const host = {
      renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } },
      camera: new PerspectiveCamera(), afterRender: new Set<() => void>(), toScreen: () => false, pick: () => null, model: null,
    } as unknown as SketchHost;
    const element = new FakeElement() as unknown as HTMLElement;
    const sketch = new Sketch(host, element, element);
    let changes = 0;
    sketch.onChange = () => changes++;
    sketch.start('lines', 0);
    sketch.lines.push([new Vector3(0, 0, 0), new Vector3(1, 0, 0)], [new Vector3(0, 0, 1), new Vector3(1, 0, 1)]);
    assert.equal(sketch.key('Backspace'), true);
    assert.deepEqual(sketch.lines.map(([a]) => a.z), [0], 'the last cut is gone');
    assert.equal(sketch.key('Backspace'), true);
    assert.equal(sketch.lines.length, 0);
    assert.equal(sketch.key('Backspace'), false, 'nothing left: the key is not used');
    assert.equal(sketch.key('Escape'), false, 'no point being placed: Escape goes to the application');
    assert.equal(changes, 2);
    sketch.stop();
    assert.equal(sketch.key('Backspace'), false, 'stopped: keys are not used');
  } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved); else delete (globalThis as { document?: unknown }).document;
  }
});
