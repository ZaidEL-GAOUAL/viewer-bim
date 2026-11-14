import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { MAX_ENTRIES, MAX_ENTRY, MAX_TOTAL, crc32, readZip, writeZip, type Inflate } from '../src/data/zip.ts';
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
  const broken = await readZip(zip, () => new Blob([text('autre chose')]).stream());
  await assert.rejects(broken.get('b/c.txt')!.bytes(), /abîmé/);
});

test('something that is not a zip is refused with a message', async () => {
  await assert.rejects(readZip(new Blob([text('pas une archive')]), nodeInflate), /pas une archive zip/);
});

/** Une archive d'une entrée deflate dont le répertoire annonce `declared` octets (`count` : nombre d'entrées annoncé). */
function lyingZip(content: Uint8Array, declared: number, count = 1): Blob {
  const packed = deflateRawSync(content);
  const name = text('x/markup.bcf');
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true); local.setUint16(8, 8, true); local.setUint32(18, packed.length, true); local.setUint32(22, declared, true); local.setUint16(26, name.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true); central.setUint16(10, 8, true); central.setUint32(16, crc32(content), true); central.setUint32(20, packed.length, true); central.setUint32(24, declared, true); central.setUint16(28, name.length, true);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, count, true); end.setUint16(10, count, true); end.setUint32(12, 46 + name.length, true); end.setUint32(16, 30 + name.length + packed.length, true);
  return new Blob([local.buffer, name, packed, central.buffer, name, end.buffer]);
}

test('a small entry that inflates far beyond its declared size is stopped early (zip bomb)', async () => {
  let produced = 0;
  const counting: Inflate = (data) => nodeInflate(data).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) { produced += chunk.length; controller.enqueue(chunk); } }));
  const entries = await readZip(lyingZip(new Uint8Array(50e6), 10), counting);
  await assert.rejects(entries.get('x/markup.bcf')!.bytes(), /abîmé|trop grand/);
  assert.ok(produced < 2e6, `${produced} bytes inflated`);
});

test('declared sizes, entry count and the total inflated per archive are capped', async () => {
  await assert.rejects((await readZip(lyingZip(text('a'), MAX_ENTRY + 1), nodeInflate)).get('x/markup.bcf')!.bytes(), /trop grand/);
  await assert.rejects(readZip(lyingZip(text('a'), 1, MAX_ENTRIES + 1), nodeInflate), /fichiers/);
  // Chaque lecture réserve sa taille annoncée : au-delà du total, refusée avant toute décompression.
  const entry = (await readZip(lyingZip(text('a'), MAX_ENTRY), nodeInflate)).get('x/markup.bcf')!;
  const reads = Math.floor(MAX_TOTAL / MAX_ENTRY);
  for (let i = 0; i < reads; i++) await assert.rejects(entry.bytes(), /abîmé/);
  await assert.rejects(entry.bytes(), /trop grande/);
});
