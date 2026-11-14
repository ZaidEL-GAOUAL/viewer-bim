import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Box3 } from 'three';
import { parseMetadata } from '../src/data/metadata.ts';
import { localToEnu } from '../src/geo/georeference.ts';
import { proposalGlb, proposalMetadata } from '../src/site/exportGlb.ts';
import { bar, rectangle, volumeMesh } from '../src/site/massing.ts';
import { newStudy } from '../src/site/study.ts';
import { loadGlb } from './helpers.ts';

function study() {
  const s = newStudy();
  s.site.origin = { latitude: 45.7474, longitude: 4.6904, altitude: 210 };
  s.site.limit = [[0, 0], [60, 0], [60, 40], [0, 40]];
  s.proposals[0].name = 'Variante A';
  s.proposals[0].volumes.push(
    { id: 'v1', name: 'Plot nord', footprint: rectangle([10, 20], [30, 30]), baseLevel: 1.5, floors: 4, floorHeight: 3, use: 'logement', floorUses: ['commerce'] },
    { id: 'v2', name: 'Barre', footprint: bar([0, 5], [40, 5], 8), baseLevel: 0, floors: 2, floorHeight: 3.5, use: 'bureaux' },
  );
  return s;
}

test('une proposition exportée en GLB s’ouvre dans le viewer, un élément par volume, avec ses propriétés', async () => {
  const s = study();
  const { model, warnings } = await loadGlb(proposalGlb(s, s.proposals[0]));
  assert.deepEqual(warnings, []);
  assert.deepEqual(model.keys, ['v1', 'v2']);
  assert.equal(model.names[0], 'Plot nord');
  const props = model.extras[0] as Record<string, Record<string, unknown>>;
  assert.equal(props['Étude de site'].Usage, 'Logement');
  assert.equal(props['Étude de site']['Surface de plancher (m²)'], 800);
  assert.equal(props['Étude de site'].Proposition, 'Variante A');
});

test('le GLB et son JSON posent la proposition au bon endroit sur la carte du viewer', async () => {
  const s = study();
  const { model } = await loadGlb(proposalGlb(s, s.proposals[0]));
  const metadata = parseMetadata(proposalMetadata(s, s.proposals[0]));
  const g = metadata.georeference!;
  assert.equal(g.latitude, 45.7474);
  assert.equal(g.longitude, 4.6904);
  assert.equal(g.elevation, 210);
  assert.deepEqual([...metadata.elements.keys()], ['v1', 'v2']);
  // La boîte du plot nord, ramenée en est-nord-haut par le viewer : 10..30 est, 20..30 nord, 1,5..13,5 haut.
  const box = model.elementBox(0, new Box3());
  const offset = model.offset.toArray();
  const a = localToEnu(box.min.toArray(), offset, g), b = localToEnu(box.max.toArray(), offset, g);
  const lo = a.map((v, i) => Math.min(v, b[i])), hi = a.map((v, i) => Math.max(v, b[i]));
  [10, 20, 1.5].forEach((v, i) => assert.ok(Math.abs(lo[i] - v) < 1e-4, `min ${lo}`));
  [30, 30, 13.5].forEach((v, i) => assert.ok(Math.abs(hi[i] - v) < 1e-4, `max ${hi}`));
});

test('rectangle et barre : contours dans le sens trigonométrique, maillage fermé par segment d’usage', () => {
  assert.deepEqual(rectangle([30, 30], [10, 20]), [[10, 20], [30, 20], [30, 30], [10, 30]]);
  const b = bar([0, 0], [10, 0], 4);
  assert.deepEqual(b, [[0, -2], [10, -2], [10, 2], [0, 2]]);
  const mesh = volumeMesh({ id: 'x', name: 'x', footprint: rectangle([0, 0], [10, 10]), baseLevel: 0, floors: 3, floorHeight: 3, use: 'logement', floorUses: ['commerce'] });
  assert.deepEqual(mesh.segments.map((segment) => [segment.use, segment.bottom, segment.top]), [['commerce', 0, 3], ['logement', 3, 9]]);
  // Deux prismes d'une boîte : 12 triangles chacun.
  assert.equal(mesh.positions.length, 2 * 12 * 9);
});
