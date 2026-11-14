import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planeToModel, planeToViewer, toModelPoint, toViewerPoint, yUpToZUp, zUpToYUp, type Vec3 } from '../src/data/modelFrame.ts';

const OFFSET: Vec3 = [651200, 35, -6861500];

test('a point goes from the viewer frame to the model frame and back', () => {
  const viewer: Vec3 = [1.5, 2, -3];
  const model = toModelPoint(viewer, OFFSET);
  assert.deepEqual(model, [651201.5, 37, -6861503]);
  assert.deepEqual(toViewerPoint(model, OFFSET), viewer);
});

test('a plane keeps its normal; its constant follows the offset, and the same points stay on it', () => {
  const normal: Vec3 = [0, 1, 0];
  // y = 2 in the viewer frame: 0·x + 1·y − 2 = 0.
  const constant = planeToModel(normal, -2, OFFSET);
  assert.equal(constant, -37, 'y = 37 in the model frame');
  assert.equal(planeToViewer(normal, constant, OFFSET), -2);
  const oblique: Vec3 = [Math.SQRT1_2, 0, Math.SQRT1_2];
  const point: Vec3 = [3, 0, 1];
  const c = -(oblique[0] * point[0] + oblique[2] * point[2]);
  const m = toModelPoint(point, OFFSET);
  const cm = planeToModel(oblique, c, OFFSET);
  assert.ok(Math.abs(oblique[0] * m[0] + oblique[1] * m[1] + oblique[2] * m[2] + cm) < 1e-6);
});

test('Y up (GLB) and Z up (IFC, Revit) are the same right-handed frame turned a quarter', () => {
  // IFC (x, y, z) becomes glTF (x, z, −y): the project's north (+Y) points to −Z in the viewer.
  assert.deepEqual(zUpToYUp([1, 2, 3]), [1, 3, -2]);
  assert.deepEqual(yUpToZUp([1, 3, -2]), [1, 2, 3]);
  assert.deepEqual(yUpToZUp(zUpToYUp([-4, 0.5, 9])), [-4, 0.5, 9]);
});
