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

test('le planning masque les objets à venir aussi pour le clic, indépendamment du masque manuel', async () => {
  const model = await buildFromNodes([{ mesh: 0, extras: { id: 'cube' } }], [0], CUBE);
  const ray = new Ray(new Vector3(0, 0, 2), new Vector3(0, 0, -1));
  assert.ok(model.raycast(ray));
  model.state.setSchedule(new Uint8Array([1]));
  assert.equal(model.raycast(ray), null);
  assert.equal(model.state.isVisible(0), true, 'le planning ne change pas la visibilité sauvegardée par l’isolation');
  for (const status of [0, 2, 3]) {
    model.state.setSchedule(new Uint8Array([status]));
    assert.ok(model.raycast(ray));
  }
  model.state.setVisible(0, false);
  model.state.setSchedule(new Uint8Array([2]));
  assert.equal(model.raycast(ray), null, 'une tâche active ne réaffiche pas un objet masqué manuellement');
  model.state.setSchedule(null);
  assert.equal(model.raycast(ray), null);
  model.state.setVisible(0, true);
  model.state.setOpacity(0, 0);
  model.state.setSchedule(new Uint8Array([2]));
  assert.equal(model.raycast(ray), null, 'les règles d’opacité restent applicables pendant la simulation');
  model.state.clearOpacity(0);
  assert.ok(model.raycast(ray));
  model.dispose();
});

test('fermer la 4D retrouve les modifications manuelles faites pendant la lecture', () => {
  const state = new ElementState(3);
  state.setColor(0, 10, 20, 30);
  state.setOpacity(0, .5);
  state.setSelected(0, true);
  state.setOpen(0, true);
  state.setPriority(0, 5);
  const before = state.data.slice();
  state.setSchedule(new Uint8Array([2, 1, 3]));
  assert.deepEqual(state.data, before, 'tous les attributs de présentation manuels sont conservés');
  state.setColor(0, 80, 90, 100);
  state.setOpacity(0, .25);
  state.setVisible(1, false);
  state.setSelected(2, true);
  const during = state.data.slice();
  state.setSchedule(null);
  assert.deepEqual(state.data, during, 'la fermeture ne restaure pas un ancien instantané');
  assert.equal(state.opacityOf(0), .25);
  assert.equal(state.isSelected(0), true);
  assert.equal(state.isOpen(0), true);
  assert.equal(state.isVisible(1), false);
  assert.equal(state.isRendered(1), false);
  assert.equal(state.isSelected(2), true);
  state.dispose();
});

test('un planning invalide échoue atomiquement et le tampon du lecteur est copié', () => {
  const state = new ElementState(2);
  const statuses = new Uint8Array([1, 2]);
  state.setSchedule(statuses);
  const texture = state.scheduleUniform.value;
  const version = texture.version;
  statuses[0] = 0;
  assert.equal(state.isRendered(0), false, 'le tampon externe ne modifie pas la frame affichée');
  assert.throws(() => state.setSchedule(new Uint8Array([0])), /par élément/);
  assert.throws(() => state.setSchedule(new Uint8Array([0, 4])), /entre 0 et 3/);
  assert.equal(texture.version, version);
  assert.equal(state.isRendered(0), false, 'aucun état partiel après une erreur');
  assert.equal(state.isRendered(1), true);
  state.setSchedule(null);
  assert.equal(state.isRendered(0), true);
  state.dispose();
});

test('le masquage 4D est partagé par les shaders opaques, transparents et les coupes', async () => {
  const model = await buildFromNodes([{ mesh: 0, extras: { id: 'cube' } }], [0], CUBE);
  model.state.setOpacity(0, .5);
  const materials = [
    ...model.group.children.filter((child): child is Mesh => child instanceof Mesh).map((mesh) => mesh.material as Material),
    model.stencilBack,
    model.stencilFront,
  ];
  assert.ok(materials.length >= 4);
  for (const material of materials) {
    const shader = compile(material);
    assert.equal(shader.uniforms.uElementSchedule, model.state.scheduleUniform);
    assert.match(shader.vertexShader, /bimHidden = .*bimSchedule == 1/);
    assert.match(shader.vertexShader, /if \( bimSchedule == 2 \)/);
    assert.ok(shader.vertexShader.indexOf('if ( bimSchedule == 2 )') < shader.vertexShader.indexOf('uSelectColor, 0.8'), 'la sélection reste lisible au-dessus de la teinte 4D');
    assert.match(shader.vertexShader, /vBimFlat = 1\.0;/, 'la texture de matériau n’atténue pas la teinte active');
  }
  model.dispose();
});

test('les frames 4D réutilisent les lots et textures sans changer la géométrie ni le GLB exporté', async () => {
  const model = await buildFromNodes([
    { mesh: 0, extras: { id: 'a', properties: { Niveau: 1 } } },
    { mesh: 0, translation: [2, 0, 0], extras: { id: 'b', properties: { Niveau: 2 } } },
  ], [0, 1], CUBE);
  const initialExport = new Uint8Array(writeGlb(model));
  const children = [...model.group.children];
  const texture = model.state.scheduleUniform.value;
  const geometry = model.chunks[0].mesh.geometry;
  const positions = geometry.getAttribute('position').array.slice();
  const indices = geometry.index!.array.slice();
  for (let frame = 0; frame < 100; frame++) {
    model.state.setSchedule(new Uint8Array([frame % 4, (frame + 1) % 4]));
  }
  assert.deepEqual(model.group.children, children);
  assert.equal(model.state.scheduleUniform.value, texture);
  assert.equal(model.chunks[0].mesh.geometry, geometry);
  assert.deepEqual(geometry.getAttribute('position').array, positions);
  assert.deepEqual(geometry.index!.array, indices);
  assert.deepEqual(new Uint8Array(writeGlb(model)), initialExport);
  model.state.setSchedule(null);
  assert.deepEqual(new Uint8Array(writeGlb(model)), initialExport);
  model.dispose();
});

test('la texture 4D couvre les modèles sur plusieurs lignes et est libérée avec le modèle', () => {
  const state = new ElementState(1025);
  const statuses = new Uint8Array(1025);
  statuses[1024] = 1;
  state.setSchedule(statuses);
  assert.equal(state.isRendered(1023), true);
  assert.equal(state.isRendered(1024), false);
  assert.equal(state.scheduleUniform.value.image.width, state.texture.image.width);
  assert.equal(state.scheduleUniform.value.image.height, state.texture.image.height);
  let disposed = false;
  state.scheduleUniform.value.addEventListener('dispose', () => { disposed = true; });
  state.dispose();
  assert.equal(disposed, true);
});
