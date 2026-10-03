import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateGlbMetadata } from '../src/engine/updateGlbMetadata.ts';
import { makeGlb, CUBE, loadGlb } from './helpers.ts';
import { Color } from 'three';
import { buildModel, gltfSource } from '../src/engine/buildModel.ts';
import { loadModelFiles } from '../src/engine/loadModel.ts';

// GLB binary payload includes geometry and can also contain images: keep it byte-for-byte.
test('metadata-only GLB export changes current properties and preserves the entire binary payload', async () => {
  const source = makeGlb([{ name: 'wall', mesh: 0, extras: { id: 'a', obsolete: 'drop' } }], [0], CUBE);
  const result = updateGlbMetadata(source, new Map([['a', { CO2: 500, Planning: { Date: '2027-01-01' } }]]), ['Classe IFC']);
  const jsonSize = (buffer: ArrayBuffer) => new DataView(buffer).getUint32(12, true);
  assert.deepEqual(new Uint8Array(result, 20 + jsonSize(result)), new Uint8Array(source, 20 + jsonSize(source)));
  const doc = JSON.parse(new TextDecoder().decode(new Uint8Array(result, 20, jsonSize(result))));
  assert.deepEqual(doc.nodes[0].extras, { id: 'a', CO2: 500, Planning: { Date: '2027-01-01' } });
  assert.deepEqual(doc.extras.readOnly, ['Classe IFC']);
  const { model } = await loadGlb(result); assert.equal(model.count, 1); assert.equal(model.triangleCount, 12); model.dispose();
});

test('unnamed GLB nodes retain edited properties and labels through source-node mapping', async () => {
  const source = makeGlb([{ mesh: 0 }, { mesh: 0, translation: [2, 0, 0] }], [0, 1], CUBE);
  const file = new File([source], 'unnamed.glb');
  const { gltf } = await loadModelFiles({ file, path: file.name }, []);
  const nodeKeys = new Map<number, string>();
  const adapter = gltfSource(gltf);
  adapter.onElement = (object, key) => { const node = gltf.parser.associations.get(object)?.nodes; if (node !== undefined) nodeKeys.set(node, key); };
  const original = buildModel(adapter, { value: new Color() });
  assert.equal(nodeKeys.size, 2);
  const properties = new Map(original.keys.map((id, i) => [id, { CO2: 100 + i }]));
  const labels = new Map(original.keys.map((id, i) => [id, `Élément ${i + 1}`]));
  const result = updateGlbMetadata(source, properties, [], { nodeKeys, labels });
  const { model } = await loadGlb(result);
  assert.deepEqual(model.keys, original.keys);
  assert.deepEqual(model.extras, [{ CO2: 100 }, { CO2: 101 }]);
  assert.deepEqual(model.names, ['Élément 1', 'Élément 2']);
  assert.equal(model.triangleCount, original.triangleCount);
  original.dispose(); model.dispose();
});

test('mapped exports do not turn a same-named mesh child into a separate element', async () => {
  const source = makeGlb([{ name: 'wall', extras: { id: 'wall' }, children: [1] }, { name: 'wall', mesh: 0 }], [0], CUBE);
  const result = updateGlbMetadata(source, new Map([['wall', { CO2: 10 }]]), [], { nodeKeys: new Map([[0, 'wall']]) });
  const jsonLength = new DataView(result).getUint32(12, true);
  const doc = JSON.parse(new TextDecoder().decode(new Uint8Array(result, 20, jsonLength)));
  assert.equal(doc.nodes[1].extras, undefined);
  const { model } = await loadGlb(result); assert.equal(model.count, 1); model.dispose();
});
