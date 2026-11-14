import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coveredArea, figureRows, polygonArea, proposalFigures, toTsv } from '../src/site/metrics.ts';
import { newStudy, type Volume, type XY } from '../src/site/study.ts';

const rect = (x: number, y: number, w: number, h: number): XY[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const volume = (id: string, footprint: XY[], floors: number, extra: Partial<Volume> = {}): Volume => ({ id, name: id, footprint, baseLevel: 0, floors, floorHeight: 3, use: 'logement', ...extra });
const SITE = rect(0, 0, 40, 25); // 1 000 m²
const settings = { ...newStudy().settings, dwellingSize: 65, efficiency: 0.8 };

test('20 × 10 m sur 5 niveaux, terrain de 1 000 m² : 200 m², 20 %, 1 000 m², COS 1,0', () => {
  const f = proposalFigures(SITE, [volume('a', rect(5, 5, 20, 10), 5)], settings);
  assert.equal(f.siteArea, 1000);
  assert.equal(f.footprint, 200);
  assert.equal(f.coverage, 0.2);
  assert.equal(f.gfa, 1000);
  assert.equal(f.plotRatio, 1);
  assert.equal(f.highestPoint, 15);
  assert.equal(f.openGround, 800);
  assert.deepEqual(f.gfaByUse, { logement: 1000 });
  // 1 000 m² × 0,8 / 65 m² = 12,3 logements : 12.
  assert.equal(f.dwellings, 12);
});

test('surfaces par usage, usages mêlés par niveau (commerce au rez-de-chaussée)', () => {
  const f = proposalFigures(SITE, [
    volume('a', rect(0, 0, 20, 10), 5, { floorUses: ['commerce'] }),
    volume('b', rect(25, 0, 10, 10), 2, { use: 'bureaux' }),
  ], settings);
  assert.deepEqual(f.gfaByUse, { commerce: 200, logement: 800, bureaux: 200 });
  assert.equal(f.gfa, 1200);
  assert.equal(f.dwellings, Math.floor((800 * 0.8) / 65));
});

test('l’emprise est la surface couverte : un socle et sa tour ne comptent qu’une fois au sol', () => {
  const podium = volume('socle', rect(0, 0, 20, 10), 1, { use: 'commerce' });
  const tower = volume('tour', rect(5, 0, 10, 10), 6, { baseLevel: 3 });
  const f = proposalFigures(SITE, [podium, tower], settings);
  assert.equal(f.footprint, 200);
  assert.equal(f.gfa, 200 + 600);
  assert.equal(f.highestPoint, 21);
});

test('la pleine terre ne compte que le terrain : un volume qui déborde de la limite', () => {
  const f = proposalFigures(SITE, [volume('a', rect(30, 15, 20, 20), 1)], settings);
  assert.equal(f.footprint, 400);
  assert.equal(f.openGround, 1000 - 10 * 10);
});

test('aires : polygone concave, union de polygones qui se recouvrent, découpe par un polygone', () => {
  const l: XY[] = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  assert.equal(polygonArea(l), 64);
  assert.equal(polygonArea([...l].reverse()), 64);
  assert.ok(Math.abs(coveredArea([rect(0, 0, 10, 10), rect(5, 5, 10, 10)]) - 175) < 1e-9);
  assert.ok(Math.abs(coveredArea([l, rect(2, 2, 4, 4)]) - (64 + 4)) < 1e-9);
  // Un losange inscrit dans le carré : la moitié du carré.
  assert.ok(Math.abs(coveredArea([rect(0, 0, 10, 10)], [[5, 0], [10, 5], [5, 10], [0, 5]]) - 50) < 1e-9);
  assert.ok(Math.abs(coveredArea([rect(0, 0, 10, 10), rect(20, 0, 10, 10)], [[5, 0], [25, 0], [25, 10], [5, 10]]) - 100) < 1e-9);
  assert.equal(coveredArea([]), 0);
});

test('sans limite de terrain, les ratios restent vides ; le tableau compare les propositions et se copie en TSV', () => {
  const study = newStudy();
  study.proposals = [
    { id: 'p1', name: 'A', volumes: [volume('a', rect(0, 0, 20, 10), 5)] },
    { id: 'p2', name: 'B', volumes: [] },
  ];
  const f = proposalFigures([], study.proposals[0].volumes, study.settings);
  assert.ok(Number.isNaN(f.coverage) && Number.isNaN(f.plotRatio));
  study.site.limit = SITE;
  const rows = figureRows(study, study.proposals);
  assert.deepEqual(rows[0], ['Indicateur', 'A', 'B']);
  const byLabel = new Map(rows.map((row) => [row[0], row.slice(1)]));
  assert.deepEqual(byLabel.get('Surface de plancher (m²)'), ['1000', '0']);
  assert.deepEqual(byLabel.get('Emprise bâtie (%)'), ['20', '0']);
  assert.deepEqual(byLabel.get('COS (surface de plancher / terrain)'), ['1', '0']);
  const tsv = toTsv([['a', 'b'], ['1,5', 'x\ty']]);
  assert.equal(tsv, 'a\tb\n1,5\tx y');
  study.settings.units = 'ft2';
  assert.equal(new Map(figureRows(study, study.proposals).map((row) => [row[0], row[1]])).get('Surface de plancher (ft²)'), '10764');
});
