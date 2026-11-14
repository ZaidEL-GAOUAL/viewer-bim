import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Plane, Vector3 } from 'three';
import { cadFrame, cutPaths, facingPlanes } from '../src/engine/cutPaths.ts';
import { Sections } from '../src/engine/Sections.ts';
import { CUBE, buildFromNodes } from './helpers.ts';

function run<T>(job: Generator<number, T, unknown>): T {
  let next = job.next();
  while (!next.done) next = job.next();
  return next.value;
}

test('a cube cut at mid-height gives one closed solid path with four corners', async () => {
  const model = await buildFromNodes([{ mesh: 0, extras: { id: 'cube' } }], [0], CUBE);
  const paths = run(cutPaths(model, new Plane(new Vector3(0, 1, 0), -(model.box.min.y + 0.5))));
  assert.equal(paths.length, 1);
  assert.equal(paths[0].element, 0);
  assert.equal(paths[0].closed, true);
  assert.equal(paths[0].solid, true);
  assert.equal(paths[0].points.length / 2, 4);
});

test('only planes facing the camera are printed: the top of a plan box, not its floor', () => {
  const sections = new Sections();
  sections.setBox({ min: [-5, 0, -5], max: [5, 1.2, 5], rotation: 0 });
  const down = new Vector3(0, -1, 0);
  const facing = facingPlanes(sections, down);
  assert.equal(facing.length, 1);
  assert.equal(facing[0].normal.y, -1);
  assert.equal(facingPlanes(sections, new Vector3(1, 0, 1).normalize()).length, 0);
});

test('a horizontal cut lands in CAD XY at real size, at its altitude, in the original model coordinates', () => {
  const frame = cadFrame(new Plane(new Vector3(0, 1, 0), -2), new Vector3(100, 10, -50));
  assert.equal(frame.horizontal, true);
  // 2D (3, 4) is the viewer point (4, 2, 3); the model point is (104, 12, −47); in CAD axes (104, 47, 12).
  assert.deepEqual(frame.toCad(3, 4), [104, 47, 12]);
});

test('a vertical cut is laid flat with its own frame: x to the right of the view, y the real altitude', () => {
  const frame = cadFrame(new Plane(new Vector3(0, 0, 1), -1), new Vector3(100, 10, -50));
  assert.equal(frame.horizontal, false);
  // 2D (2, 3) is the viewer point (2, 3, 1); the model point is (102, 13, −49). The camera looks along +Z: its right is −X.
  assert.deepEqual(frame.toCad(2, 3), [-102, 13, 0]);
});
