import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, readZip, writeZip } from '../src/data/zip.ts';
import { deflatedZip, nodeInflate } from './zipHelpers.ts';

const text = (value: string) => new TextEncoder().encode(value);

test('crc32 gives the standard check value', () => {
  assert.equal(crc32(text('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('a stored zip reads back byte for byte, UTF-8 names included, Blob entries too', async () => {
  const image = new Uint8Array(70_000).map((_, i) => (i * 7) & 255);
  const zip = await writeZip([
    { name: 'bcf.version', data: text('<Version/>') },
    { name: 'dossier/réserve é.txt', data: text('Fissure à reprendre') },
    { name: 'dossier/photo.jpg', data: new Blob([image]) },
  ]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const entries = await readZip(zip, nodeInflate);
  assert.deepEqual([...entries.keys()], ['bcf.version', 'dossier/réserve é.txt', 'dossier/photo.jpg']);
  assert.equal(new TextDecoder().decode(await entries.get('dossier/réserve é.txt')!.bytes()), 'Fissure à reprendre');
  assert.deepEqual(await entries.get('dossier/photo.jpg')!.bytes(), image);
});

test('deflated entries read through the injected inflate, and a damaged entry is refused', async () => {
  const zip = deflatedZip({ 'a.xml': '<a>'.repeat(500), 'b/c.txt': 'bonjour' });
  const entries = await readZip(zip, nodeInflate);
  assert.equal(new TextDecoder().decode(await entries.get('a.xml')!.bytes()), '<a>'.repeat(500));
  assert.equal(new TextDecoder().decode(await entries.get('b/c.txt')!.bytes()), 'bonjour');
  const broken = await readZip(zip, async () => text('autre chose'));
  await assert.rejects(broken.get('b/c.txt')!.bytes(), /abîmé/);
});

test('something that is not a zip is refused with a message', async () => {
  await assert.rejects(readZip(new Blob([text('pas une archive')]), nodeInflate), /pas une archive zip/);
});
