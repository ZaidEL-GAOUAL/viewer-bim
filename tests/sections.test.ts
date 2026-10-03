import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Box3, Vector3 } from 'three';
import { Sections } from '../src/engine/Sections.ts';

test('sans plan actif, rien n’est coupé', () => {
  const sections = new Sections();
  sections.setBounds(new Box3(new Vector3(-10, 0, -5), new Vector3(10, 9, 5)));
  assert.equal(sections.active, false);
  assert.equal(sections.isClipped(0, 100, 0), false);
  assert.deepEqual(sections.position, [0, 4.5, 0]);
});

test('un plan retire ce qui est au-delà de sa position, ou en deçà une fois inversé', () => {
  const sections = new Sections();
  sections.setBounds(new Box3(new Vector3(-10, 0, -5), new Vector3(10, 9, 5)));
  sections.set(1, { enabled: true, position: 3 });
  assert.equal(sections.active, true);
  assert.equal(sections.isClipped(0, 3.5, 0), true);
  assert.equal(sections.isClipped(0, 2.5, 0), false);
  // Format three.js : la partie conservée est du côté de la normale.
  assert.ok(sections.planes[1].distanceToPoint(new Vector3(0, 2, 0)) > 0);

  sections.set(1, { flipped: true });
  assert.equal(sections.isClipped(0, 3.5, 0), false);
  assert.equal(sections.isClipped(0, 2.5, 0), true);
});

test('plusieurs plans se combinent et la position reste dans les bornes du modèle', () => {
  const sections = new Sections();
  sections.setBounds(new Box3(new Vector3(-10, 0, -5), new Vector3(10, 9, 5)));
  sections.set(0, { enabled: true, position: 500 });
  assert.equal(sections.position[0], 10);
  sections.set(0, { position: 2 });
  sections.set(2, { enabled: true, position: 1, flipped: true });
  assert.equal(sections.isClipped(1, 0, 2), false);
  assert.equal(sections.isClipped(3, 0, 2), true);
  assert.equal(sections.isClipped(1, 0, 0), true);
  // Les plans désactivés restent dans la liste, repoussés au loin : ils ne coupent rien.
  assert.ok(sections.planes[1].distanceToPoint(new Vector3(0, 1e6, 0)) > 0);
});

test('une rotation change réellement la coupe, ses bornes et son contour', () => {
  const sections = new Sections();
  sections.setBounds(new Box3(new Vector3(-2, -1, -3), new Vector3(2, 1, 3)));
  sections.set(0, { enabled: true });
  const normal = new Vector3(1, 1, 0).normalize();
  const pivot = new Vector3(.25, .5, 0);
  sections.setTransform(0, pivot, normal);
  assert.ok(Math.abs(sections.planes[0].distanceToPoint(pivot)) < 1e-12);
  assert.equal(sections.isClipped(-.5, 1.5, 0), true); // l'ancien plan X conserverait ce point
  assert.equal(sections.isClipped(1, -1, 0), false); // l'ancien plan X le supprimerait
  assert.ok(Math.abs(sections.min[0] + 3 / Math.sqrt(2)) < 1e-12);
  assert.ok(Math.abs(sections.max[0] - 3 / Math.sqrt(2)) < 1e-12);
  for (const corner of sections.outline(0)) assert.ok(Math.abs(sections.planes[0].distanceToPoint(corner)) < 1e-12);
  assert.ok(Math.abs(sections.planes[0].distanceToPoint(sections.origin(0, new Vector3()))) < 1e-12);
  sections.set(0, { flipped: true });
  assert.equal(sections.isClipped(-.5, 1.5, 0), false);
  assert.equal(sections.isClipped(1, -1, 0), true);
  sections.set(0, { position: -1 });
  assert.ok(Math.abs(sections.planes[0].distanceToPoint(normal.clone().multiplyScalar(-1))) < 1e-12);
  sections.resetOrientation(0);
  assert.deepEqual(sections.normals[0].toArray(), [1, 0, 0]);
  assert.equal(sections.flipped[0], true);
  assert.equal(sections.enabled[0], true);
});

test('le pivot reste fixe pendant des rotations successives, après déplacement et réalignement', () => {
  const sections = new Sections();
  sections.setBounds(new Box3(new Vector3(-10, -4, -6), new Vector3(10, 4, 6)));
  sections.set(0, { enabled: true, position: 4 });
  const pivot = sections.origin(0, new Vector3());
  assert.deepEqual(pivot.toArray(), [4, 0, 0]);
  for (const normal of [new Vector3(1, 1, 0), new Vector3(0, 1, 1), new Vector3(-1, 2, .5)]) {
    sections.setTransform(0, pivot, normal);
    assert.deepEqual(sections.origin(0, new Vector3()).toArray(), pivot.toArray());
    assert.ok(Math.abs(sections.planes[0].distanceToPoint(pivot)) < 1e-12);
  }
  const normal = sections.normals[0].clone();
  sections.set(0, { position: sections.position[0] + .5 });
  const moved = pivot.clone().addScaledVector(normal, .5);
  assert.ok(sections.origin(0, new Vector3()).distanceTo(moved) < 1e-12);
  sections.resetOrientation(0);
  assert.ok(sections.origin(0, new Vector3()).distanceTo(moved) < 1e-12);
  assert.ok(Math.abs(sections.planes[0].distanceToPoint(moved)) < 1e-12);
  // The other planes retain their independent pivot.
  assert.deepEqual(sections.origin(1, new Vector3()).toArray(), [0, 0, 0]);
});
