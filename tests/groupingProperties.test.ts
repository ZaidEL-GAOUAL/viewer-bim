import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PropertyStore } from '../src/data/metadata.ts';
import { groupingProperties } from '../src/data/grouping.ts';

test('shared grouping fields are promoted while all instance-specific IFC fields remain available', () => {
  const store = new PropertyStore(500);
  for (let i = 0; i < store.count; i++) store.set(i, { 'Classe IFC': 'IfcDoor', 'Pset_DoorCommon / FireRating': 'EI30', [`COG_Porte:${i} / PanelPosition`]: 'LEFT' });
  store.finalize();
  const { common, detailed } = groupingProperties(store);
  assert.deepEqual(common, ['Classe IFC', 'Pset_DoorCommon / FireRating']);
  assert.equal(detailed.length, 500);
  assert.equal(new Set([...common, ...detailed]).size, store.paths.length);
  assert.equal(store.propsOf(0)?.['COG_Porte:0 / PanelPosition'], 'LEFT');
});

test('property coverage includes false and zero, excludes empty values and refreshes after edits', () => {
  const store = new PropertyStore(3);
  store.set(0, { A: 0, B: false, C: null }); store.set(1, { A: '', B: true }); store.finalize();
  assert.equal(store.coverageOf('A'), 1); assert.equal(store.coverageOf('B'), 2); assert.equal(store.coverageOf('C'), 0);
  store.update(1, 'A', 2); assert.equal(store.coverageOf('A'), 2);
  store.set(0, undefined); store.finalize(); assert.equal(store.coverageOf('B'), 1);
});
