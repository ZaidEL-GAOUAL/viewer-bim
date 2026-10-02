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
