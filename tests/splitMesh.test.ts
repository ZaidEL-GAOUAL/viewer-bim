import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isClosed } from '../src/engine/meshMath.ts';
import { TOO_MANY_PARTS, solidFromParts, splitSolid, verticalPlane, type CutPlane, type Solid } from '../src/engine/splitMesh.ts';

const close = (actual: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

/** Une boîte de min à max, 12 triangles orientés vers l'extérieur, sommets non partagés (comme un glTF sans normales). */
export function box(min: number[], max: number[]): Solid {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  const positions = faces.flatMap((v) => c[v]);
  return solidFromParts([{ positions, index: faces.map((_, i) => i), start: 0, count: faces.length }]);
}

const xPlane = (x: number): CutPlane => ({ normal: [1, 0, 0], constant: -x });
const closed = (solid: Solid) => isClosed([{ positions: solid.positions, index: solid.triangles, start: 0, count: solid.triangles.length }]);

test('a 4 × 2 × 1 box cut at x = 1 gives two closed parts of 2 and 6 m³', () => {
  const { parts, error } = splitSolid(box([0, 0, 0], [4, 1, 2]), [xPlane(1)]);
  assert.equal(error, undefined);
  assert.equal(parts.length, 2);
  close(parts[0].volume, 2);
  close(parts[1].volume, 6);
  close(parts[0].volume + parts[1].volume, 8);
  for (const part of parts) {
    assert.equal(part.valid, true);
    assert.equal(closed(part.solid), true, 'capped on both sides');
  }
});

test('a cut that misses or only touches gives no part', () => {
  const solid = box([0, 0, 0], [4, 1, 2]);
  assert.deepEqual(splitSolid(solid, [xPlane(9)]).parts, []);
  assert.deepEqual(splitSolid(solid, [xPlane(4)]).parts, [], 'touching the end face is not a cut');
  assert.deepEqual(splitSolid(solid, [xPlane(0)]).parts, []);
});

test('an open mesh is refused, with the reason', () => {
  const solid = box([0, 0, 0], [4, 1, 2]);
  const open: Solid = { ...solid, triangles: solid.triangles.slice(6), materials: solid.materials.slice(2) };
  const { parts, error } = splitSolid(open, [xPlane(1)]);
  assert.deepEqual(parts, []);
  assert.match(error ?? '', /ouvert/);
});

test('a line that does not cross the element completely is refused', () => {
  const solid = box([0, 0, 0], [4, 1, 2]);
  // Vertical plane x = 1, drawn from z = 0.5 to z = 3: it starts inside the box.
  const { error } = splitSolid(solid, [verticalPlane([1, 0.5], [1, 3])]);
  assert.match(error ?? '', /partielle/);
  // From z = −1 to z = 3: crosses completely.
  assert.equal(splitSolid(solid, [verticalPlane([1, -1], [1, 3])]).parts.length, 2);
});

test('a two-line sketch gives three or four parts, numbered the same whatever the order of the lines', () => {
  const slab = box([0, 0, 0], [4, 0.2, 2]);
  const across = verticalPlane([1, -1], [1, 3]);
  const along = verticalPlane([-1, 1], [5, 1]);
  const parallel = verticalPlane([3, 3], [3, -1]);
  const crossing = splitSolid(slab, [across, along]);
  assert.equal(crossing.parts.length, 4);
  const reversed = splitSolid(slab, [along, across]);
  assert.deepEqual(reversed.parts.map((part) => part.volume.toFixed(9)), crossing.parts.map((part) => part.volume.toFixed(9)));
  // South (z large) to north, then west to east: the south-west quarter first.
  close(crossing.parts[0].volume, 1 * 1 * 0.2);
  close(crossing.parts[1].volume, 3 * 1 * 0.2);
  assert.ok(crossing.parts.every((part) => part.valid));
  const three = splitSolid(slab, [across, parallel]);
  assert.equal(three.parts.length, 3);
  assert.deepEqual(three.parts.map((part) => +part.volume.toFixed(6)), [0.4, 0.8, 0.4]);
  const total = three.parts.reduce((sum, part) => sum + part.volume, 0);
  close(total, 4 * 2 * 0.2);
});

test('cutting stops as soon as the parts pass maxParts', () => {
  const planes = [1, 2, 3].map(xPlane);
  assert.deepEqual(splitSolid(box([0, 0, 0], [4, 1, 2]), planes, 3), { parts: [], error: TOO_MANY_PARTS });
  assert.equal(splitSolid(box([0, 0, 0], [4, 1, 2]), planes, 4).parts.length, 4);
});
