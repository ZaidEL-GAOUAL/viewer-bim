import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Box3, Vector3 } from 'three';
import { workerCount } from '../src/ifc/convertIfc.ts';
import { mergeGlb, mergeMetadata } from '../src/ifc/mergeGlb.ts';
import { CUBE, TRIANGLE, loadGlb, makeGlb } from './helpers.ts';

const material = (rgba: number[]) => ({ pbrMetallicRoughness: { baseColorFactor: rgba } });

// Deux « tranches » comme en produit le convertisseur : nœud 0 = racine, éléments en enfants.
const first = makeGlb(
  [
    { name: 'IFC', children: [1, 2] },
    { name: 'Mur 1', mesh: 0, extras: { id: 'mur-1' } },
    { name: 'Mur 2', mesh: 0, translation: [3, 0, 0], extras: { id: 'mur-2' } },
  ],
  [0],
  CUBE,
  (gltf) => {
    gltf.materials = [material([1, 0, 0, 1])];
    gltf.meshes[0].primitives[0].material = 0;
  },
);
const second = makeGlb(
  [
    { name: 'IFC', children: [1] },
    { name: 'Fenêtre', extras: { id: 'fenetre-1' }, children: [2, 3] },
    { name: 'Cadre', mesh: 0, translation: [6, 0, 0] },
    { name: 'Vitre', mesh: 0, translation: [6, 2, 0] },
  ],
  [0],
  TRIANGLE,
  (gltf) => {
    gltf.materials = [material([0, 0, 1, 1]), material([1, 0, 0, 1])];
    gltf.meshes[0].primitives[0].material = 1;
  },
);

test('mergeGlb réunit les éléments de plusieurs tranches sous une seule racine', async () => {
  const merged = mergeGlb([first, second]);
  const { model } = await loadGlb(merged);
  assert.deepEqual([...model.keys].sort(), ['fenetre-1', 'mur-1', 'mur-2']);
  // 2 cubes (12 triangles chacun) + 2 triangles pour la fenêtre, rattachés à leur élément.
  assert.equal(model.triangleCount, 26);
  const windowIndex = model.keys.indexOf('fenetre-1');
  assert.equal(model.ranges[windowIndex].reduce((sum, range) => sum + range.count, 0), 6);
  // Les positions de la seconde tranche sont intactes : la fenêtre est bien à x = 6.
  const box = model.elementBox(windowIndex, new Box3());
  assert.ok(Math.abs(box.min.x + model.offset.x - 6) < 1e-5);
  assert.ok(Math.abs(box.getSize(new Vector3()).y - 3) < 1e-5);
});

test('mergeGlb met en commun les matériaux identiques', () => {
  const merged = mergeGlb([first, second]);
  const view = new DataView(merged);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(merged, 20, view.getUint32(12, true))));
  assert.equal(view.getUint32(8, true), merged.byteLength);
  assert.equal(json.materials.length, 2); // rouge (commun aux deux tranches) et bleu
  assert.equal(json.nodes.length, 6);
  assert.deepEqual(json.nodes[0].children, [1, 2, 3]);
  assert.deepEqual(json.nodes[3].children, [4, 5]);
  assert.equal(json.buffers[0].byteLength % 4, 0);
});

test('mergeGlb laisse intact un fichier unique, mergeMetadata réunit les éléments', () => {
  assert.equal(mergeGlb([first]), first);
  const merged = JSON.parse(
    mergeMetadata([
      JSON.stringify({ version: 1, elements: { a: { label: 'A' } } }),
      JSON.stringify({ version: 1, elements: { b: { label: 'B' } } }),
    ]),
  );
  assert.deepEqual(merged, { version: 1, elements: { a: { label: 'A' }, b: { label: 'B' } } });
});

test('le nombre de convertisseurs s’adapte au fichier, aux cœurs et à la mémoire', () => {
  const MB = 1e6;
  assert.equal(workerCount(0.5 * MB, 12, 8), 1); // petit fichier : un seul suffit
  assert.equal(workerCount(21 * MB, 12, 8), 4); // machine confortable : plafonné à 4
  assert.equal(workerCount(21 * MB, 4, 8), 3); // un cœur reste pour l'interface
  assert.equal(workerCount(21 * MB, 2, 8), 1);
  assert.equal(workerCount(21 * MB, 8, 4), 2); // 4 Go : la mémoire limite avant les cœurs
  assert.equal(workerCount(200 * MB, 8, 4), 1); // gros fichier sur petite machine
  assert.equal(workerCount(200 * MB, 12, 8), 1);
});

test('un IFC de plus de 100 Mo est refusé d’emblée, avec un message qui dit quoi faire', async () => {
  const { IfcTooLargeError, MAX_IFC_BYTES, convertIfc } = await import('../src/ifc/convertIfc.ts');
  const file = new File([new Uint8Array(MAX_IFC_BYTES + 1)], 'grande-maquette.ifc');
  await assert.rejects(
    convertIfc(file, () => {}),
    (error: unknown) => {
      assert.ok(error instanceof IfcTooLargeError);
      assert.match(error.message, /« grande-maquette\.ifc » \(100 Mo\) dépasse la limite de 100 Mo/);
      assert.match(error.message, /fichier plus léger/);
      return true;
    },
  );
});
