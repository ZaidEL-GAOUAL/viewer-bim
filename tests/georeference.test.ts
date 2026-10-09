import assert from 'node:assert/strict';
import { test } from 'node:test';
import { azimuthOf, degreesFromIfc, enuToLocal, enuVectorToLocal, georeferenceToJson, localToEnu, parseGeoreference, trueNorthFromAzimuth } from '../src/geo/georeference.ts';

const near = (a: number, b: number, tolerance = 1e-9) => assert.ok(Math.abs(a - b) < tolerance, `${a} ≠ ${b}`);

test('parseGeoreference : tolérant, avec rotation ou vecteur de nord, et refuse l’invalide', () => {
  const basic = parseGeoreference({ latitude: 45.7474, longitude: 4.6904 })!;
  assert.deepEqual([basic.elevation, basic.origin, basic.trueNorth], [0, [0, 0, 0], [0, 1]]);
  const rotated = parseGeoreference({ latitude: 1, longitude: 2, elevation: 35, origin: [10, 20, 0], rotation: 10, source: 'IfcSite' })!;
  near(rotated.trueNorth[0], Math.sin((10 * Math.PI) / 180));
  near(rotated.trueNorth[1], Math.cos((10 * Math.PI) / 180));
  assert.equal(rotated.source, 'IfcSite');
  const vector = parseGeoreference({ latitude: 1, longitude: 2, trueNorth: [3, 4] })!;
  assert.deepEqual(vector.trueNorth, [0.6, 0.8]);
  assert.equal(parseGeoreference({ latitude: 91, longitude: 0 }), null);
  assert.equal(parseGeoreference({ longitude: 0 }), null);
  assert.equal(parseGeoreference('x'), null);
  assert.equal(georeferenceToJson(rotated).rotation, 10);
});

test('azimut et vecteur de nord se correspondent', () => {
  assert.equal(azimuthOf([0, 1]), 0);
  assert.equal(azimuthOf([1, 0]), 90);
  assert.equal(azimuthOf(trueNorthFromAzimuth(-37.5)), -37.5);
});

test('repère du viewer ↔ est-nord-haut : un aller-retour exact, y compris avec un nord tourné', () => {
  const georeference = parseGeoreference({ latitude: 48.8584, longitude: 2.2945, elevation: 35, origin: [100, 50, 10], rotation: 10 })!;
  const offset = [1000, 5, -2000];
  // Un point du viewer : x = 3, y (hauteur) = 7, z = −4  → IFC (1003, 2004, 12).
  const enu = localToEnu([3, 7, -4], offset, georeference);
  // IFC relatif à l'origine : (903, 1954, 2) ; nord tourné de 10° vers l'est.
  const a = (10 * Math.PI) / 180;
  near(enu[0], 903 * Math.cos(a) - 1954 * Math.sin(a), 1e-9);
  near(enu[1], 903 * Math.sin(a) + 1954 * Math.cos(a), 1e-9);
  near(enu[2], 2);
  const back = enuToLocal(enu, offset, georeference);
  near(back[0], 3); near(back[1], 7); near(back[2], -4);
  // Sans rotation ni origine : l'est est +x, le nord est −z, le haut est +y.
  const plain = parseGeoreference({ latitude: 0, longitude: 0 })!;
  assert.deepEqual(localToEnu([1, 2, 3], [0, 0, 0], plain), [1, -3, 2]);
  assert.deepEqual(enuVectorToLocal([0, 1, 0], plain), [0, 0, -1]);
  assert.deepEqual(enuVectorToLocal([0, 0, 1], plain), [0, 1, 0]);
});

test('latitude IFC en degrés, minutes, secondes, millionièmes', () => {
  near(degreesFromIfc([45, 44, 50, 634155])!, 45.747398376, 1e-9);
  near(degreesFromIfc([-4, 41, 25])!, -(4 + 41 / 60 + 25 / 3600));
  assert.equal(degreesFromIfc(null), null);
  assert.equal(degreesFromIfc([1]), null);
});
