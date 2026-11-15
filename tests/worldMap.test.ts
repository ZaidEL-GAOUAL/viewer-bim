import assert from 'node:assert/strict';
import { test } from 'node:test';
import { wheelLevels } from '../src/site/WorldMap.ts';

test('the world map zooms by the wheel’s distance: a trackpad gesture of many small steps is not 17 levels', () => {
  // Un cran de souris : un demi-niveau, vers l'avant on rapproche.
  assert.equal(wheelLevels(-100), 0.5);
  assert.equal(wheelLevels(100), -0.5);
  // Un geste de pavé tactile : 34 petits pas de 3 px (l'ancien code y voyait 34 demi-niveaux).
  const gesture = Array.from({ length: 34 }, () => wheelLevels(-3)).reduce((sum, step) => sum + step, 0);
  assert.ok(gesture > 0 && gesture < 1, `${gesture} level(s)`);
  // En lignes (Firefox) ou en pages : jamais plus d'un niveau par événement.
  assert.equal(wheelLevels(-3, 1), 0.6);
  assert.equal(wheelLevels(-1, 2), 1);
  assert.equal(wheelLevels(5000), -1);
});
