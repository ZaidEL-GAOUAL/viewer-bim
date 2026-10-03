import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Box3, Ray, Vector3 } from 'three';
import { boxMesh } from '../src/engine/boxMesh.ts';
import { writeGlb } from '../src/engine/writeGlb.ts';
import { CUBE, buildFromNodes, loadGlb } from './helpers.ts';

const TWO_CUBES = [
  { name: 'A', mesh: 0, extras: { id: 'a' } },
  { name: 'B', mesh: 0, translation: [5, 0, 0], extras: { id: 'b', zone: 'nord' } },
];

test('translate déplace les sommets, les boîtes et ce que touche un rayon', async () => {
  const model = await buildFromNodes(TWO_CUBES, [0, 1], CUBE);
  const before = model.elementBox(1, new Box3());
  model.translate([1], 0, 10, 0);
  const after = model.elementBox(1, new Box3());
  assert.deepEqual(after.min.toArray(), [before.min.x, before.min.y + 10, before.min.z]);
  assert.ok(model.box.max.y >= after.max.y, 'la boîte du modèle suit');
  // Un rayon vertical au-dessus de l'ancienne position de B ne touche plus rien ; au-dessus de la nouvelle, si.
  const center = after.getCenter(new Vector3());
  const miss = model.raycast(new Ray(new Vector3(center.x, before.max.y + 5, center.z), new Vector3(0, -1, 0)));
  assert.ok(miss === null || miss.element !== 1 || miss.point.y > before.max.y + 1);
  const hit = model.raycast(new Ray(new Vector3(center.x, after.max.y + 5, center.z), new Vector3(0, -1, 0)));
  assert.equal(hit?.element, 1);
  assert.ok(Math.abs(hit!.point.y - after.max.y) < 1e-5);
});

test('addElement ajoute une boîte fermée, removeFrom la retire, l’état grandit et rétrécit', async () => {
  const model = await buildFromNodes(TWO_CUBES, [0, 1], CUBE);
  const chunksBefore = model.chunks.length;
  const trianglesBefore = model.triangleCount;
  const mesh = boxMesh({ size: [4, 2.8, 0.2], center: [0, 1.4, 10], rotation: 90 }, model.offset.toArray() as [number, number, number]);
  const index = model.addElement({
    key: 'new-1',
    name: 'Mur provisoire',
    parts: [{ positions: mesh.positions, normals: mesh.normals, colors: new Uint8Array([200, 60, 60, 255]), index: mesh.index, transparent: false, doubleSided: false }],
    closed: true,
  });
  assert.equal(index, 2);
  assert.equal(model.count, 3);
  assert.equal(model.originalCount, 2);
  assert.equal(model.state.count, 3);
  assert.equal(model.state.isVisible(2), true);
  assert.equal(model.state.isOpen(2), false);
  assert.equal(model.chunks.length, chunksBefore + 1);
  assert.equal(model.triangleCount, trianglesBefore + 12);
  // Tournée de 90°, la boîte de 4 m selon X occupe 4 m selon Z, en coordonnées du projet.
  const box = model.elementBox(2, new Box3());
  const size = box.getSize(new Vector3());
  assert.ok(Math.abs(size.x - 0.2) < 1e-5 && Math.abs(size.z - 4) < 1e-5 && Math.abs(size.y - 2.8) < 1e-5, size.toArray().join());
  const centre = box.getCenter(new Vector3()).add(model.offset);
  assert.ok(Math.abs(centre.z - 10) < 1e-5 && Math.abs(centre.y - 1.4) < 1e-5);
  const hit = model.raycast(new Ray(new Vector3(centre.x - model.offset.x, 10, centre.z - model.offset.z), new Vector3(0, -1, 0)));
  assert.equal(hit?.element, 2);
  // La couleur et l'indice d'élément sont écrits par sommet dans le lot ajouté.
  const geometry = model.chunks[chunksBefore].mesh.geometry;
  assert.equal(geometry.getAttribute('color').getX(5), 200 / 255);
  assert.equal(geometry.getAttribute('aElement').getX(0), 2);

  model.removeFrom(2);
  assert.equal(model.count, 2);
  assert.equal(model.chunks.length, chunksBefore);
  assert.equal(model.triangleCount, trianglesBefore);
  assert.equal(model.keys.length, 2);
  model.removeFrom(0);
  assert.equal(model.count, 2, 'les éléments du fichier ne se retirent pas');
});

test('copyParts duplique un élément décalé, avec ses couleurs', async () => {
  const model = await buildFromNodes(TWO_CUBES, [0, 1], CUBE);
  const parts = model.copyParts(0, 0, 0, 20);
  assert.equal(parts.length, 1);
  // Sans normales dans le fichier, le chargement a créé des normales plates : trois sommets par triangle.
  assert.equal(parts[0].positions.length / 3, 36);
  assert.equal(parts[0].index.length, 36);
  const index = model.addElement({ key: 'copy', name: 'A (copie)', parts, closed: true });
  const original = model.elementBox(0, new Box3());
  const copy = model.elementBox(index, new Box3());
  assert.ok(Math.abs(copy.min.z - original.min.z - 20) < 1e-5);
  assert.ok(Math.abs(copy.max.x - original.max.x) < 1e-5);
});

test('writeGlb réécrit un GLB que le viewer recharge, modifications comprises', async () => {
  const model = await buildFromNodes(TWO_CUBES, [0, 1], CUBE);
  model.translate([1], 0, 3, 0);
  const mesh = boxMesh({ size: [1, 1, 1], center: [0, 0.5, -4] }, model.offset.toArray() as [number, number, number]);
  model.addElement({
    key: 'box-1',
    name: 'Réservation',
    extras: { source: 'viewer' },
    parts: [{ positions: mesh.positions, normals: mesh.normals, colors: new Uint8Array([10, 20, 30, 255]), index: mesh.index, transparent: false, doubleSided: false }],
    closed: true,
  });
  const glb = writeGlb(model);
  assert.equal(new DataView(glb).getUint32(0, true), 0x46546c67);
  const jsonLength = new DataView(glb).getUint32(12, true);
  const gltf = JSON.parse(new TextDecoder().decode(new Uint8Array(glb, 20, jsonLength)));
  assert.equal(gltf.nodes.length, 3);
  assert.deepEqual(gltf.nodes.map((node: { extras: { id: string } }) => node.extras.id), ['a', 'b', 'box-1']);
  assert.deepEqual(gltf.nodes[1].extras, { zone: 'nord', id: 'b' });
  assert.deepEqual(gltf.nodes[2].extras, { source: 'viewer', id: 'box-1' });
  assert.equal(gltf.accessors[0].componentType, 5126);
  assert.ok(gltf.meshes[0].primitives[0].attributes.COLOR_0 !== undefined);

  const { model: again, warnings } = await loadGlb(glb);
  assert.deepEqual(warnings, []);
  assert.equal(again.count, 3);
  assert.deepEqual(again.keys, ['a', 'b', 'box-1']);
  assert.deepEqual(again.names, ['A', 'B', 'Réservation']);
  assert.equal(again.triangleCount, model.triangleCount);
  // Les positions dans le repère du projet sont conservées (décalage compris).
  for (let i = 0; i < 3; i++) {
    const a = model.elementBox(i, new Box3()).translate(model.offset);
    const b = again.elementBox(i, new Box3()).translate(again.offset);
    assert.ok(a.min.distanceTo(b.min) < 1e-4 && a.max.distanceTo(b.max) < 1e-4, `élément ${i}`);
  }
  assert.equal(again.state.isOpen(2), false, 'la boîte reste un solide fermé');
});
