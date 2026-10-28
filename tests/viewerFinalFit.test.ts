import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Box3, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import type { Model } from '../src/engine/Model.ts';
import { Viewer } from '../src/engine/Viewer.ts';

// Le cadrage final d'un modèle lu par morceaux (Viewer.setModel avec le modèle déjà affiché) : fait seulement si
// l'utilisateur n'a pas déplacé la caméra depuis le dernier cadrage et n'est pas en visite. Le Viewer se construit avec
// WebGL : un faux Viewer, du vrai prototype, qui porte ce que `setModel` et `fit` lisent.

const BOX = new Box3(new Vector3(0, 0, 0), new Vector3(20, 10, 10));
const CENTER = new Vector3(10, 5, 5);
const model = { box: BOX } as unknown as Model;

interface Probe {
  viewer: Viewer;
  grown: number;
  walkExits: number;
  controls: { target: Vector3; update(): void };
  camera: PerspectiveCamera;
}

function probe(state: { cameraMoved: boolean; walking: boolean }): Probe {
  const camera = new PerspectiveCamera(45, 1.5, 0.1, 1000);
  camera.position.set(100, 100, 100);
  const result = { grown: 0, walkExits: 0 } as Probe;
  result.camera = camera;
  result.controls = { target: new Vector3(50, 50, 50), update() {} };
  result.viewer = Object.assign(Object.create(Viewer.prototype) as Viewer, {
    model, camera, perspective: camera, orthographic: new OrthographicCamera(), controls: result.controls,
    cameraMoved: state.cameraMoved, externalCamera: false, scratch: new Vector3(), width: 300, height: 200,
    walk: { active: state.walking, exit: () => { result.walkExits++; } },
    modelGrown: () => { result.grown++; },
    invalidate() {},
  });
  return result;
}

const framed = (p: Probe) => p.controls.target.distanceTo(CENTER) < 1e-9;

test('lecture terminée, caméra intacte : cadrage final sur le modèle entier', () => {
  const p = probe({ cameraMoved: false, walking: false });
  p.viewer.setModel(model);
  assert.equal(p.grown, 1);
  assert.ok(framed(p), 'la caméra est cadrée sur le centre du modèle');
});

test('lecture terminée, caméra déplacée par l’utilisateur : la caméra reste où il l’a mise, le modèle grandit quand même', () => {
  const p = probe({ cameraMoved: true, walking: false });
  p.viewer.setModel(model);
  assert.equal(p.grown, 1, 'bornes, plans proche et lointain, limites des coupes suivent');
  assert.ok(p.controls.target.equals(new Vector3(50, 50, 50)), 'le pivot n’a pas bougé');
  assert.ok(p.camera.position.equals(new Vector3(100, 100, 100)), 'la caméra n’a pas bougé');
});

test('lecture terminée pendant la visite : on n’en sort pas et la caméra ne bouge pas', () => {
  const p = probe({ cameraMoved: false, walking: true });
  p.viewer.setModel(model);
  assert.equal(p.grown, 1);
  assert.equal(p.walkExits, 0, 'cadrer ferait sortir de la visite');
  assert.ok(p.controls.target.equals(new Vector3(50, 50, 50)));
});

test('un cadrage remet à zéro « caméra déplacée » : le suivant est possible', () => {
  const p = probe({ cameraMoved: true, walking: false });
  p.viewer.fit(BOX);
  assert.equal(p.viewer['cameraMoved'], false);
  p.viewer.setModel(model);
  assert.ok(framed(p));
  // Une boîte vide ne cadre rien, donc ne remet rien à zéro.
  const moved = probe({ cameraMoved: true, walking: false });
  moved.viewer.fit(new Box3());
  assert.equal(moved.viewer['cameraMoved'], true);
});
