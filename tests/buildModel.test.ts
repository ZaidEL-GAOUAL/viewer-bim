import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Box3, Color, Ray, Vector3 } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildModel } from '../src/engine/buildModel.ts';
import { FLAG_OPEN } from '../src/engine/elementState.ts';
import { analyzeSolid } from '../src/engine/meshMath.ts';
import type { Model } from '../src/engine/Model.ts';
import { parseMetadata } from '../src/data/metadata.ts';

const samples = new URL('../public/samples/', import.meta.url);

async function loadDemo(): Promise<Model> {
  const file = readFileSync(new URL('demo.glb', samples));
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  return buildModel(gltf, { value: new Color(0x2f7dea) });
}

const model = await loadDemo();
const metadata = parseMetadata(JSON.parse(readFileSync(new URL('demo.json', samples), 'utf8')));
const find = (name: string) => model.names.indexOf(name);
const near = (actual: number, expected: number, tolerance = 1e-3) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

test('chaque nœud identifié devient un élément relié à ses métadonnées', () => {
  assert.equal(model.count, 220);
  assert.equal(new Set(model.keys).size, 220);
  const matched = model.keys.filter((key) => metadata.elements.has(key)).length;
  assert.equal(matched, 219);
});

test('la géométrie est fusionnée en quelques lots et recentrée', () => {
  assert.ok(model.chunks.length <= 4, `${model.chunks.length} lots`);
  assert.ok(model.chunks.some((chunk) => chunk.transparent));
  const center = model.box.getCenter(new Vector3());
  assert.ok(center.length() < 0.5, 'le modèle doit être centré sur l’origine');
  near(model.offset.x, 10, 0.5);
});

test('les transformations des nœuds sont cuites dans les sommets', () => {
  const wall = find('Mur pignon ouest');
  const size = model.elementBox(wall, new Box3()).getSize(new Vector3());
  near(size.x, 0.2);
  near(size.y, 2.75);
  near(size.z, 11.8);
  const info = analyzeSolid(model.parts(wall));
  near(info.volume, 0.2 * 2.75 * 11.8);
  assert.equal(info.closed, true);
});

test('volume d’un poteau cylindrique', () => {
  const column = model.names.findIndex((name) => name.startsWith('Poteau'));
  const info = analyzeSolid(model.parts(column));
  // Section : polygone régulier à 24 côtés inscrit dans un cercle de rayon 0,2.
  near(info.volume, 12 * 0.04 * Math.sin(Math.PI / 12) * 2.75);
  assert.equal(info.closed, true);
});

test('un élément posé en miroir garde ses faces orientées vers l’extérieur', () => {
  let checked = 0;
  for (let i = 0; i < model.count; i++) {
    if (!model.names[i].startsWith('Porte')) continue;
    const center = model.elementBox(i, new Box3()).getCenter(new Vector3());
    const a = new Vector3(), b = new Vector3(), c = new Vector3();
    for (const range of model.ranges[i]) {
      for (let k = range.start; k < range.start + range.count; k += 3) {
        model.triangle(range.chunk, k, a, b, c);
        const centroid = a.clone().add(b).add(c).divideScalar(3);
        const normal = b.clone().sub(a).cross(c.clone().sub(a));
        assert.ok(normal.dot(centroid.sub(center)) > 0, `face retournée sur ${model.names[i]}`);
        checked++;
      }
    }
  }
  assert.equal(checked, 6 * 12);
});

test('une fenêtre est un seul élément réparti sur deux matériaux', () => {
  const window = model.names.findIndex((name) => name.startsWith('Fenêtre'));
  const chunks = new Set(model.ranges[window].map((range) => range.chunk));
  assert.equal(chunks.size, 2);
  const triangles = model.ranges[window].reduce((sum, range) => sum + range.count / 3, 0);
  assert.equal(triangles, 5 * 12);
  assert.equal(model.state.data[window * 4 + 3] & FLAG_OPEN, 0);
});

test('le lancer de rayon trouve l’élément le plus proche', () => {
  const down = new Ray(new Vector3(0, 50, 0), new Vector3(0, -1, 0));
  const hit = model.raycast(down);
  assert.ok(hit);
  assert.equal(model.names[hit.element], 'Toiture-terrasse');
  near(hit.point.y + model.offset.y, 9.05);
  near(hit.normal.y, 1);
  near(hit.distance, 50 - hit.point.y);
  assert.equal(hit.backface, false);

  // Depuis l'intérieur de la toiture, l'envers de sa face supérieure n'est pas affiché :
  // le rayon ne le touche pas, sauf quand une section remplie rend l'intérieur visible.
  const inside = new Ray(new Vector3(0, hit.point.y - 0.1, 0), new Vector3(0, 1, 0));
  assert.equal(model.raycast(inside), null);
  const through = model.raycast(inside, { capBackfaces: true });
  assert.ok(through);
  assert.equal(through.backface, true);
  near(through.normal.y, -1);
  assert.equal(model.raycast(inside, { capBackfaces: true, minDistance: through.distance }), null);
});

test('le lancer de rayon ignore les éléments masqués et les points coupés', () => {
  const down = new Ray(new Vector3(0, 50, 0), new Vector3(0, -1, 0));
  const roof = find('Toiture-terrasse');
  model.state.setVisible(roof, false);
  const below = model.raycast(down);
  assert.ok(below);
  assert.equal(model.names[below.element], 'Dalle R+2');
  model.state.setVisible(roof, true);

  const cutHeight = 7 - model.offset.y;
  const cut = model.raycast(down, { clipped: (_x, y) => y > cutHeight });
  assert.ok(cut);
  assert.equal(model.names[cut.element], 'Dalle R+2');

  assert.equal(model.raycast(new Ray(new Vector3(500, 50, 0), new Vector3(0, -1, 0))), null);
});

test('un rayon parallèle à un axe et tangent aux boîtes ne casse pas le filtrage', () => {
  const box = model.elementBox(find('Toiture-terrasse'), new Box3());
  const ray = new Ray(new Vector3(box.min.x, 50, 0), new Vector3(0, -1, 0));
  const hit = model.raycast(ray);
  assert.ok(hit);
});
