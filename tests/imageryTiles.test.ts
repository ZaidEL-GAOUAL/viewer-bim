import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CUSTOM_ID, IMAGERY_SOURCES, OSM, blankTile, checkTemplate, customSatellite, imagerySource, photoFor, saveCustomSatellite, tileUrl } from '../src/geo/imageryTiles.ts';

const memory = (): Storage => {
  const values = new Map<string, string>();
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), removeItem: (k: string) => void values.delete(k) } as Storage;
};
const ESRI = 'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=abc';

test('every source keeps its id, a credit, an https template and a coverage; the old ids still resolve', () => {
  for (const source of IMAGERY_SOURCES) {
    assert.ok(source.credit && source.creditUrl.startsWith('https://'), source.id);
    assert.ok('template' in checkTemplate(source.template), source.id);
    assert.ok(source.id === 'osm' || (source.countries?.length ?? 0) > 0, `${source.id} has a coverage`);
  }
  for (const id of ['osm', 'ign-ortho', 'ign-plan']) assert.equal(imagerySource(id, null).id, id);
  assert.equal(imagerySource('unknown', null), OSM);
});

test('the best photo is the national one of the place, else the user’s own, else none (the plan)', () => {
  assert.equal(photoFor('fr', null)?.id, 'ign-ortho');
  assert.equal(photoFor('re', null)?.id, 'ign-ortho');
  assert.equal(photoFor('es', null)?.id, 'es-pnoa');
  assert.equal(photoFor('us', null)?.id, 'us-usgs');
  assert.equal(photoFor('lk', null), null);
  assert.equal(photoFor(null, null), null);
  const mine = imagerySource(CUSTOM_ID, null);
  assert.equal(mine, OSM, 'no user photo: the plan');
  const storage = memory();
  saveCustomSatellite({ template: ESRI, credit: 'Esri, Maxar, Earthstar Geographics' }, storage);
  const custom = customSatellite(storage);
  assert.equal(custom?.id, CUSTOM_ID);
  assert.equal(custom?.credit, 'Esri, Maxar, Earthstar Geographics');
  assert.equal(photoFor('lk', custom), custom);
  assert.equal(photoFor('ch', custom)?.id, 'ch-swissimage', 'a free national photo comes first');
});

test('a pasted tile address is checked: https, {z} {x} {y}; a broken or blocked store is ignored', () => {
  assert.deepEqual(checkTemplate(` ${ESRI} `), { template: ESRI });
  assert.match((checkTemplate('http://example.com/{z}/{x}/{y}.png') as { error: string }).error, /https/);
  assert.match((checkTemplate('https://example.com/tiles/{z}/{x}.png') as { error: string }).error, /\{y\}/);
  assert.ok('template' in checkTemplate('https://example.com/{z}/{x}/{-y}.jpg'));
  const storage = memory();
  storage.setItem('viewer-bim.satellite', '{oops');
  assert.equal(customSatellite(storage), null);
  storage.setItem('viewer-bim.satellite', JSON.stringify({ template: 'https://example.com/no-placeholders' }));
  assert.equal(customSatellite(storage), null);
  const throwing = { getItem: () => { throw new Error('blocked'); } };
  assert.equal(customSatellite(throwing), null);
  assert.equal(saveCustomSatellite(null, { setItem: () => undefined, removeItem: () => { throw new Error('blocked'); } }), false);
});

test('tile addresses: {y} from the north, {-y} from the south (TMS)', () => {
  assert.equal(tileUrl({ template: 'https://a/{z}/{x}/{y}' }, 3, 1, 2), 'https://a/3/1/2');
  assert.equal(tileUrl({ template: 'https://a/{z}/{x}/{-y}' }, 3, 1, 2), 'https://a/3/1/5');
  assert.equal(tileUrl({ template: ESRI }, 18, 10, 20), ESRI.replace('{z}', '18').replace('{y}', '20').replace('{x}', '10'));
});

test('a blank tile (transparent, or one colour, as services send outside their country) is told from a photo', () => {
  const tile = (pixel: (i: number) => [number, number, number, number]) => {
    const data = new Uint8ClampedArray(256 * 256 * 4);
    for (let i = 0; i < 256 * 256; i++) data.set(pixel(i), i * 4);
    return data;
  };
  assert.equal(blankTile(tile(() => [0, 0, 0, 0])), true);
  assert.equal(blankTile(tile(() => [255, 255, 255, 255])), true);
  assert.equal(blankTile(tile((i) => (i % 3 ? [143, 127, 101, 255] : [140, 123, 97, 255]))), true);
  assert.equal(blankTile(tile((i) => [(i * 7) % 256, (i * 13) % 256, (i * 29) % 256, 255])), false);
});
