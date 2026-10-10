import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeCesiumGlb } from '../src/geo/cesiumGlb.ts';
import { CUBE, buildFromNodes } from './helpers.ts';

function parse(glb: ArrayBuffer) {
  const view = new DataView(glb);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)));
  const binOffset = 20 + jsonLength + 8;
  return { json, bin: new Uint8Array(glb, binOffset, view.getUint32(20 + jsonLength, true)) };
}

test('le GLB pour Cesium reprend les lots du viewer avec l’indice d’élément par sommet', async () => {
  const model = await buildFromNodes([
    { name: 'A', mesh: 0, extras: { id: 'a' } },
    { name: 'B', mesh: 0, translation: [3, 0, 0], extras: { id: 'b' } },
  ], [0, 1], CUBE);
  const { json, bin } = parse(writeCesiumGlb(model));
  assert.deepEqual(json.extensionsUsed, ['EXT_mesh_features', 'EXT_structural_metadata']);
  assert.deepEqual(json.extensions.EXT_structural_metadata.propertyTables, [{ name: 'Éléments', class: 'element', count: 2 }]);
  assert.equal(json.meshes.length, 1);
  assert.equal(json.meshes[0].primitives.length, model.chunks.length);
  const primitive = json.meshes[0].primitives[0];
  assert.deepEqual(primitive.extensions.EXT_mesh_features.featureIds, [{ featureCount: 2, attribute: 0, label: 'element', propertyTable: 0 }]);
  for (const name of ['POSITION', 'NORMAL', 'COLOR_0', '_FEATURE_ID_0']) assert.ok(name in primitive.attributes, name);
  // Les identifiants de feature sont les indices d'éléments, lus dans le tampon.
  const accessor = json.accessors[primitive.attributes._FEATURE_ID_0];
  const bufferView = json.bufferViews[accessor.bufferView];
  const ids = new Float32Array(bin.buffer, bin.byteOffset + bufferView.byteOffset, accessor.count);
  assert.deepEqual([...new Set(ids)].sort(), [0, 1]);
  assert.equal(json.accessors[primitive.attributes.COLOR_0].componentType, 5121);
  assert.equal(json.accessors[primitive.attributes.COLOR_0].normalized, true);
  assert.equal(json.accessors[primitive.attributes.NORMAL].componentType, 5126);
  // Positions dans le repère recentré du viewer, bornes présentes (exigées par glTF).
  const position = json.accessors[primitive.attributes.POSITION];
  assert.equal(position.min.length, 3);
  assert.ok(position.max[0] - position.min[0] >= 4 - 1e-6, 'les deux cubes tiennent dans le même lot');
  assert.equal(json.materials[0].alphaMode, undefined);
  assert.equal(json.buffers[0].byteLength % 4, 0);
});
