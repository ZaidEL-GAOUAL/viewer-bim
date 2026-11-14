import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Box3, Group, PerspectiveCamera, Raycaster, Sphere, Vector2, Vector3 } from 'three';
import { Measure, formatArea, formatLength, formatVolume } from '../src/engine/Measure.ts';
import type { Model, PickHit } from '../src/engine/Model.ts';
import { Sections } from '../src/engine/Sections.ts';
import { Viewer } from '../src/engine/Viewer.ts';
import { CUBE, buildFromNodes } from './helpers.ts';

/** Juste assez de DOM pour que `Measure` construise ses étiquettes : Node n'en a pas. */
class FakeElement {
  style: Record<string, string> = {};
  className = '';
  textContent = '';
  title = '';
  type = '';
  offsetWidth = 40;
  offsetHeight = 16;
  readonly attributes = new Map<string, string>();
  readonly classList = { add: () => {}, toggle: () => {} };
  append(): void {}
  remove(): void {}
  addEventListener(): void {}
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
}

function withFakeDocument<T>(run: () => T): T {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: { createElementNS: () => new FakeElement(), createElement: () => new FakeElement() }, configurable: true, writable: true });
  try { return run(); } finally {
    if (saved) Object.defineProperty(globalThis, 'document', saved); else delete (globalThis as { document?: unknown }).document;
  }
}

/** Un vrai `Viewer.pick` (rayon CPU) devant un modèle, regardant vers −Z depuis (1, 1,5, 20) ; le reste du viewer est simulé. */
function viewerOf(model: Model): Viewer {
  const camera = new PerspectiveCamera(30, 1, 0.01, 100);
  camera.position.set(1, 1.5, 20);
  camera.lookAt(1, 1.5, 0);
  camera.updateMatrixWorld(true);
  const viewer = Object.assign(Object.create(Viewer.prototype) as Viewer, {
    model, camera, sections: new Sections(),
    renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } },
    raycaster: new Raycaster(), pointer: new Vector2(),
    sphere: model.box.getBoundingSphere(new Sphere()), scratch: new Vector3(), scratchBox: new Box3(),
    afterRender: { add: () => {} }, invalidate: () => {}, toScreen: () => false, overlay: new Group(),
  });
  Object.defineProperty(viewer, 'size', { value: { width: 100, height: 100 } });
  return viewer;
}

const near = (actual: number, expected: number, tolerance = 1e-4) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

/** Un cube unité étiré en boîte 2 × 3 × 5 m (X, Y, Z). */
const boxModel = () => buildFromNodes([{ name: 'Boîte', mesh: 0, scale: [2, 3, 5], extras: { id: 'box' } }], [0], CUBE);

test('les formats de mesure : unité, virgule décimale, quatre chiffres significatifs sous 1', () => {
  assert.equal(formatLength(2.5), `${(2.5).toLocaleString('fr-FR', { minimumFractionDigits: 2 })} m`);
  assert.equal(formatArea(6), `${(6).toLocaleString('fr-FR', { minimumFractionDigits: 2 })} m²`);
  assert.equal(formatVolume(30), `${(30).toLocaleString('fr-FR', { minimumFractionDigits: 2 })} m³`);
  assert.equal(formatLength(0.005048), '0,005048 m', 'une petite valeur garde ses chiffres significatifs');
  assert.equal(formatLength(0), `${(0).toLocaleString('fr-FR', { minimumFractionDigits: 2 })} m`);
  assert.equal(formatLength(1234.5678), `${(1234.568).toLocaleString('fr-FR')} m`, 'trois décimales au plus');
});

test('distance : deux clics donnent la longueur du segment et ses écarts par axe ; un double-clic n’en crée pas', async () => {
  const model = await boxModel();
  const hits = [[0, 0, 0], [3, 4, 0], [3, 4, 0], [3, 4, 0]].map(([x, y, z]) => ({ element: 0, distance: 1, point: new Vector3(x, y, z), normal: new Vector3(0, 0, 1), chunk: 0, tri: 0, backface: false, cap: false }) as PickHit);
  const viewer = Object.assign(viewerOf(model), { pick: () => hits.shift() ?? null });
  const measure = withFakeDocument(() => new Measure(viewer, new FakeElement() as unknown as HTMLElement));
  withFakeDocument(() => {
    measure.setTool('distance');
    measure.click(10, 10);
    assert.equal(measure.hasPending, true);
    assert.equal(measure.results.length, 0);
    measure.click(20, 20);
    assert.equal(measure.results.length, 1);
    near(measure.results[0].value, 5);
    assert.equal(measure.results[0].text, formatLength(5));
    assert.match(measure.results[0].note, /ΔX 3,00 · ΔY 4,00 · ΔZ 0,00/);
    assert.equal(measure.results[0].approximate, false);
    // Premier clic d'une seconde mesure puis un second clic au même endroit : pas de longueur nulle.
    measure.click(20, 20);
    measure.click(20, 20);
    assert.equal(measure.results.length, 1);
    assert.equal(measure.hasPending, true, 'le premier point reste en attente');
    measure.clear();
    assert.equal(measure.results.length, 0);
  });
  model.dispose();
});

test('surface : le clic sur une face donne l’aire de la face entière, et un second clic sur elle ne double rien', async () => {
  const model = await boxModel();
  const viewer = viewerOf(model);
  const measure = withFakeDocument(() => new Measure(viewer, new FakeElement() as unknown as HTMLElement));
  withFakeDocument(() => {
    measure.setTool('area');
    const hit = measure.click(50, 50);
    assert.ok(hit && !hit.cap, 'le rayon touche la face du dessus');
    assert.equal(measure.results.length, 1);
    near(measure.results[0].value, 6, 1e-3); // 2 m × 3 m
    assert.match(measure.results[0].note, /Boîte/);
    measure.click(50, 50);
    assert.equal(measure.results.length, 1);
  });
  model.dispose();
});

test('volume : une boîte de 2 × 3 × 5 m fait 30 m³ et 62 m² de peau, sans réserve', async () => {
  const model = await boxModel();
  const viewer = viewerOf(model);
  const measure = withFakeDocument(() => new Measure(viewer, new FakeElement() as unknown as HTMLElement));
  withFakeDocument(() => {
    measure.setTool('volume');
    measure.click(50, 50);
    assert.equal(measure.results.length, 1);
    near(measure.results[0].value, 30, 1e-3);
    assert.equal(measure.results[0].approximate, false);
    assert.ok(measure.results[0].note.includes(formatArea(62)), measure.results[0].note);
    measure.click(50, 50);
    assert.equal(measure.results.length, 1, 'le même élément n’est pas mesuré deux fois');
  });
  model.dispose();
});
