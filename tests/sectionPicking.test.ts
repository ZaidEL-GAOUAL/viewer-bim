import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Box3, PerspectiveCamera, Raycaster, Sphere, Vector2, Vector3 } from 'three';
import { Viewer } from '../src/engine/Viewer.ts';
import { Sections } from '../src/engine/Sections.ts';
import type { Model } from '../src/engine/Model.ts';
import { CUBE, buildFromNodes } from './helpers.ts';

/** Exerce le vrai chemin de clic CPU sans créer de contexte WebGL dans Node. */
function pickingViewer(model: Model, sections: Sections): Viewer {
  const camera = new PerspectiveCamera(45, 1, .01, 100);
  camera.position.set(2, 2, .1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return Object.assign(Object.create(Viewer.prototype) as Viewer, {
    model, sections, camera,
    renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } },
    raycaster: new Raycaster(), pointer: new Vector2(),
    sphere: model.box.getBoundingSphere(new Sphere()), scratch: new Vector3(), scratchBox: new Box3(),
  });
}

test('un clic sur une coupe oblique se place sur le vrai plan avec sa normale pour les mesures', async () => {
  const model = await buildFromNodes([{ mesh: 0, extras: { id: 'cube' } }], [0], CUBE);
  const sections = new Sections();
  sections.setBounds(model.box);
  sections.set(0, { enabled: true });
  const normal = new Vector3(1, 1, 0).normalize();
  sections.setTransform(0, new Vector3(), normal);
  const viewer = pickingViewer(model, sections);
  const hit = viewer.pick(50, 50);
  assert.ok(hit);
  assert.equal(hit.cap, true);
  assert.equal(hit.element, 0);
  assert.ok(Math.abs(sections.planes[0].distanceToPoint(hit.point)) < 1e-7);
  assert.ok(hit.point.length() < 1e-7);
  assert.ok(hit.normal.distanceTo(normal) < 1e-7);
  // Les éléments rendus translucides ne reçoivent pas un bouchon opaque fictif.
  model.state.setOpacity(0, .5);
  assert.equal(viewer.pick(50, 50), null);
  model.state.clearOpacity(0);
  sections.fill = false;
  assert.equal(viewer.pick(50, 50), null);
  model.dispose();
});

test('les intersections de plans choisissent la dernière entrée visible, y compris après rotation', async () => {
  const model = await buildFromNodes([{ mesh: 0 }], [0], CUBE);
  const sections = new Sections();
  sections.setBounds(model.box);
  sections.set(0, { enabled: true });
  sections.setTransform(0, new Vector3(), new Vector3(1, 1, 0));
  sections.set(1, { enabled: true, position: -.2 });
  const viewer = pickingViewer(model, sections);
  const hit = viewer.pick(50, 50);
  assert.ok(hit?.cap);
  assert.ok(Math.abs(hit.point.y + .2) < 1e-7);
  assert.deepEqual(hit.normal.toArray(), [0, 1, 0]);
  assert.ok(sections.planes[0].distanceToPoint(hit.point) > 0);
  model.dispose();
});
