import assert from 'node:assert/strict';
import { test } from 'node:test';
import { combineHidden, layerChanges } from '../src/data/viewLayer.ts';

const mask = (...flags: number[]) => Uint8Array.from(flags);

test('les masques de la phase et de la vue se réunissent ; sans rien à masquer, il n’y a pas de couche', () => {
  assert.deepEqual([...combineHidden(4, mask(1, 0, 0, 0), mask(0, 0, 1, 0))!], [1, 0, 1, 0]);
  assert.deepEqual([...combineHidden(3, mask(0, 1, 0), null)!], [0, 1, 0]);
  assert.equal(combineHidden(3), null);
  assert.equal(combineHidden(3, null, undefined), null);
  assert.equal(combineHidden(3, mask(0, 0, 0)), null, 'des masques vides ne masquent rien');
});

test('changer de phase masque le nouveau, réaffiche l’ancien et laisse le reste au choix de l’utilisateur', () => {
  // Avant : la phase masquait 0 et 1 ; après : elle masque 1 et 3.
  const { hide, show } = layerChanges(5, mask(1, 1, 0, 0, 0), mask(0, 1, 0, 1, 0));
  assert.deepEqual(hide, [3], 'nouveau masquage');
  assert.deepEqual(show, [0], 'l’élément que la phase ne masque plus revient');
  // L'élément 4, jamais touché par la phase, n'est dans aucune des deux listes : l'utilisateur l'avait peut-être masqué.
  assert.equal(hide.includes(4) || show.includes(4), false);
  // Rien avant, tout rétabli après : « Vue par défaut ».
  assert.deepEqual(layerChanges(3, mask(1, 0, 1), null), { hide: [], show: [0, 2] });
  assert.deepEqual(layerChanges(3, null, mask(0, 1, 0)), { hide: [1], show: [] });
  assert.deepEqual(layerChanges(3, null, null), { hide: [], show: [] });
  // Une phase qui ne change pas : rien à faire.
  assert.deepEqual(layerChanges(3, mask(0, 1, 0), mask(0, 1, 0)), { hide: [], show: [] });
});
