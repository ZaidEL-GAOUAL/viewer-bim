import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDLE_PRELOAD_MS, rememberIfcUse, watchPreloadIntent } from '../src/ifc/preloadIntent.ts';

function setup(used: boolean) {
  const data = new Map<string, string>(used ? [['viewer-bim.ifc-converted', '1']] : []);
  const storage = { get: (key: string) => data.get(key) ?? null, set: (key: string, value: string | null) => { if (value) data.set(key, value); else data.delete(key); } };
  const page = new EventTarget();
  const openControl = new EventTarget();
  const scheduled: { ms: number; run: () => void }[] = [];
  let calls = 0;
  watchPreloadIntent({ page, openControl, preload: () => calls++, storage, schedule: (run, ms) => scheduled.push({ run, ms }) });
  return { storage, page, openControl, scheduled, calls: () => calls };
}

test('preloads when files are dragged over the window, not for other drags', () => {
  const { page, calls } = setup(false);
  page.dispatchEvent(Object.assign(new Event('dragenter'), { dataTransfer: { types: ['text/plain'] } }));
  assert.equal(calls(), 0);
  page.dispatchEvent(Object.assign(new Event('dragenter'), { dataTransfer: { types: ['Files'] } }));
  assert.equal(calls(), 1);
});

test('preloads when the open control is hovered or focused', () => {
  const { openControl, calls } = setup(false);
  openControl.dispatchEvent(new Event('pointerenter'));
  openControl.dispatchEvent(new Event('focus'));
  assert.equal(calls(), 2);
});

test('idle preload is scheduled only once this browser has converted an IFC', () => {
  assert.equal(setup(false).scheduled.length, 0);
  const used = setup(true);
  assert.equal(used.scheduled.length, 1);
  assert.equal(used.scheduled[0].ms, IDLE_PRELOAD_MS);
  used.scheduled[0].run();
  assert.equal(used.calls(), 1);
  const fresh = setup(false);
  rememberIfcUse(fresh.storage);
  assert.equal(fresh.storage.get('viewer-bim.ifc-converted'), '1');
});
