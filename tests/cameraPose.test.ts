import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import { cameraUp, clonePose, easeInOut, interpolatePose, samePose, type PoseState } from '../src/engine/cameraPose.ts';

const pose = (x: number, fov = 45, halfHeight = 10): PoseState => ({ position: new Vector3(x, 0, 0), target: new Vector3(x, 0, -10), up: new Vector3(0, 1, 0), fov, halfHeight });
const close = (a: number, b: number, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} ≠ ${b}`);

test('la transition part de la pose de départ et arrive à celle d’arrivée', () => {
  const out = pose(0);
  interpolatePose(pose(0, 45, 10), pose(10, 80, 30), 0, out);
  assert.deepEqual(out.position.toArray(), [0, 0, 0]);
  assert.equal(out.fov, 45);
  interpolatePose(pose(0, 45, 10), pose(10, 80, 30), 1, out);
  assert.deepEqual(out.position.toArray(), [10, 0, 0]);
  assert.deepEqual(out.target.toArray(), [10, 0, -10]);
  assert.equal(out.fov, 80);
  assert.equal(out.halfHeight, 30);
  interpolatePose(pose(0, 45, 10), pose(10, 80, 30), 0.5, out);
  close(out.position.x, 5);
  close(out.fov, 62.5);
  close(out.halfHeight, 20);
});

test('le haut reste unitaire en route, même quand il se retourne', () => {
  const a = pose(0), b = pose(0);
  b.up.set(0, -1, 0);
  const out = pose(0);
  interpolatePose(a, b, 0.5, out);
  close(out.up.length(), 1);
  b.up.set(1, 0, 0);
  interpolatePose(a, b, 0.5, out);
  close(out.up.x, out.up.y);
  close(out.up.length(), 1);
});

test('l’adoucissement est lent aux extrémités, rapide au milieu, borné', () => {
  assert.equal(easeInOut(0), 0);
  assert.equal(easeInOut(1), 1);
  assert.equal(easeInOut(0.5), 0.5);
  assert.ok(easeInOut(0.1) < 0.1 && easeInOut(0.9) > 0.9);
  assert.equal(easeInOut(-3), 0);
  assert.equal(easeInOut(7), 1);
});

test('deux poses identiques n’ont rien à animer, une copie est indépendante', () => {
  const a = pose(3);
  const b = clonePose(a);
  assert.equal(samePose(a, b, 20), true);
  b.position.x += 1;
  assert.equal(a.position.x, 3);
  assert.equal(samePose(a, b, 20), false);
  assert.equal(samePose(a, { ...clonePose(a), fov: 46 }, 20), false);
});

test('le haut d’une vue sans roulis est la verticale ; celui d’une vue de dessus ou penchée est gardé', () => {
  const direction = new Vector3(0.3, -0.5, -0.8).normalize();
  // Le haut de Revit : la verticale projetée perpendiculairement au regard.
  const rollFree = new Vector3(0, 1, 0).addScaledVector(direction, -direction.y).normalize();
  assert.deepEqual(cameraUp(rollFree, direction).toArray(), [0, 1, 0]);
  // Une caméra penchée de 20° garde son haut.
  const tilted = rollFree.clone().applyAxisAngle(direction, (20 * Math.PI) / 180);
  assert.deepEqual(cameraUp(tilted, direction).toArray(), tilted.toArray());
  // Vue de dessus : le haut enregistré (le nord de la maquette) est gardé.
  const down = new Vector3(0, -1, 0);
  assert.deepEqual(cameraUp(new Vector3(0, 0, -1), down).toArray(), [0, 0, -1]);
});
