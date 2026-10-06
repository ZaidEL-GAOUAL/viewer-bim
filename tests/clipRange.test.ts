import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import { clipRange } from '../src/engine/clipRange.ts';

/** Profondeur (le long de l'axe de vue) du point de la sphère le plus proche et du plus lointain. */
function depthSpan(camera: Vector3, direction: Vector3, center: Vector3, radius: number): [number, number] {
  const depth = center.clone().sub(camera).dot(direction);
  return [depth - radius, depth + radius];
}

test('maquette au centre de l’écran : le plan proche serre la sphère sans la couper', () => {
  const camera = new Vector3(0, 0, 100);
  const direction = new Vector3(0, 0, -1);
  const center = new Vector3(0, 0, 0);
  const { near, far } = clipRange(camera, direction, center, 20, 100);
  const [nearest, farthest] = depthSpan(camera, direction, center, 20);
  assert.ok(near <= nearest && near > nearest * 0.9, `near ${near}`);
  assert.ok(far >= farthest);
});

test('maquette poussée dans un coin de l’écran : rien n’est coupé par le plan proche', () => {
  // Centre à 45° de l'axe de vue : profondeur 70,7 alors que la distance en ligne droite vaut 100.
  const camera = new Vector3(0, 0, 0);
  const direction = new Vector3(0, 0, -1);
  const center = new Vector3(70.71, 0, -70.71);
  const radius = 40;
  const { near, far } = clipRange(camera, direction, center, radius, 80);
  const [nearest, farthest] = depthSpan(camera, direction, center, radius);
  assert.ok(near <= nearest, `le plan proche (${near.toFixed(2)}) coupe la maquette dont le point le plus proche est à ${nearest.toFixed(2)}`);
  assert.ok(far >= farthest);
  assert.ok(near > 0 && far > near);
});

test('caméra dans la maquette ou maquette derrière : plan proche minimal, lointain au-delà de la sphère', () => {
  const camera = new Vector3(0, 0, 0);
  const direction = new Vector3(0, 0, -1);
  const inside = clipRange(camera, direction, new Vector3(0, 0, -5), 50, 2);
  assert.ok(inside.near > 0 && inside.near <= 2 * 0.05 + 1e-9);
  assert.ok(inside.far >= 55);
  const behind = clipRange(camera, direction, new Vector3(0, 0, 30), 10, 30);
  assert.ok(behind.near > 0 && behind.far > behind.near);
});
