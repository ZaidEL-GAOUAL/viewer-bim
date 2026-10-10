import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildingHeight, fetchOsmBuildings, outlineCentre, overpassQuery, parseOverpassBuildings } from '../src/geo/osmBuildings.ts';
import { GRID, decodeTerrarium } from '../src/geo/terrain.ts';

test('la hauteur d’un bâtiment OSM vient de height, sinon des niveaux, sinon d’une valeur usuelle', () => {
  assert.equal(buildingHeight({ height: '12.5' }), 12.5);
  assert.equal(buildingHeight({ height: '12,5 m' }), 12.5);
  assert.equal(buildingHeight({ 'building:levels': '4' }), 12);
  assert.equal(buildingHeight({ height: 'abc', 'building:levels': '2' }), 6);
  assert.equal(buildingHeight(undefined), 8);
});

test('une réponse Overpass donne les contours des chemins fermés et des relations', () => {
  const square = [{ lat: 48, lon: 2 }, { lat: 48, lon: 2.001 }, { lat: 48.001, lon: 2.001 }, { lat: 48.001, lon: 2 }, { lat: 48, lon: 2 }];
  const buildings = parseOverpassBuildings({ elements: [
    { type: 'way', id: 1, tags: { building: 'yes', height: '10' }, geometry: square },
    { type: 'way', id: 2, tags: { building: 'yes' }, geometry: square.slice(0, 2) },
    { type: 'relation', id: 3, tags: { building: 'yes', 'building:levels': '5' }, members: [
      { type: 'way', role: 'outer', geometry: square },
      { type: 'way', role: 'inner', geometry: square },
    ] },
  ] });
  assert.deepEqual(buildings.map((b) => [b.id, b.height, b.outline.length]), [[1, 10, 4], [3, 15, 4]]);
  const centre = outlineCentre(buildings[0].outline);
  assert.ok(Math.abs(centre[0] - 2.0005) < 1e-9 && Math.abs(centre[1] - 48.0005) < 1e-9);
  assert.throws(() => parseOverpassBuildings({}), /inattendue/);
});

test('la requête Overpass vise la boîte demandée', () => {
  const query = overpassQuery({ south: 48.85, west: 2.29, north: 48.86, east: 2.3 });
  assert.match(query, /way\["building"\]\(48\.850000,2\.290000,48\.860000,2\.300000\)/);
  assert.match(query, /out geom;/);
});

test('une tuile terrarium se décode en grille de hauteurs, mer ramenée à zéro', () => {
  const size = 4;
  const pixels = new Uint8ClampedArray(size * size * 4);
  const set = (x: number, y: number, metres: number) => {
    const value = metres + 32768;
    const at = (y * size + x) * 4;
    pixels[at] = Math.floor(value / 256);
    pixels[at + 1] = Math.floor(value % 256);
    pixels[at + 2] = Math.round((value % 1) * 256);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) set(x, y, 100 + x * 10 + y);
  set(size - 1, size - 1, -50);
  const heights = decodeTerrarium(pixels, size);
  assert.equal(heights.length, GRID * GRID);
  assert.equal(heights[0], 100);
  assert.equal(heights[GRID - 1], 130);
  assert.equal(heights[(GRID - 1) * GRID], 103);
  assert.equal(heights[GRID * GRID - 1], 0);
});

test('les instances Overpass sont essayées dans l’ordre jusqu’à une réponse', async () => {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (calls.length === 1) return new Response('saturé', { status: 504 });
    return new Response(JSON.stringify({ elements: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const buildings = await fetchOsmBuildings({ south: 0, west: 0, north: 1, east: 1 }, undefined, ['https://a.test/', 'https://b.test/'], 0);
    assert.deepEqual(buildings, []);
    assert.deepEqual(calls, ['https://a.test/', 'https://b.test/']);
    // Toutes saturées : un second tour après une pause, puis l'erreur de la dernière tentative.
    calls.length = 0;
    globalThis.fetch = (async (url: string | URL | Request) => { calls.push(String(url)); return new Response('', { status: 504 }); }) as typeof fetch;
    await assert.rejects(fetchOsmBuildings({ south: 0, west: 0, north: 1, east: 1 }, undefined, ['https://a.test/'], 0), /504 \(serveur saturé\)/);
    assert.deepEqual(calls, ['https://a.test/', 'https://a.test/']);
  } finally {
    globalThis.fetch = original;
  }
});
