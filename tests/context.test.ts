import assert from 'node:assert/strict';
import { test } from 'node:test';
import { geoBoxes, groundAt, heightCounts, loadContext, osmProvider, toEnu, toGeo, type ContextProvider, type GeoBox, type TerrainSource } from '../src/site/context.ts';
import type { OsmBuilding } from '../src/geo/osmBuildings.ts';
import { GRID } from '../src/geo/terrain.ts';
import { newStudy } from '../src/site/study.ts';

const ORIGIN = { latitude: 48.8566, longitude: 2.3522 };
const square = (lon: number, lat: number, d = 0.0001): [number, number][] => [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d]];

/** Base mondiale factice : deux bâtiments, l'un avec une hauteur renseignée, l'autre sans. */
function fakeOsm(calls: GeoBox[] = []) {
  return osmProvider(async (box) => {
    calls.push(box);
    const buildings: OsmBuilding[] = [
      { id: 1, outline: square(box.west + 0.001, box.south + 0.001), height: 15, tagged: true },
      { id: 2, outline: square(box.west + 0.002, box.south + 0.002), height: 8, tagged: false },
    ];
    return buildings;
  });
}

/** Relief factice : 50 m partout. */
const flat50: TerrainSource = { credit: 'Relief factice', zoom: 15, tile: async () => new Float32Array(GRID * GRID).fill(50) };

test('un fournisseur en panne ou sans couverture laisse la place à la base mondiale ; la source de chaque hauteur est notée', async () => {
  const broken: ContextProvider = { name: 'Panne', credit: 'X', buildings: async () => { throw new Error('503'); } };
  const elsewhere: ContextProvider = { name: 'Ailleurs', credit: 'Y', buildings: async () => null };
  const { context, notes } = await loadContext(ORIGIN, 300, { providers: [broken, elsewhere], base: fakeOsm(), terrain: null });
  assert.deepEqual(context.buildings.map((b) => [b.height, b.heightSource]), [[15, 'tagged'], [8, 'assumed']]);
  assert.deepEqual(heightCounts(context.buildings), { measured: 0, tagged: 1, assumed: 1 });
  assert.ok(notes.some((note) => note.includes('Panne') && note.includes('503')));
  assert.ok(context.credits.some((credit) => credit.includes('OpenStreetMap')));
  assert.ok(!context.credits.includes('X') && !context.credits.includes('Y'));
  assert.equal(context.radius, 300);
  assert.ok(context.fetchedAt);
});

test('un fournisseur qui couvre le lieu passe avant la base mondiale, avec ses hauteurs mesurées', async () => {
  let baseCalled = false;
  const national: ContextProvider = {
    name: 'National', credit: '© Fournisseur national',
    buildings: async (box) => [{ id: 'n1', outline: square(box.west + 0.001, box.south + 0.001), height: 21.4, heightSource: 'measured' }],
  };
  const base = osmProvider(async () => { baseCalled = true; return []; });
  const { context } = await loadContext(ORIGIN, 300, { providers: [national], base, terrain: null });
  assert.equal(baseCalled, false);
  assert.deepEqual(context.buildings.map((b) => [b.id, b.height, b.heightSource]), [['n1', 21.4, 'measured']]);
  assert.deepEqual(context.credits, ['© Fournisseur national']);
});

test('la base mondiale en panne : l’erreur remonte (rien n’est inventé)', async () => {
  const base = osmProvider(async () => { throw new Error('Overpass a répondu 504'); });
  await assert.rejects(loadContext(ORIGIN, 300, { base, terrain: null }), /504/);
});

test('les contours passent en mètres est-nord depuis l’origine, et reviennent', () => {
  const [e, n] = toEnu(ORIGIN, ORIGIN.longitude + 0.001, ORIGIN.latitude + 0.001);
  assert.ok(Math.abs(n - 111.2) < 0.5 && Math.abs(e - 111.2 * Math.cos((ORIGIN.latitude * Math.PI) / 180)) < 0.5, `${e}, ${n}`);
  const [lon, lat] = toGeo(ORIGIN, e, n);
  assert.ok(Math.abs(lon - ORIGIN.longitude - 0.001) < 1e-9 && Math.abs(lat - ORIGIN.latitude - 0.001) < 1e-9);
});

test('près de l’antiméridien, la boîte est coupée en deux et les bâtiments de l’autre côté restent voisins', async () => {
  const fiji = { latitude: -16.8, longitude: 179.999 };
  assert.equal(geoBoxes(fiji, 300).length, 2);
  assert.equal(geoBoxes(ORIGIN, 300).length, 1);
  const calls: GeoBox[] = [];
  const { context } = await loadContext(fiji, 300, { base: fakeOsm(calls), terrain: null });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((box) => box.west < box.east && box.west >= -180 && box.east <= 180));
  // Tous les bâtiments sont à moins de 400 m de l'origine, de quelque côté de l'antiméridien qu'ils soient.
  assert.ok(context.buildings.every((b) => b.footprint.every(([x, y]) => Math.hypot(x, y) < 400)));
  const [e] = toEnu(fiji, -179.999, fiji.latitude);
  assert.ok(e > 0 && e < 300);
});

test('le relief est lu une fois en grille ; l’altitude de l’origine en vient et le sol local y est à 0', async () => {
  const { context, altitude, notes } = await loadContext(ORIGIN, 300, { base: fakeOsm(), terrain: flat50 });
  const grid = context.terrain!;
  assert.ok(grid.columns >= 2 && grid.rows >= 2 && grid.heights.length === grid.columns * grid.rows);
  assert.ok(grid.heights.every((h) => h === 50));
  assert.equal(altitude, 50);
  assert.ok(context.credits.includes('Relief factice'));
  assert.deepEqual(notes, []);
  const study = newStudy();
  study.context = context;
  study.site.origin = { ...ORIGIN, altitude: 50 };
  assert.equal(groundAt(study, 0, 0), 0);
  assert.equal(groundAt(study, 10_000, 0), 0);
  // Sans relief : sol plat à l'altitude de l'origine.
  study.context.terrain = null;
  assert.equal(groundAt(study, 12, 5), 0);
  // Relief en panne : les bâtiments sont gardés, le relief manque et c'est dit.
  const failing: TerrainSource = { credit: 'Z', zoom: 15, tile: async () => { throw new Error('tuile absente'); } };
  const partial = await loadContext(ORIGIN, 300, { base: fakeOsm(), terrain: failing });
  assert.equal(partial.context.terrain, null);
  assert.equal(partial.altitude, null);
  assert.ok(partial.notes.some((note) => note.includes('tuile absente')));
});
