import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlace, reversePlace, searchPlaces } from '../src/site/geocode.ts';
import { parseParcel } from '../src/site/parcel.ts';
import { zoneCity, zoneFor, zoneOffset } from '../src/site/timeZones.ts';

/** Un faux service : note les adresses demandées, rend la réponse donnée. */
function fakeFetch(respond: () => Response | Promise<Response>) {
  const urls: string[] = [];
  const run = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return respond();
  }) as typeof fetch;
  return { run, urls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fast = { spacingMs: 0 };

const WADDUWA = {
  place_id: 1, lat: '6.6639728', lon: '79.9305102', category: 'place', type: 'town', name: 'Wadduwa',
  display_name: 'Wadduwa, Panadura DS Division, Kalutara, Province de l’Ouest, 12560, Sri Lanka',
  address: { town: 'Wadduwa', country: 'Sri Lanka', country_code: 'lk' },
};

test('les résultats de Nominatim sont lus : nom, nom complet, position, pays ; un résultat sans position est écarté', async () => {
  const service = fakeFetch(() => json([WADDUWA, { display_name: 'Sans position' }]));
  const places = await searchPlaces('  Wadduwa, Sri Lanka ', { fetch: service.run, ...fast });
  assert.deepEqual(places, [{
    label: WADDUWA.display_name, name: 'Wadduwa', latitude: 6.6639728, longitude: 79.9305102, country: 'lk',
  }]);
  assert.equal(service.urls.length, 1);
  assert.match(service.urls[0], /^https:\/\/nominatim\.openstreetmap\.org\/search\?/);
  assert.match(service.urls[0], /q=Wadduwa%2C%20Sri%20Lanka/);
  assert.match(service.urls[0], /format=jsonv2/);
  // Nom absent : le début du nom complet.
  assert.equal(parsePlace({ lat: 1, lon: 2, display_name: 'Rue X, Ville' })?.name, 'Rue X');
});

test('aucune demande sous trois caractères', async () => {
  const service = fakeFetch(() => json([WADDUWA]));
  assert.deepEqual(await searchPlaces('', { fetch: service.run, ...fast }), []);
  assert.deepEqual(await searchPlaces(' ab ', { fetch: service.run, ...fast }), []);
  assert.equal(service.urls.length, 0);
});

test('une recherche sans résultat rend une liste vide', async () => {
  const service = fakeFetch(() => json([]));
  assert.deepEqual(await searchPlaces('xqzwv', { fetch: service.run, ...fast }), []);
});

test('les erreurs du service sont dites en clair', async () => {
  await assert.rejects(searchPlaces('Paris', { fetch: fakeFetch(() => json({}, 503)).run, ...fast }), /répondu 503/);
  await assert.rejects(searchPlaces('Paris', { fetch: fakeFetch(() => json({}, 429)).run, ...fast }), /trop de demandes/);
  await assert.rejects(searchPlaces('Paris', { fetch: fakeFetch(() => { throw new TypeError('Failed to fetch'); }).run, ...fast }), /injoignable/);
  await assert.rejects(searchPlaces('Paris', { fetch: fakeFetch(() => new Response('<html>', { status: 200 })).run, ...fast }), /illisible/);
  await assert.rejects(searchPlaces('Paris', { fetch: fakeFetch(() => json({ error: 'x' })).run, ...fast }), /inattendue/);
});

test('le nom d’un point cliqué garde la position du clic ; en mer, rien', async () => {
  const place = await reversePlace(6.6, 79.9, { fetch: fakeFetch(() => json(WADDUWA)).run, ...fast });
  assert.equal(place?.name, 'Wadduwa');
  assert.equal(place?.country, 'lk');
  assert.deepEqual([place?.latitude, place?.longitude], [6.6, 79.9]);
  assert.equal(await reversePlace(0, -30, { fetch: fakeFetch(() => json({ error: 'Unable to geocode' })).run, ...fast }), null);
});

test('le fuseau horaire vient du pays et, s’il en a plusieurs, de la ville repère la plus proche', () => {
  assert.equal(zoneFor('lk', 6.66, 79.93), 'Asia/Colombo');
  assert.equal(zoneOffset('Asia/Colombo', new Date('2026-06-21T12:00:00Z')), 5.5);
  assert.equal(zoneCity('Asia/Colombo'), 'Colombo');
  assert.equal(zoneCity('America/Argentina/Buenos_Aires'), 'Buenos Aires');
  // Heure d'été comprise.
  assert.equal(zoneFor('FR', 48.85, 2.35), 'Europe/Paris');
  assert.equal(zoneOffset('Europe/Paris', new Date('2026-06-21T12:00:00Z')), 2);
  assert.equal(zoneOffset('Europe/Paris', new Date('2026-12-21T12:00:00Z')), 1);
  assert.equal(zoneFor('fr', -21.1, 55.5), 'Indian/Reunion');
  assert.equal(zoneFor('us', 34.05, -118.25), 'America/Los_Angeles');
  assert.equal(zoneFor('us', 40.71, -74.0), 'America/New_York');
  assert.equal(zoneFor('au', -31.95, 115.86), 'Australia/Perth');
  assert.equal(zoneOffset('Australia/Sydney', new Date('2026-12-21T12:00:00Z')), 11);
  // Pays inconnu ou absent : rien (la page déduit alors le décalage de la longitude).
  assert.equal(zoneFor(null, 0, 0), null);
  assert.equal(zoneFor('zz', 0, 0), null);
  assert.equal(zoneOffset('Pas/UnFuseau', new Date()), null);
  assert.equal(zoneOffset('UTC', new Date()), 0);
});

test('une parcelle du cadastre (API Carto) est lue : premier contour extérieur, sans point de fermeture répété', () => {
  const parcel = parseParcel({ type: 'FeatureCollection', features: [{
    type: 'Feature',
    geometry: { type: 'MultiPolygon', coordinates: [[[[2.35, 48.85], [2.351, 48.85], [2.351, 48.851], [2.35, 48.85]]]] },
    properties: { idu: '75104000AE0003', section: 'AE', numero: '0003', nom_com: 'Paris' },
  }] });
  assert.deepEqual(parcel, { id: '75104000AE0003', label: 'Parcelle AE 0003, Paris', ring: [[2.35, 48.85], [2.351, 48.85], [2.351, 48.851]] });
  assert.equal(parseParcel({ type: 'FeatureCollection', features: [] }), null);
  assert.equal(parseParcel(null), null);
});
