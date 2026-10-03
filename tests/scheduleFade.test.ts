import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Mesh, Ray, ShaderLib, Vector3, type Material, type WebGLRenderer } from 'three';
import { ElementState } from '../src/engine/elementState.ts';
import { writeGlb } from '../src/engine/writeGlb.ts';
import { CUBE, buildFromNodes } from './helpers.ts';

function compile(material: Material) {
  const shader = { vertexShader: ShaderLib.lambert.vertexShader, fragmentShader: ShaderLib.lambert.fragmentShader, uniforms: { ...ShaderLib.lambert.uniforms } };
  material.onBeforeCompile(shader as Parameters<Material['onBeforeCompile']>[0], {} as WebGLRenderer);
  return shader;
}

test('le fondu ne démarre que pour une apparition et se termine après 240 ms', () => {
  const state = new ElementState(3);
  state.setSchedule(new Uint8Array([1, 2, 3]), { animate: true, nowMs: 0 });
  assert.equal(state.hasScheduleFade, false, 'la première présentation est immédiate');
  state.setSchedule(new Uint8Array([2, 3, 3]), { animate: true, nowMs: 100 });
  assert.equal(state.hasScheduleFade, true);
  assert.equal(state.scheduleOpacityOf(0), 0);
  assert.equal(state.isRendered(0), false, 'un objet complètement transparent ne se sélectionne pas');
  assert.equal(state.scheduleOpacityOf(1), 1, 'le passage en cours → terminé ne relance pas un fondu');
  assert.equal(state.advanceScheduleFade(220), true);
  assert.ok(Math.abs(state.scheduleOpacityOf(0) - .5) < .005);
  assert.equal(state.isRendered(0), true);
  // Les jours rapides ne redémarrent pas une apparition déjà en cours.
  state.setSchedule(new Uint8Array([3, 3, 3]), { animate: true, nowMs: 230 });
  assert.equal(state.advanceScheduleFade(340), false);
  assert.equal(state.scheduleOpacityOf(0), 1);
  assert.equal(state.hasTranslucency, false);
  const textureVersion = state.scheduleUniform.value.version;
  assert.equal(state.advanceScheduleFade(400), false);
  assert.equal(state.scheduleUniform.value.version, textureVersion, 'aucun transfert GPU au repos');
  state.dispose();
});

test('le recul, le mode sans animation et la fermeture annulent proprement un fondu', () => {
  const state = new ElementState(1);
  const pending = new Uint8Array([1]), active = new Uint8Array([2]);
  const start = () => { state.setSchedule(pending); state.setSchedule(active, { animate: true, nowMs: 100 }); };
  start();
  state.advanceScheduleFade(150);
  state.setSchedule(pending, { animate: true, nowMs: 160 });
  assert.equal(state.hasScheduleFade, false);
  assert.equal(state.isRendered(0), false);
  start();
  state.setSchedule(active);
  assert.equal(state.hasScheduleFade, false);
  assert.equal(state.scheduleOpacityOf(0), 1, 'même état avec animate:false atteint immédiatement la cible');
  start();
  state.setSchedule(null);
  assert.equal(state.hasScheduleFade, false);
  assert.equal(state.isRendered(0), true);
  assert.equal(state.scheduleOpacityOf(0), 1);
  assert.equal(state.advanceScheduleFade(1000), false);
  assert.equal(state.scheduleOpacityOf(0), 1, 'une ancienne frame ne masque pas le modèle après fermeture');
  state.dispose();
});

test('le fondu conserve les masques, les opacités manuelles et leur passe transparente', () => {
  const state = new ElementState(3);
  state.setOpacity(0, .25);
  state.setVisible(1, false);
  state.setOpacity(2, 0);
  state.setSchedule(new Uint8Array([1, 1, 1]));
  state.setSchedule(new Uint8Array([2, 2, 2]), { animate: true, nowMs: 0 });
  assert.equal(state.scheduleOpacityOf(1), 1, 'pas de fondu pour les objets masqués manuellement');
  assert.equal(state.scheduleOpacityOf(2), 1, 'pas de fondu pour les objets transparents par règle');
  state.advanceScheduleFade(120);
  assert.equal(state.opacityOf(0), .25);
  assert.equal(state.isRendered(1), false);
  assert.equal(state.isRendered(2), false);
  state.setOpacity(0, .4);
  state.advanceScheduleFade(240);
  assert.equal(state.hasTranslucency, true, 'la passe manuelle reste active après le fondu');
  assert.equal(state.opacityOf(0), Math.fround(.4));
  state.setSchedule(null);
  assert.equal(state.opacityOf(0), Math.fround(.4));
  assert.equal(state.isVisible(1), false);
  state.dispose();
});

