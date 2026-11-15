import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MeshPart } from '../src/engine/meshMath.ts';
import { computeQuantities, elementQuantities, quantityUpdates, unionArea, type ElementQuantities, type QuantityPreset } from '../src/engine/quantities.ts';
import { PropertyStore } from '../src/data/metadata.ts';
import { PropertyEdits } from '../src/data/PropertyEdits.ts';
import group from '../src/data/presets/quantites-groupe.json' with { type: 'json' };
import ifc from '../src/data/presets/quantites-ifc.json' with { type: 'json' };

const close = (actual: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

/** Une boîte de min à max (Y vers le haut), 12 triangles orientés vers l'extérieur ; `skip` retire des triangles. */
function box(min: number[], max: number[], skip = 0): MeshPart {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const faces = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5].slice(skip);
  return { positions: c.flat(), index: faces, start: 0, count: faces.length };
}

test('a 2 × 3 × 4 box gives 24 m³ and a 6 m² footprint, exact; without one face, indicatif', () => {
  // 2 m along x, 3 m along z (the footprint), 4 m high.
  const q = elementQuantities([box([0, 0, 0], [2, 4, 3])])!;
  close(q.volume, 24);
  close(q.footprint, 6);
  close(q.height, 4);
  close(q.length, 3);
  close(q.width, 2);
  close(q.outerArea, 2 * (6 + 8 + 12));
  close(q.sideArea, 12, 1e-9);
  assert.equal(q.exact, true);
  const open = elementQuantities([box([0, 0, 0], [2, 4, 3], 6)])!;
  assert.equal(open.exact, false);
});

test('an L-shaped footprint is its real outline, not its convex hull', () => {
  // Two overlapping boxes, 2 × 1 and 1 × 2, sharing a 1 × 1 corner: an L of 3 m², where the hull would give 3.5 m².
  const q = elementQuantities([box([0, 0, 0], [2, 1, 1]), box([0, 0, 0], [1, 1, 2])])!;
  close(q.footprint, 3, 1e-9);
  close(unionArea([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 0.5, 1e-12);
});

test('fill-empty keeps existing values, overwrite replaces them, in one undo step', async () => {
  const store = new PropertyStore(3);
  store.set(0, { 'Quantités calculées / Volume net (m³)': 99 });
  store.set(1, { Nom: 'Dalle' });
  store.finalize();
  const parts = [[box([0, 0, 0], [2, 4, 3])], [box([0, 0, 0], [1, 1, 1])], []];
  const results = await computeQuantities({ parts: (i) => parts[i], ranges: parts }, [0, 1, 2]);
  const preset = group as QuantityPreset;
  const empty = quantityUpdates(store, results, preset, false);
  assert.equal(empty.report.notComputable, 1, 'no geometry');
  assert.equal(empty.report.present, 1);
  assert.equal(empty.report.filled, 13);
  const edits = new PropertyEdits(store, () => {});
  assert.equal(edits.setMany(empty.updates), true);
  assert.equal(store.propsOf(0)?.['Quantités calculées / Volume net (m³)'], 99, 'left as it was');
  assert.equal(store.propsOf(0)?.['Quantités calculées / Emprise au sol nette (m²)'], 6);
  assert.equal(store.propsOf(1)?.['Quantités calculées / Volume net (m³)'], 1);
  assert.equal(store.propsOf(1)?.['Quantités calculées / Fiabilité'], 'exact');
  assert.equal(edits.isModified(1, 'Quantités calculées / Volume net (m³)'), true, 'shown as modified, exported in the sidecar');
  const overwrite = quantityUpdates(store, results, preset, true);
  edits.setMany(overwrite.updates);
  assert.equal(store.propsOf(0)?.['Quantités calculées / Volume net (m³)'], 24);
  assert.equal(edits.count, 2);
  edits.undo();
  edits.undo();
  assert.equal(store.propsOf(1)?.['Quantités calculées / Volume net (m³)'], undefined, 'one step each');
  assert.equal(store.propsOf(0)?.['Quantités calculées / Volume net (m³)'], 99);
});

test('the IFC preset writes the base quantities of the class, and respects locks', () => {
  const store = new PropertyStore(2);
  store.set(0, { 'Classe IFC': 'IFCWALL' });
  store.set(1, { 'Classe IFC': 'IfcSpace' });
  store.finalize();
  store.readOnly = ['Qto_SlabBaseQuantities'];
  const q: ElementQuantities = { length: 5, width: 0.2, height: 3, footprint: 1, sideArea: 15, outerArea: 32, volume: 3, exact: false };
  const { updates, report } = quantityUpdates(store, new Map([[0, q], [1, q]]), ifc as QuantityPreset, false);
  assert.deepEqual(updates.find(([, path]) => path === 'Qto_WallBaseQuantities / NetVolume'), [0, 'Qto_WallBaseQuantities / NetVolume', 3]);
  assert.deepEqual(updates.at(-1), [0, 'Quantités calculées / Fiabilité', 'indicatif']);
  assert.equal(report.unmatched, 1, 'a space has no base quantities in the preset');
  store.set(0, { 'Classe IFC': 'IfcSlab' });
  store.finalize();
  assert.equal(quantityUpdates(store, new Map([[0, q]]), ifc as QuantityPreset, false).report.locked, 4);
});

test('an element drawn as its box only is measured on the box, « indicatif », and counted with its reason', async () => {
  const store = new PropertyStore(2);
  store.finalize();
  const parts = [[box([0, 0, 0], [1, 1, 1])], [box([0, 0, 0], [1, 1, 1])]];
  const results = await computeQuantities({ parts: (i) => parts[i], ranges: parts, boxOnly: new Set([1]) }, [0, 1]);
  assert.deepEqual([results.get(0)?.exact, results.get(1)?.exact, results.get(1)?.approximate], [true, false, true]);
  const { updates, report } = quantityUpdates(store, results, group as QuantityPreset, false);
  assert.equal(report.approximate, 1);
  assert.deepEqual(updates.filter(([, path]) => path === 'Quantités calculées / Fiabilité'), [[0, 'Quantités calculées / Fiabilité', 'exact'], [1, 'Quantités calculées / Fiabilité', 'indicatif']]);
});
