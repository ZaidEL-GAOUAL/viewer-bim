import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dxfText, layerName, nearestAci, writeDxf, type DxfDrawing } from '../src/data/dxf.ts';

/** Les paires (code, valeur) d'un DXF. */
function pairs(dxf: string): [string, string][] {
  const lines = dxf.split('\n');
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([lines[i].trim(), lines[i + 1]]);
  return out;
}

const square: DxfDrawing = {
  layers: [{ name: 'Murs', color: 5 }],
  polylines: [{ layer: 'Murs', closed: true, elevation: 3.2, points: [[0, 0], [5, 0], [5, 4], [0, 4]] }],
  lines: [{ layer: 'Murs', from: [0, 0], to: [1, 1], elevation: 3.2 }],
  texts: [{ layer: 'Murs', x: 0, y: -1, height: 0.2, text: 'Plan « Étage 1 »', elevation: 3.2 }],
};

test('a cut square is one closed LWPOLYLINE with four vertices on its layer', () => {
  const entries = pairs(writeDxf(square));
  const start = entries.findIndex(([code, value]) => code === '0' && value === 'LWPOLYLINE');
  assert.ok(start >= 0);
  const end = entries.findIndex(([code], i) => i > start && code === '0');
  const entity = entries.slice(start, end);
  assert.deepEqual(entity.find(([code]) => code === '8'), ['8', 'Murs']);
  assert.deepEqual(entity.find(([code]) => code === '90'), ['90', '4']);
  assert.deepEqual(entity.find(([code]) => code === '70'), ['70', '1'], 'closed flag');
  assert.deepEqual(entity.find(([code]) => code === '38'), ['38', '3.2'], 'elevation');
  assert.deepEqual(entity.filter(([code]) => code === '10').map(([, v]) => v), ['0', '5', '5', '0']);
  assert.deepEqual(entity.filter(([code]) => code === '20').map(([, v]) => v), ['0', '0', '4', '4']);
});

test('the header says metres', () => {
  const entries = pairs(writeDxf(square));
  const at = entries.findIndex(([code, value]) => code === '9' && value === '$INSUNITS');
  assert.deepEqual(entries[at + 1], ['70', '6']);
  assert.deepEqual(entries[entries.findIndex(([code, value]) => code === '9' && value === '$ACADVER') + 1], ['1', 'AC1015']);
  assert.deepEqual(entries.at(-1), ['0', 'EOF']);
});

test('open segments are LINE entities and layers come with their colour', () => {
  const entries = pairs(writeDxf(square));
  assert.ok(entries.some(([code, value]) => code === '0' && value === 'LINE'));
  const layer = entries.findIndex(([code, value], i) => code === '2' && value === 'Murs' && entries[i - 1]?.[1] !== undefined && entries.slice(Math.max(0, i - 6), i).some(([c, v]) => c === '0' && v === 'LAYER'));
  assert.ok(layer > 0);
  assert.deepEqual(entries.slice(layer, layer + 4).find(([code]) => code === '62'), ['62', '5']);
});

test('accents are escaped with \\U+XXXX, in layer names and texts', () => {
  const dxf = writeDxf({ layers: [{ name: 'Étage 1', color: 7 }], polylines: [], texts: [{ layer: 'Étage 1', x: 0, y: 0, height: 1, text: 'Étage 1' }] });
  assert.ok(!/[^\x00-\x7f]/.test(dxf), 'ASCII only');
  assert.ok(dxf.includes('\\U+00C9tage 1'));
  assert.equal(dxfText('é'), '\\U+00E9');
  assert.equal(dxfText('😀'), '\\U+D83D\\U+DE00');
});

test('layer names obey the DXF rules', () => {
  assert.equal(layerName('Murs/Cloisons: <béton>?'), 'Murs_Cloisons_ _béton__');
  assert.equal(layerName('  '), 'Sans valeur');
  assert.equal(layerName(undefined), 'Sans valeur');
  assert.equal(layerName('a'.repeat(300)).length, 255);
  assert.equal(layerName('0'), '0');
});

test('the nearest AutoCAD colour', () => {
  assert.equal(nearestAci('#ff0000'), 1);
  assert.equal(nearestAci('#0000ff'), 5);
  assert.equal(nearestAci('#00ff00'), 3);
  assert.equal(nearestAci('#ffffff'), 7);
  assert.equal(nearestAci('not a colour'), 7);
  assert.equal(nearestAci('#808080'), 8);
});

test('the output is stable (golden file)', () => {
  const golden = readFileSync(new URL('./fixtures/square.dxf', import.meta.url), 'utf8');
  assert.equal(writeDxf(square), golden);
});