test('les entrées invalides ne changent pas un fondu en cours, même sur une deuxième ligne de texture', () => {
  const state = new ElementState(1025);
  const statuses = new Uint8Array(1025);
  statuses[1024] = 1;
  state.setSchedule(statuses);
  statuses[1024] = 2;
  state.setSchedule(statuses, { animate: true, nowMs: 10 });
  state.advanceScheduleFade(130);
  const before = state.scheduleOpacityOf(1024);
  assert.ok(before > .49 && before < .51);
  assert.equal(state.scheduleOpacityOf(1023), 1);
  const version = state.scheduleUniform.value.version;
  assert.throws(() => state.setSchedule(statuses, { animate: true, nowMs: NaN }), /Horloge/);
  statuses[0] = 4;
  assert.throws(() => state.setSchedule(statuses), /entre 0 et 3/);
  assert.throws(() => state.advanceScheduleFade(NaN), /Horloge/);
  assert.equal(state.scheduleOpacityOf(1024), before);
  assert.equal(state.scheduleUniform.value.version, version);
  state.dispose();
  assert.equal(state.hasScheduleFade, false);
});

test('le fondu réutilise la transparence sans altérer la géométrie, les coupes ou les exports', async () => {
  const model = await buildFromNodes([{ mesh: 0, extras: { id: 'cube' } }], [0], CUBE);
  const beforeExport = new Uint8Array(writeGlb(model));
  const original = model.chunks[0].mesh;
  const geometry = original.geometry;
  model.state.setSchedule(new Uint8Array([1]));
  model.state.setSchedule(new Uint8Array([2]), { animate: true, nowMs: 0 });
  const ghost = model.group.children.find((child) => child instanceof Mesh && child !== original) as Mesh;
  assert.ok(ghost);
  assert.equal(ghost.geometry, geometry);
  assert.equal((ghost.material as Material).transparent, true);
  assert.equal((ghost.material as Material).depthWrite, false);
  const ray = new Ray(new Vector3(0, 0, 2), new Vector3(0, 0, -1));
  assert.equal(model.raycast(ray), null);
  model.state.advanceScheduleFade(120);
  assert.ok(model.raycast(ray));
  const inside = new Ray(new Vector3(0, 0, 0), new Vector3(0, 0, -1));
  assert.equal(model.raycast(inside, { capBackfaces: true }), null, 'aucune section solide artificielle pendant le fondu');
  const childCount = model.group.children.length;
  for (const material of [original.material, ghost.material, model.stencilBack, model.stencilFront] as Material[]) {
    const shader = compile(material);
    assert.equal(shader.uniforms.uElementSchedule, model.state.scheduleUniform);
    assert.match(shader.vertexShader, /BIM_SOLID_ONLY[\s\S]*vBimFade < 1\.0/);
    assert.match(shader.fragmentShader, /diffuseColor\.a \*= vBimFade/);
  }
  model.state.advanceScheduleFade(240);
  assert.equal(ghost.visible, false);
  assert.ok(model.raycast(inside, { capBackfaces: true }), 'les coupes remplies retrouvent leur clic à opacité pleine');
  model.state.setSchedule(new Uint8Array([1]));
  model.state.setSchedule(new Uint8Array([3]), { animate: true, nowMs: 250 });
  assert.equal(ghost.visible, true);
  assert.equal(model.group.children.length, childCount, 'la seconde apparition réutilise la même passe');
  assert.deepEqual(new Uint8Array(writeGlb(model)), beforeExport);
  model.state.setSchedule(null);
  assert.equal(ghost.visible, false);
  assert.deepEqual(new Uint8Array(writeGlb(model)), beforeExport);
  model.dispose();
});

test('les matériaux transparents source utilisent leur passe existante pour le fondu', async () => {
  const model = await buildFromNodes([{ mesh: 0, extras: { id: 'glass' } }], [0], CUBE, (gltf) => {
    gltf.materials = [{ alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [.1, .2, .3, .25] } }];
    gltf.meshes[0].primitives[0].material = 0;
  });
  const count = model.group.children.length;
  model.state.setSchedule(new Uint8Array([1]));
  model.state.setSchedule(new Uint8Array([2]), { animate: true, nowMs: 0 });
  assert.equal(model.group.children.length, count);
  assert.equal(model.state.opacityOf(0), null, 'l’alpha source reste inchangé');
  const shader = compile(model.chunks[0].mesh.material as Material);
  assert.equal(shader.uniforms.uBimOpacityPass.value, 2);
  assert.match(shader.fragmentShader, /diffuseColor\.a \*= vBimFade/);
  assert.ok(shader.fragmentShader.indexOf('#include <alphatest_fragment>') < shader.fragmentShader.indexOf('diffuseColor.a *= vBimFade'), 'le fondu ne modifie pas le seuil des textures découpées');
  model.state.advanceScheduleFade(240);
  assert.equal(model.state.hasScheduleFade, false);
  model.dispose();
});
