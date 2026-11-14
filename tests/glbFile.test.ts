import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GlbBuffer, ARRAY_BUFFER, FLOAT, align, encodeGlb, parseGlb, replaceGlbJson } from '../src/engine/glbFile.ts';

test('encodeGlb puis parseGlb : le JSON et le binaire reviennent, alignés sur 4 octets', () => {
  const glb = encodeGlb({ asset: { version: '2.0' } }, [new Uint8Array([1, 2, 3]), new Float32Array([4])]);
  assert.equal(glb.byteLength % 4, 0);
  assert.equal(new DataView(glb).getUint32(8, true), glb.byteLength);
  const { json, bin } = parseGlb(glb);
  assert.deepEqual(json, { asset: { version: '2.0' } });
  assert.equal(bin.byteLength, 8, '3 octets complétés à 4, puis un flottant');
  assert.deepEqual([...bin.slice(0, 3)], [1, 2, 3]);
  assert.equal(new Float32Array(bin.slice(4).buffer)[0], 4);
});

test('sans binaire : pas de bloc binaire, et un bloc binaire vide se lit aussi', () => {
  const none = encodeGlb({ asset: { version: '2.0' } });
  assert.equal(none.byteLength, 12 + 8 + align(JSON.stringify({ asset: { version: '2.0' } }).length));
  assert.equal(parseGlb(none).bin.byteLength, 0);
  const empty = encodeGlb({ asset: { version: '2.0' } }, [new Uint8Array(0)]);
  assert.equal(empty.byteLength, none.byteLength);
  // Un fichier venu d'ailleurs peut porter un bloc binaire de longueur nulle.
  const withEmptyChunk = new Uint8Array(none.byteLength + 8);
  withEmptyChunk.set(new Uint8Array(none));
  new DataView(withEmptyChunk.buffer).setUint32(8, withEmptyChunk.byteLength, true);
  new DataView(withEmptyChunk.buffer).setUint32(none.byteLength + 4, 0x004e4942, true);
  assert.equal(parseGlb(withEmptyChunk.buffer).bin.byteLength, 0);
});

test('parseGlb refuse un fichier qui n’est pas un GLB 2 ou qui est tronqué', () => {
  assert.throws(() => parseGlb(new ArrayBuffer(8)), /invalide/);
  const glb = encodeGlb({ asset: { version: '2.0' } }, [new Uint8Array(4)]);
  const wrong = glb.slice(0);
  new DataView(wrong).setUint32(4, 1, true);
  assert.throws(() => parseGlb(wrong), /invalide/);
  assert.throws(() => parseGlb(glb.slice(0, 22)), /incomplet/);
});

test('replaceGlbJson ne change que le JSON : le binaire est recopié tel quel', () => {
  const glb = encodeGlb({ asset: { version: '2.0' }, extras: { a: 1 } }, [new Uint8Array([9, 8, 7, 6])]);
  const { afterJson } = parseGlb(glb);
  const next = replaceGlbJson(glb, afterJson, { asset: { version: '2.0' }, extras: { a: 'plus long que avant' } });
  assert.equal(next.byteLength % 4, 0);
  assert.equal(new DataView(next).getUint32(8, true), next.byteLength);
  const read = parseGlb(next);
  assert.deepEqual(read.json, { asset: { version: '2.0' }, extras: { a: 'plus long que avant' } });
  assert.deepEqual([...read.bin], [9, 8, 7, 6]);
});

test('GlbBuffer aligne chaque vue et numérote vues et accesseurs', () => {
  const buffer = new GlbBuffer();
  const first = buffer.add(new Uint8Array(3), ARRAY_BUFFER, { componentType: FLOAT, count: 1, type: 'SCALAR' });
  const second = buffer.add(new Float32Array(2), ARRAY_BUFFER, { componentType: FLOAT, count: 2, type: 'SCALAR' });
  assert.deepEqual([first, second], [0, 1]);
  assert.equal(buffer.bufferViews[1].byteOffset, 4);
  assert.equal(buffer.byteLength, 12);
  assert.equal(buffer.accessors[1].bufferView, 1);
});
