import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LOW_MEMORY_GB, WARM_ALL_MS, WARM_HIDDEN_MS, mayPreload, settle } from '../src/ifc/enginePolicy.ts';

const pool = (size: number, extra: { hiddenSince?: number | null; memoryGB?: number } = {}) =>
  ({ size, lastUsed: 1000, hiddenSince: extra.hiddenSince ?? null, memoryGB: extra.memoryGB });

test('settle keeps every prepared worker during the warm window, then shrinks to one', () => {
  assert.deepEqual(settle(pool(4), 1000), { keep: 4, recheckIn: WARM_ALL_MS });
  assert.deepEqual(settle(pool(4), 1000 + WARM_ALL_MS - 1), { keep: 4, recheckIn: 1 });
  assert.deepEqual(settle(pool(4), 1000 + WARM_ALL_MS), { keep: 1, recheckIn: null });
  assert.deepEqual(settle(pool(1), 1000 + WARM_ALL_MS * 3), { keep: 1, recheckIn: null });
  assert.deepEqual(settle(pool(0), 1000 + WARM_ALL_MS), { keep: 0, recheckIn: null });
});

test('settle releases the last worker once the tab has been hidden long enough', () => {
  const hiddenAt = 1000 + 60_000;
  const state = pool(2, { hiddenSince: hiddenAt });
  // Hidden but still inside the 5-minute window: everything stays.
  assert.equal(settle(state, hiddenAt + 1).keep, 2);
  // Window over, hidden for less than 10 minutes: one stays, re-check when the hidden delay ends.
  const afterWindow = 1000 + WARM_ALL_MS;
  assert.deepEqual(settle(state, afterWindow), { keep: 1, recheckIn: hiddenAt + WARM_HIDDEN_MS - afterWindow });
  assert.deepEqual(settle(state, hiddenAt + WARM_HIDDEN_MS - 1), { keep: 1, recheckIn: 1 });
  assert.deepEqual(settle(state, hiddenAt + WARM_HIDDEN_MS), { keep: 0, recheckIn: null });
  // Hidden for 10 minutes before the 5-minute window ends: released as soon as the window ends.
  assert.equal(settle(pool(2, { hiddenSince: 1000 + WARM_ALL_MS - WARM_HIDDEN_MS }), 1000 + WARM_ALL_MS).keep, 0);
});

test('settle keeps at most one worker right away under 4 GB of memory', () => {
  assert.deepEqual(settle(pool(3, { memoryGB: LOW_MEMORY_GB - 1 }), 1000), { keep: 1, recheckIn: null });
  assert.equal(settle(pool(3, { memoryGB: LOW_MEMORY_GB }), 1000).keep, 3);
  assert.equal(settle(pool(3, { memoryGB: 2, hiddenSince: 0 }), 1000 + WARM_HIDDEN_MS).keep, 0);
});

test('mayPreload refuses data saver and low memory, accepts unknown memory', () => {
  assert.equal(mayPreload({}), true);
  assert.equal(mayPreload({ memoryGB: 8 }), true);
  assert.equal(mayPreload({ memoryGB: 4 }), true);
  assert.equal(mayPreload({ memoryGB: 2 }), false);
  assert.equal(mayPreload({ saveData: true, memoryGB: 8 }), false);
});
