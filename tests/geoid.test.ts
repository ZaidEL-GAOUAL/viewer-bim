import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { GEOID_COLS, GEOID_ROWS, Geoid, parseGeoid } from '../src/geo/geoid.ts';

test('le géoïde interpole entre les nœuds et boucle en longitude', () => {
  const values = new Int16Array(GEOID_ROWS * GEOID_COLS);
  // Hauteur = latitude du nœud (en cm × 100 → en mètres : la latitude elle-même).
  for (let row = 0; row < GEOID_ROWS; row++) for (let col = 0; col < GEOID_COLS; col++) values[row * GEOID_COLS + col] = (row * 0.5 - 90) * 100;
  const geoid = new Geoid(values);
  assert.equal(geoid.height(0, 0), 0);
  assert.equal(geoid.height(48.75, 2.3), 48.75);
  assert.equal(geoid.height(90, 10), 90);
  assert.equal(geoid.height(-90, -179.9), -90);
  assert.equal(geoid.height(10, 190), geoid.height(10, -170));
  assert.throws(() => new Geoid(new Int16Array(3)), /incomplète/);
  assert.throws(() => parseGeoid(new ArrayBuffer(10)), /inattendue/);
});

test('la grille EGM96 livrée donne les hauteurs connues', () => {
  const file = readFileSync(new URL('../public/geo/egm96-0.5deg.int16', import.meta.url));
  const geoid = parseGeoid(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const near = (actual: number, expected: number, tolerance: number) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected} ± ${tolerance}`);
  near(geoid.height(0, 0), 17.16, 0.05);
  near(geoid.height(48.8566, 2.3522), 44.56, 0.5);
  near(geoid.height(45.764, 4.8357), 49.82, 0.5);
  assert.equal(geoid.height(20, 180), geoid.height(20, -180));
});
