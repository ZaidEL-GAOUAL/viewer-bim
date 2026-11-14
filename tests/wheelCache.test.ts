import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadWheel, sha256Hex, type WheelCache, type WheelIo } from '../src/ifc/wheelCache.ts';

const URL_ = 'https://wheels.example.org/ifcopenshell-0.8.5.whl';
const GOOD = new Uint8Array([1, 2, 3, 4, 5]).buffer as ArrayBuffer;
const SHA = await sha256Hex(GOOD);

function fakeIo(options: { cached?: ArrayBuffer; network?: ArrayBuffer; status?: number; cacheOpens?: boolean; putFails?: boolean } = {}) {
  const store = new Map<string, ArrayBuffer>();
  const log = { fetches: 0, deletes: 0, puts: 0 };
  if (options.cached) store.set(`${URL_}?sha256=${SHA}`, options.cached);
  const cache: WheelCache = {
    async match(key) { const bytes = store.get(key); return bytes ? new Response(bytes.slice(0)) : undefined; },
    async put(key, response) { log.puts++; if (options.putFails) throw new Error('quota'); store.set(key, await response.arrayBuffer()); },
    async delete(key) { log.deletes++; return store.delete(key); },
  };
  const io: WheelIo = {
    async fetch() { log.fetches++; return new Response(options.network ?? GOOD, { status: options.status ?? 200 }); },
    async openCache() { if (options.cacheOpens === false) throw new Error('private window'); return cache; },
  };
  return { io, store, log };
}

test('cache miss downloads, verifies and stores; the next read is a hit with no request', async () => {
  const { io, log, store } = fakeIo();
  const first = await loadWheel(URL_, SHA, io);
  assert.equal(first.source, 'network');
  assert.equal(store.size, 1);
  const second = await loadWheel(URL_, SHA.toUpperCase(), io);
  assert.equal(second.source, 'cache');
  assert.deepEqual(new Uint8Array(second.bytes), new Uint8Array(GOOD));
  assert.equal(log.fetches, 1);
});

test('a corrupted cache entry is rejected by the hash, deleted and refetched', async () => {
  const { io, log, store } = fakeIo({ cached: new Uint8Array([9, 9, 9]).buffer as ArrayBuffer });
  const result = await loadWheel(URL_, SHA, io);
  assert.equal(result.source, 'network');
  assert.equal(log.deletes, 1);
  assert.equal(log.fetches, 1);
  assert.deepEqual(new Uint8Array(store.get(`${URL_}?sha256=${SHA}`)!), new Uint8Array(GOOD)); // repaired
});

test('unavailable cache or failing put falls back to the network without failing', async () => {
  const unavailable = fakeIo({ cacheOpens: false });
  assert.equal((await loadWheel(URL_, SHA, unavailable.io)).source, 'network');
  const quota = fakeIo({ putFails: true });
  assert.equal((await loadWheel(URL_, SHA, quota.io)).source, 'network');
  assert.equal(quota.log.puts, 1);
});

test('a network file with the wrong hash or status is refused and never cached', async () => {
  const wrong = fakeIo({ network: new Uint8Array([7]).buffer as ArrayBuffer });
  await assert.rejects(loadWheel(URL_, SHA, wrong.io), /ne correspond pas/);
  assert.equal(wrong.store.size, 0);
  const missing = fakeIo({ status: 404 });
  await assert.rejects(loadWheel(URL_, SHA, missing.io), /HTTP 404/);
  assert.equal(missing.store.size, 0);
});
