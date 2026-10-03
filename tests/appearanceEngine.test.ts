import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mesh, Ray, ShaderLib, Vector3, type Material, type WebGLRenderer } from 'three';
import { ElementState } from '../src/engine/elementState.ts';
import { writeGlb } from '../src/engine/writeGlb.ts';
import { CUBE, buildFromNodes, loadGlb } from './helpers.ts';

function compile(material: Material) {
  const shader = { vertexShader: ShaderLib.lambert.vertexShader, fragmentShader: ShaderLib.lambert.fragmentShader, uniforms: { ...ShaderLib.lambert.uniforms } };
  material.onBeforeCompile(shader as Parameters<Material['onBeforeCompile']>[0], {} as WebGLRenderer);
  return shader;
}

test('une opacité nulle empêche le clic sans modifier le masque de visibilité sauvegardé', async () => {
  const model = await buildFromNodes([{ mesh: 0, extras: { id: 'cube' } }], [0], CUBE);
  const ray = new Ray(new Vector3(0, 0, 2), new Vector3(0, 0, -1));
  assert.ok(model.raycast(ray));
  model.state.setOpacity(0, 0);
  assert.equal(model.raycast(ray), null);
  assert.equal(model.state.isVisible(0), true);
  const savedVisibility = model.state.isVisible(0);
  model.state.setVisible(0, false);
  model.state.setVisible(0, savedVisibility);
  model.state.clearOpacity(0);
  assert.ok(model.raycast(ray));
  model.state.setVisible(0, false);
  model.state.setOpacity(0, .5);
  assert.equal(model.raycast(ray), null);
  model.dispose();
});

test('les transparences imposées partagent les tampons et utilisent une passe avec mélange sans écriture de profondeur', async () => {
  const model = await buildFromNodes([{ mesh: 0, extras: { id: 'a' } }, { mesh: 0, translation: [2, 0, 0], extras: { id: 'b' } }], [0, 1], CUBE);
  assert.equal(model.chunks.length, 1);
  const original = model.chunks[0].mesh;
  const geometry = original.geometry;
  const positions = geometry.getAttribute('position').array.slice();
  const indices = geometry.index!.array.slice();
  const colors = geometry.getAttribute('color').array.slice();
  const childCount = model.group.children.length;
  model.state.setOpacity(0, .5);
  const ghost = model.group.children.find((child) => child instanceof Mesh && child !== original) as Mesh;
  assert.ok(ghost);
  assert.equal(ghost.geometry, geometry);
  assert.equal((original.material as Material).transparent, false);
  assert.equal((original.material as Material).depthWrite, true);
  assert.equal((ghost.material as Material).transparent, true);
  assert.equal((ghost.material as Material).depthWrite, false);
  assert.equal(ghost.layers.mask, 1 << 1);
  assert.equal(compile(original.material as Material).uniforms.uBimOpacityPass.value, 0);
  const blendShader = compile(ghost.material as Material);
  assert.equal(blendShader.uniforms.uBimOpacityPass.value, 1);
  assert.equal(blendShader.uniforms.uElementOpacity, model.state.opacityUniform);
  assert.match(blendShader.fragmentShader, /diffuseColor\.a = vBimOpacity/);
  // Une deuxième règle ne doit pas créer un lot supplémentaire par objet.
  model.state.setOpacity(1, .25);
  assert.equal(model.group.children.length, childCount + 1);
  model.state.clearOpacity(0);
  assert.equal(ghost.visible, true);
  model.state.clearOpacity(1);
  assert.equal(ghost.visible, false);
  assert.deepEqual(geometry.getAttribute('position').array, positions);
  assert.deepEqual(geometry.index!.array, indices);
  assert.deepEqual(geometry.getAttribute('color').array, colors);
  model.dispose();
});

test('réinitialiser une règle conserve l’alpha source et les styles de visualisation ne changent pas le GLB', async () => {
  const model = await buildFromNodes([{ mesh: 0, extras: { id: 'glass' } }], [0], CUBE, (gltf) => {
    gltf.materials = [{ alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [.1, .2, .3, .25] } }];
    gltf.meshes[0].primitives[0].material = 0;
  });
  const colors = model.chunks[0].mesh.geometry.getAttribute('color').array.slice();
  const children = model.group.children.length;
  model.state.setOpacity(0, .5);
  model.state.setColor(0, 255, 0, 0);
  assert.equal(model.group.children.length, children); // la passe transparente source suffit
  const { model: exported } = await loadGlb(writeGlb(model));
  assert.deepEqual(exported.chunks[0].mesh.geometry.getAttribute('color').array, colors);
  model.state.setOpacity(0, null);
  assert.equal(model.state.opacityOf(0), null);
  assert.deepEqual(model.chunks[0].mesh.geometry.getAttribute('color').array, colors);
  assert.equal(compile(model.chunks[0].mesh.material as Material).uniforms.uBimOpacityPass.value, 2);
  model.dispose(); exported.dispose();
});

test('l’état d’opacité borne les valeurs et distingue transparent, translucide et source', () => {
  const state = new ElementState(2);
  state.setOpacity(0, -.5);
  assert.equal(state.opacityOf(0), 0);
  assert.equal(state.hasTranslucency, false);
  state.setOpacity(0, .3);
  state.setOpacity(1, .8);
  state.clearOpacity(0);
  assert.equal(state.hasTranslucency, true);
  state.setOpacity(1, 7);
  assert.equal(state.opacityOf(1), 1);
  assert.equal(state.hasTranslucency, false);
  assert.throws(() => state.setOpacity(0, NaN), /Opacité/);
  state.dispose();
});
