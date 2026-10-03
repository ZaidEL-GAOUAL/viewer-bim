import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeMetadata } from '../src/ifc/mergeGlb.ts';

test('shard merge preserves read-only property rules from every converter', () => {
  const merged = JSON.parse(mergeMetadata([
    JSON.stringify({ version: 1, readOnly: ['Classe IFC'], elements: { a: {} } }),
    JSON.stringify({ version: 1, readOnly: ['Qto_*'], elements: { b: {} } }),
  ]));
  assert.deepEqual(merged.readOnly, ['Classe IFC', 'Qto_*']);
  assert.deepEqual(Object.keys(merged.elements).sort(), ['a', 'b']);
});
