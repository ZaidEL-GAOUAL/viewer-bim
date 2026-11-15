import assert from 'node:assert/strict';
import { test } from 'node:test';
import { localToEnu, trueNorthFromAzimuth, type Georeference } from '../src/geo/georeference.ts';
import { toGeo } from '../src/site/context.ts';
import { MAX_GEOREFERENCE_DISTANCE, placementFor } from '../src/site/placedModel.ts';
import { newStudy } from '../src/site/study.ts';

const close = (a: number, b: number, tolerance = 1e-6) => assert.ok(Math.abs(a - b) <= tolerance, `${a} ≠ ${b}`);

test('sans géoréférence, la maquette est posée au centre du terrain, son dessous au sol', () => {
  const { placement, georeferenced } = placementFor({ box: [-10, 2, -5, 30, 14, 15], offset: [500, 0, 500], georeference: null }, newStudy());
  assert.equal(georeferenced, false);
  assert.deepEqual(placement, { east: -10, north: 5, up: -2, rotation: 0 });
  // Le terrain tracé : au-dessus de son centre.
  const study = newStudy();
  study.site.limit = [[100, 50], [140, 50], [140, 90], [100, 90]];
  assert.deepEqual(placementFor({ box: [-10, 2, -5, 30, 14, 15], offset: [0, 0, 0], georeference: null }, study).placement, { east: 110, north: 75, up: -2, rotation: 0 });
});

test('par sa géoréférence, chaque point tombe où `localToEnu` le met, ramené au repère du site', () => {
  const study = newStudy();
  study.site.origin = { latitude: 6.664, longitude: 79.93, altitude: 5 };
  // La maquette est géoréférencée 40 m à l'est et 25 m au nord de l'origine du site, nord du projet tourné de 30°.
  const [longitude, latitude] = toGeo(study.site.origin, 40, 25);
  const g: Georeference = { latitude, longitude, elevation: 7, origin: [12, -3, 1], trueNorth: trueNorthFromAzimuth(30) };
  const offset: [number, number, number] = [100, 2, -50];
  const { placement, georeferenced, distance } = placementFor({ box: [0, 0, 0, 1, 1, 1], offset, georeference: g }, study);
  assert.equal(georeferenced, true);
  assert.ok(distance < 1000);
  close(placement.rotation, 30);
  // Un point de la maquette (repère glTF recentré) : la scène de l'étude le tourne de `rotation` autour de la verticale,
  // puis le pose en (est, haut, −nord).
  const p = [3, 4, 5];
  const a = (placement.rotation * Math.PI) / 180;
  const scene = [p[0] * Math.cos(a) + p[2] * Math.sin(a) + placement.east, p[1] + placement.up, -p[0] * Math.sin(a) + p[2] * Math.cos(a) - placement.north];
  const [e, n, u] = localToEnu(p, offset, g);
  close(scene[0], e + 40, 1e-3);
  close(-scene[2], n + 25, 1e-3);
  close(scene[1], u + g.elevation - study.site.origin.altitude, 1e-9);
});

test('une géoréférence trop loin du projet est écartée : la maquette va au centre, et la distance est dite', () => {
  const study = newStudy();
  const [longitude, latitude] = toGeo(study.site.origin, 0, MAX_GEOREFERENCE_DISTANCE + 2000);
  const { georeferenced, distance, placement } = placementFor({ box: [0, 0, 0, 2, 2, 2], offset: [0, 0, 0], georeference: { latitude, longitude, elevation: 0, origin: [0, 0, 0], trueNorth: [0, 1] } }, study);
  assert.equal(georeferenced, false);
  assert.ok(distance > MAX_GEOREFERENCE_DISTANCE);
  assert.deepEqual(placement, { east: -1, north: 1, up: 0, rotation: 0 });
});
