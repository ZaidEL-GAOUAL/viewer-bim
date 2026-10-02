import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import { buildFromNodes as build } from './helpers.ts';

test('sans extras.id, chaque nœud portant un maillage devient un élément nommé d’après le nœud', async () => {
  const model = await build(
    [
      { name: 'Mur A', mesh: 0, extras: { Type: 'Mur', Niveau: 'RDC' } },
      { name: 'Mur B', mesh: 0, translation: [5, 0, 0] },
      { name: 'Groupe', children: [3] },
      { name: 'Dalle', mesh: 0, translation: [0, 3, 0] },
    ],
    [0, 1, 2],
  );
  assert.deepEqual(model.keys, ['Mur A', 'Mur B', 'Dalle']);
  // Les autres champs `extras` servent de propriétés quand aucun JSON n'est fourni.
  assert.deepEqual(model.extras, [{ Type: 'Mur', Niveau: 'RDC' }, undefined, undefined]);
  assert.equal(model.triangleCount, 3);
  // Un triangle isolé n'est pas un solide fermé : il est exclu du remplissage des coupes.
  assert.equal(model.state.isOpen(0), true);
});

test('avec extras.id, les nœuds enfants sans identifiant appartiennent à l’élément parent', async () => {
  const model = await build(
    [
      { name: 'Fenêtre', extras: { id: 42, Type: 'Fenêtre' }, children: [1, 2] },
      { name: 'Cadre', mesh: 0 },
      { name: 'Vitrage', mesh: 0, translation: [0, 0, 1] },
      { name: 'Sans identifiant', mesh: 0, translation: [3, 0, 0] },
    ],
    [0, 3],
  );
  assert.deepEqual(model.keys, ['42', 'Sans identifiant']);
  assert.deepEqual(model.names, ['Fenêtre', 'Sans identifiant']);
  assert.deepEqual(model.extras[0], { Type: 'Fenêtre' });
  assert.equal(model.ranges[0].reduce((sum, range) => sum + range.count, 0), 6);
});

test('un modèle géoréférencé est recentré sans perte de précision', async () => {
  const far = [651234.5, 0, 6861234.25];
  const model = await build(
    [
      { name: 'A', mesh: 0, translation: far, extras: { id: 'a' } },
      { name: 'B', mesh: 0, translation: [far[0] + 10, 0, far[2]], extras: { id: 'b' } },
    ],
    [0, 1],
  );
  assert.ok(Math.abs(model.offset.x - (far[0] + 5.5)) < 1e-6);
  assert.ok(model.box.getCenter(new Vector3()).length() < 1e-3);
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  model.triangle(model.ranges[0][0].chunk, model.ranges[0][0].start, a, b, c);
  // Le côté du triangle mesure exactement 1 m, malgré des coordonnées d'origine à plus de 6 000 km.
  assert.ok(Math.abs(a.distanceTo(b) - 1) < 1e-6);
  assert.ok(Math.abs(model.elementBox(1, model.box.clone()).min.x - model.elementBox(0, model.box.clone()).min.x - 10) < 1e-6);
});

test('un fichier sans triangle est refusé avec un message clair', async () => {
  await assert.rejects(build([{ name: 'Vide' }], [0]), /aucune géométrie/);
});
