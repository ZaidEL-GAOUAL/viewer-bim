import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import { lockAxis, nearest, planePoint } from '../src/engine/sketch.ts';

test('a ray meets the work plane in front of it only', () => {
  assert.deepEqual(planePoint(new Vector3(1, 10, 2), new Vector3(0, -1, 0), 3)?.toArray(), [1, 3, 2]);
  assert.equal(planePoint(new Vector3(0, 10, 0), new Vector3(0, 1, 0), 3), null, 'behind the eye');
  assert.equal(planePoint(new Vector3(0, 10, 0), new Vector3(1, 0, 0), 3), null, 'parallel to the plane');
});

test('Shift keeps a line parallel to X or Z; snapping takes the nearest point within reach', () => {
  const from = new Vector3(0, 1, 0);
  assert.deepEqual(lockAxis(from, new Vector3(5, 1, 1)).toArray(), [5, 1, 0]);
  assert.deepEqual(lockAxis(from, new Vector3(1, 1, -5)).toArray(), [0, 1, -5]);
  const a = new Vector3(1, 0, 0), b = new Vector3(2, 0, 0);
  assert.equal(nearest({ x: 100, y: 100 }, [{ x: 108, y: 100, point: a }, { x: 104, y: 103, point: b }]), b);
  assert.equal(nearest({ x: 100, y: 100 }, [{ x: 130, y: 100, point: a }]), null);
});
