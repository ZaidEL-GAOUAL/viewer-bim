import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STANDARD_VIEWS, VIEW_ORDER } from '../src/engine/views.ts';

test('chaque vue standard regarde selon un axe, avec un haut perpendiculaire', () => {
  assert.equal(VIEW_ORDER.length, 6);
  const labels = new Set<string>();
  for (const id of VIEW_ORDER) {
    const view = STANDARD_VIEWS[id];
    labels.add(view.label);
    assert.ok(Math.abs(view.direction.length() - 1) < 1e-9, `${id} : direction unitaire`);
    assert.ok(Math.abs(view.up.length() - 1) < 1e-9, `${id} : haut unitaire`);
    assert.ok(Math.abs(view.direction.dot(view.up)) < 1e-9, `${id} : haut perpendiculaire à la direction`);
    assert.equal(view.direction.toArray().filter((v) => v !== 0).length, 1, `${id} : un seul axe`);
  }
  assert.equal(labels.size, 6);
  // Face et arrière se font face ; le plan (haut) garde le nord du projet (−Z) en haut de l'écran.
  assert.equal(STANDARD_VIEWS.front.direction.dot(STANDARD_VIEWS.back.direction), -1);
  assert.deepEqual(STANDARD_VIEWS.top.up.toArray(), [0, 0, -1]);
  assert.deepEqual(STANDARD_VIEWS.top.direction.toArray(), [0, 1, 0]);
});
