import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Box3 } from 'three';
import { writeGlb } from '../src/engine/writeGlb.ts';
import { CUBE, buildFromNodes, loadGlb } from './helpers.ts';

const NODES = [
  { name: 'A', mesh: 0, extras: { id: 'a', obsolete: 'old value' } },
  { name: 'B', mesh: 0, translation: [5, 0, 0], extras: { id: 'b', zone: 'nord' } },
];

function documentOf(buffer: ArrayBuffer): any {
  const length = new DataView(buffer).getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, length)));
}

test('writeGlb préserve la géométrie et tous les éléments, même masqués dans le viewer', async () => {
  const model = await buildFromNodes(NODES, [0, 1], CUBE);
  model.state.setVisible(1, false);
  const glb = writeGlb(model);
  const document = documentOf(glb);
  assert.deepEqual(document.nodes.map((node: any) => node.extras.id), ['a', 'b']);
  assert.deepEqual(document.nodes[1].extras, { zone: 'nord', id: 'b' });
  const { model: reloaded, warnings } = await loadGlb(glb);
  assert.deepEqual(warnings, []);
  assert.deepEqual(reloaded.keys, ['a', 'b']);
  assert.equal(reloaded.triangleCount, model.triangleCount);
  for (let i = 0; i < model.count; i++) {
    const before = model.elementBox(i, new Box3()).translate(model.offset);
    const after = reloaded.elementBox(i, new Box3()).translate(reloaded.offset);
    assert.ok(before.min.distanceTo(after.min) < 1e-5 && before.max.distanceTo(after.max) < 1e-5);
  }
});

test('writeGlb embarque les propriétés courantes sans les anciens extras remplacés', async () => {
  const model = await buildFromNodes(NODES, [0, 1], CUBE);
  const properties = new Map([['a', { Identification: { Mark: 'W-01' }, 'Classe IFC': 'IfcWall' }]]);
  const glb = writeGlb(model, 'test', { properties });
  const document = documentOf(glb);
  assert.deepEqual(document.nodes[0].extras, { ...properties.get('a'), id: 'a' });
  assert.equal(document.nodes[0].extras.obsolete, undefined);
  assert.deepEqual(document.nodes[1].extras, { zone: 'nord', id: 'b' });
  assert.deepEqual(documentOf(writeGlb(model, 'test', { properties: { a: {} } })).nodes[0].extras, { id: 'a' });
  const { model: reloaded } = await loadGlb(glb);
  assert.deepEqual(reloaded.extras[0], properties.get('a'));
});

test('writeGlb conserve les couleurs sRGB et leur alpha après export linéaire et réouverture', async () => {
  const srgb = [10, 100, 200];
  const linear = srgb.map((byte) => {
    const value = byte / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  const model = await buildFromNodes([{ name: 'Couleur', mesh: 0, extras: { id: 'color' } }], [0], CUBE, (gltf) => {
    gltf.materials = [{ alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [...linear, 128 / 255] } }];
    gltf.meshes[0].primitives[0].material = 0;
  });
  const original = model.chunks[0].mesh.geometry.getAttribute('color').array.slice(0, 4);
  const glb = writeGlb(model);
  const document = documentOf(glb);
  const accessor = document.accessors[document.meshes[0].primitives[0].attributes.COLOR_0];
  assert.equal(accessor.componentType, 5126);
  const bufferView = document.bufferViews[accessor.bufferView];
  const binaryStart = 28 + new DataView(glb).getUint32(12, true);
  const color = new Float32Array(glb, binaryStart + bufferView.byteOffset, 4);
  assert.ok(Math.abs(color[0] - linear[0]) < 1e-7);
  assert.ok(Math.abs(color[2] - linear[2]) < 1e-7);
  const { model: reloaded } = await loadGlb(glb);
  assert.deepEqual(reloaded.chunks[0].mesh.geometry.getAttribute('color').array.slice(0, 4), original);
});
