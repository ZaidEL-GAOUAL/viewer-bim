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

// --------------------------------------------------------------------------------------------- boîte de coupe d'une vue

test('une boîte de coupe ne garde que son intérieur, et s’ajoute aux trois plans', () => {
  const sections = new Sections();
  sections.setBounds(new Box3(new Vector3(-10, 0, -5), new Vector3(10, 9, 5)));
  assert.equal(sections.clipPlanes.length, 3, 'sans boîte, les trois plans seulement');
  sections.setBox({ min: [-4, 1, -2], max: [6, 5, 3], rotation: 0 });
  assert.equal(sections.active, true);
  assert.equal(sections.boxEnabled, true);
  assert.equal(sections.clipPlanes.length, 9);
  // Dedans, sur chaque face et dehors : rien ne coupe l'intérieur, tout ce qui sort d'une face est retiré.
  assert.equal(sections.isClipped(1, 3, 0), false);
  assert.equal(sections.isClipped(-3.9, 1.1, -1.9), false);
  assert.equal(sections.isClipped(6.1, 3, 0), true);
  assert.equal(sections.isClipped(-4.1, 3, 0), true);
  assert.equal(sections.isClipped(0, 5.1, 0), true);
  assert.equal(sections.isClipped(0, 0.9, 0), true);
  assert.equal(sections.isClipped(0, 3, 3.1), true);
  assert.equal(sections.isClipped(0, 3, -2.1), true);
  // Les plans de la boîte : normales vers l'intérieur, la distance de son centre vaut le demi-côté.
  for (const plane of sections.boxPlanes) assert.ok(plane.distanceToPoint(new Vector3(1, 3, 0.5)) > 0);
  // Un plan libre coupe par-dessus la boîte.
  sections.set(1, { enabled: true, position: 4 });
  assert.equal(sections.isClipped(0, 4.5, 0), true);
  assert.equal(sections.isClipped(0, 3.5, 0), false);
  // Quels plans de `clipPlanes` coupent : les trois libres selon leur état, les six de la boîte.
  assert.deepEqual([0, 1, 2, 3, 8].map((index) => sections.planeEnabled(index)), [false, true, false, true, true]);
});

test('la boîte désactivée ne coupe plus, retirée elle disparaît, et un nouveau modèle la retire', () => {
  const sections = new Sections();
  sections.setBounds(new Box3(new Vector3(-10, 0, -5), new Vector3(10, 9, 5)));
  sections.setBox({ min: [-1, 0, -1], max: [1, 2, 1], rotation: 0 });
  assert.equal(sections.isClipped(5, 1, 0), true);
  sections.setBoxEnabled(false);
  assert.equal(sections.active, false);
  assert.equal(sections.isClipped(5, 1, 0), false);
  assert.equal(sections.clipPlanes.length, 3);
  assert.notEqual(sections.boxCut, null, 'désactivée, elle reste posée : on peut la réactiver');
  sections.setBoxEnabled(true);
  assert.equal(sections.isClipped(5, 1, 0), true);
  sections.setBox(null);
  assert.equal(sections.boxCut, null);
  assert.equal(sections.active, false);
  sections.setBoxEnabled(true);
  assert.equal(sections.boxEnabled, false, 'sans boîte posée, il n’y a rien à activer');
  sections.setBox({ min: [-1, 0, -1], max: [1, 2, 1], rotation: 0 });
  sections.setBounds(new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)));
  assert.equal(sections.boxCut, null);
  assert.equal(sections.active, false);
});

test('une boîte tournée autour de la verticale coupe selon ses propres axes', () => {
  const sections = new Sections();
  sections.setBounds(new Box3(new Vector3(-10, 0, -10), new Vector3(10, 9, 10)));
  // 4 × 2 en plan autour de (0, 0, 0), tournée de 90° : l'axe long passe de X à −Z.
  sections.setBox({ min: [-2, 0, -1], max: [2, 3, 1], rotation: 90 });
  assert.equal(sections.isClipped(1.5, 1, 0), true, 'le long côté suit maintenant Z');
  assert.equal(sections.isClipped(0, 1, 1.5), false);
  assert.equal(sections.isClipped(0, 1, -1.9), false);
  assert.equal(sections.isClipped(0, 1, -2.1), true);
  assert.equal(sections.isClipped(0.9, 1, 0), false);
  assert.equal(sections.isClipped(1.1, 1, 0), true);
  // 30° : un coin de la boîte non tournée sort, le point (2, y, 0) reste dedans sur l'axe long tourné.
  sections.setBox({ min: [-2, 0, -1], max: [2, 3, 1], rotation: 30 });
  const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
  // Le long de l'axe local x = (cos, 0, −sin) : 1,9 dedans, 2,1 dehors.
  assert.equal(sections.isClipped(1.9 * c, 1, -1.9 * s), false);
  assert.equal(sections.isClipped(2.1 * c, 1, -2.1 * s), true);
  // Le long de l'axe local z = (sin, 0, cos) : 0,9 dedans, 1,1 dehors.
  assert.equal(sections.isClipped(0.9 * s, 1, 0.9 * c), false);
  assert.equal(sections.isClipped(1.1 * s, 1, 1.1 * c), true);
});

test('une boîte non finie ou aux coins inversés est refusée', () => {
  const sections = new Sections();
  assert.throws(() => sections.setBox({ min: [0, 0, 0], max: [Number.NaN, 1, 1], rotation: 0 }), /invalide/);
  assert.throws(() => sections.setBox({ min: [2, 0, 0], max: [1, 1, 1], rotation: 0 }), /invalide/);
  assert.throws(() => sections.setBox({ min: [0, 0, 0], max: [1, 1, 1], rotation: Number.POSITIVE_INFINITY }), /invalide/);
  assert.equal(sections.boxCut, null);
});

test('un modèle qui grandit élargit les bornes sans déranger un plan réglé ; un plan au repos reste au milieu', () => {
  const sections = new Sections();
  sections.setBounds(new Box3(new Vector3(-10, 0, -5), new Vector3(10, 9, 5)));
  sections.set(1, { enabled: true, position: 3 });
  sections.setTransform(0, new Vector3(2, 0, 0), new Vector3(1, 1, 0).normalize());
  const before = sections.planes[1].clone();
  const normalBefore = sections.normals[0].clone();
  sections.growBounds(new Box3(new Vector3(-10, 0, -5), new Vector3(30, 9, 5)));
  // Le plan actif n'a pas bougé ; ses bornes, elles, suivent le modèle.
  assert.deepEqual(sections.planes[1].normal.toArray(), before.normal.toArray());
  assert.equal(sections.planes[1].constant, before.constant);
  assert.equal(sections.position[1], 3);
  assert.deepEqual([sections.min[1], sections.max[1]], [0, 9]);
  assert.deepEqual(sections.normals[0].toArray(), normalBefore.toArray(), 'une orientation posée reste');
  // Le plan au repos (Z) est recentré sur le nouveau modèle, le plan X incliné aussi, sur sa normale.
  assert.equal(sections.position[2], 0);
  assert.deepEqual([sections.min[2], sections.max[2]], [-5, 5]);
  assert.deepEqual(sections.origin(2, new Vector3()).toArray(), [10, 4.5, 0]);
  assert.equal(sections.enabled[1], true);
  assert.equal(sections.enabled[0], false);
  assert.equal(sections.isClipped(0, 3.5, 0), true, 'le plan actif coupe toujours');
});
