import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PropertyStore, parseMetadata } from '../src/data/metadata.ts';
import { PropertyEdits } from '../src/data/PropertyEdits.ts';

test('manual property CRUD is reversible, handles missing fields and preserves source records', () => {
  const source = { Nom: 'Mur', CO2: 1200, Date: '2026-10-03' };
  const store = new PropertyStore(2); store.set(0, source, 'Mur'); store.set(1, { Nom: 'Dalle' }, 'Dalle'); store.finalize();
  const events: string[] = [], edits = new PropertyEdits(store, (path) => events.push(path));
  assert.equal(edits.set([0, 1], 'Nom', 'Renommé'), true);
  assert.equal(store.labelOf(0), 'Renommé'); assert.equal(store.labelOf(1), 'Renommé');
  assert.equal(source.Nom, 'Mur');
  assert.equal(edits.delete([0, 1], 'CO2'), true);
  assert.equal(Object.hasOwn(store.propsOf(0)!, 'CO2'), false);
  assert.equal(store.paths.includes('CO2'), false);
  edits.undo(); assert.equal(store.propsOf(0)?.CO2, 1200); assert.equal(Object.hasOwn(store.propsOf(1)!, 'CO2'), false);
  edits.redo(); assert.equal(store.paths.includes('CO2'), false);
  edits.revert(); assert.equal(store.labelOf(0), 'Mur'); assert.equal(store.labelOf(1), 'Dalle'); assert.equal(store.propsOf(0)?.Date, '2026-10-03');
  assert.equal(edits.changed, false); assert.equal(events.at(-1), '*');
});

test('locked properties and invalid indices cannot be manually modified or deleted', () => {
  const store = new PropertyStore(1); store.set(0, { 'Classe IFC': 'IfcWall' }); store.readOnly = ['Classe IFC']; store.finalize();
  const edits = new PropertyEdits(store, () => {});
  assert.equal(edits.set([0], 'Classe IFC', 'IfcBeam'), false);
  assert.equal(edits.delete([0], 'Classe IFC'), false);
  assert.equal(edits.set([-1, .5, 100], 'Hello', 'value'), false);
  assert.equal(edits.set([0], 'X', NaN), false); assert.equal(edits.canUndo, false);
});

test('JSON metadata import and edits after undo keep complete history and correct save state', () => {
  const store = new PropertyStore(1); store.set(0, { Nom: 'Mur', Existing: 1 }, 'Mur'); store.finalize();
  const edits = new PropertyEdits(store, () => {});
  edits.import(parseMetadata({ elements: { a: { label: 'Mur importé', properties: { Imported: true } } } }), ['a']);
  edits.markSaved(); assert.equal(edits.changed, false);
  edits.set([0], 'Existing', 2); edits.undo(); assert.equal(edits.changed, false);
  edits.undo(); assert.equal(edits.changed, true); assert.equal(store.propsOf(0)?.Imported, undefined);
  edits.set([0], 'Date', '2027-01-01'); assert.equal(edits.changed, true); assert.equal(edits.canRedo, false);
  assert.equal(store.propsOf(0)?.Existing, 1);
});

test('exported snapshots preserve deletions while older partial JSON still merges', () => {
  const store = new PropertyStore(2); store.set(0, { Keep: 1, Remove: 2 }, 'Original'); store.set(1, { Unmatched: true }); store.finalize();
  const edits = new PropertyEdits(store, () => {});
  edits.delete([0], 'Remove');
  const snapshot = parseMetadata(store.export(['a', 'b']));
  assert.equal(snapshot.propertiesMode, 'replace');
  const fresh = new PropertyStore(2); fresh.set(0, { Keep: 1, Remove: 2 }, 'Old label'); fresh.set(1, { Unmatched: true }); fresh.finalize();
  const imported = new PropertyEdits(fresh, () => {});
  imported.import(snapshot, ['a', 'different-id']);
  assert.deepEqual(fresh.propsOf(0), { Keep: 1 });
  assert.deepEqual(fresh.propsOf(1), { Unmatched: true });
  imported.undo(); assert.equal(fresh.propsOf(0)?.Remove, 2);
  imported.redo(); assert.equal(fresh.propsOf(0)?.Remove, undefined);
  imported.import(parseMetadata({ elements: { a: { properties: { Additional: 3 } } } }), ['a', 'b']);
  assert.deepEqual(fresh.propsOf(0), { Keep: 1, Additional: 3 });
});

test('imported locks undo with their properties and identical imports do not mark unsaved', () => {
  const store = new PropertyStore(1); store.set(0, { CO2: 3 }); store.readOnly = ['Source']; store.finalize();
  const edits = new PropertyEdits(store, () => {});
  const imported = parseMetadata({ readOnly: ['CO2'], elements: { a: { properties: { CO2: 3 } } } });
  assert.equal(edits.import(imported, ['a']), true);
  assert.equal(store.isEditable('CO2'), false);
  edits.undo(); assert.deepEqual(store.readOnly, ['Source']); assert.equal(edits.changed, false);
  edits.redo(); assert.deepEqual(store.readOnly, ['Source', 'CO2']);
  edits.markSaved(); assert.equal(edits.import(imported, ['a']), false); assert.equal(edits.changed, false);
});

test('undoing the first property restores an element with no metadata', () => {
  const store = new PropertyStore(1), edits = new PropertyEdits(store, () => {});
  edits.set([0], 'CO2', 100); assert.equal(store.matched, 1);
  edits.undo(); assert.equal(store.propsOf(0), undefined); assert.equal(store.matched, 0); assert.equal(edits.changed, false);
});
