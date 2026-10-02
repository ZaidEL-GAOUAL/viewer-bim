import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ray, Vector3 } from 'three';
import { BLOCK_TRIANGLES, buildBlocks } from '../src/engine/triangleBlocks.ts';
import { buildFromNodes, type TestMesh } from './helpers.ts';

/** Terrain ondulé de `n` × `n` carreaux, soit 2 n² triangles. */
function terrain(n: number): TestMesh {
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const at = (j * (n + 1) + i) * 3;
      positions[at] = (i / n) * 10;
      positions[at + 1] = Math.sin(i * 0.31) * Math.cos(j * 0.23) * 0.8;
      positions[at + 2] = (j / n) * 10;
    }
  }
  const indices = new Uint32Array(n * n * 6);
  let k = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
      indices.set([a, c, b, b, c, d], k);
      k += 6;
    }
  }
  return { positions, indices };
}

const key = (a: number, b: number, c: number) => [a, b, c].sort((x, y) => x - y).join(',');

test('buildBlocks conserve tous les triangles et borne chaque bloc', () => {
  const { positions, indices } = terrain(80);
  const index = Uint32Array.from(indices!);
  const before = new Map<string, number>();
  for (let k = 0; k < index.length; k += 3) {
    const id = key(index[k], index[k + 1], index[k + 2]);
    before.set(id, (before.get(id) ?? 0) + 1);
  }

  const boxes = buildBlocks(positions, index, 0, index.length);
  assert.ok(boxes);
  assert.equal(boxes.length / 6, Math.ceil(index.length / 3 / BLOCK_TRIANGLES));

  for (let k = 0; k < index.length; k += 3) {
    const id = key(index[k], index[k + 1], index[k + 2]);
    before.set(id, (before.get(id) ?? 0) - 1);
    const at = Math.floor(k / 3 / BLOCK_TRIANGLES) * 6;
    for (let corner = 0; corner < 3; corner++) {
      const v = index[k + corner] * 3;
      for (let axis = 0; axis < 3; axis++) {
        assert.ok(positions[v + axis] >= boxes[at + axis] && positions[v + axis] <= boxes[at + 3 + axis]);
      }
    }
  }
  assert.ok([...before.values()].every((count) => count === 0), 'chaque triangle doit être présent une seule fois');

  // Les blocs doivent être compacts en moyenne : bien plus petits que le terrain de 10 m de côté.
  // (Quelques blocs à cheval sur un saut de la courbe de Morton peuvent rester étendus.)
  let total = 0;
  for (let at = 0; at < boxes.length; at += 6) total += Math.max(boxes[at + 3] - boxes[at], boxes[at + 5] - boxes[at + 2]);
  const mean = total / (boxes.length / 6);
  assert.ok(mean < 3, `blocs trop étendus en moyenne : ${mean}`);
});

test('buildBlocks ne touche pas aux petites plages', () => {
  const { positions, indices } = terrain(10);
  const index = Uint32Array.from(indices!);
  assert.equal(buildBlocks(positions, index, 0, index.length), null);
  assert.deepEqual(index, indices);
});

test('le lancer de rayon avec blocs donne le même résultat que le test exhaustif', async () => {
  const model = await buildFromNodes([{ name: 'Terrain', mesh: 0, extras: { id: 'terrain' } }], [0], terrain(120));
  assert.equal(model.triangleCount, 28800);
  const range = model.ranges[0][0];
  assert.ok(range.blocks, 'un élément de 28 800 triangles doit avoir des blocs');

  // Référence : même lancer, sans les blocs.
  const reference = (ray: Ray) => {
    const blocks = range.blocks;
    range.blocks = null;
    const hit = model.raycast(ray);
    range.blocks = blocks;
    return hit;
  };

  let seed = 12345;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  let hits = 0;
  for (let i = 0; i < 400; i++) {
    const origin = new Vector3((random() - 0.5) * 16, 2 + random() * 6, (random() - 0.5) * 16);
    const target = new Vector3((random() - 0.5) * 10, 0, (random() - 0.5) * 10);
    const ray = new Ray(origin, target.sub(origin).normalize());
    const fast = model.raycast(ray);
    const slow = reference(ray);
    assert.equal(fast === null, slow === null);
    if (fast && slow) {
      hits++;
      assert.ok(Math.abs(fast.distance - slow.distance) < 1e-9);
      assert.ok(fast.point.distanceTo(slow.point) < 1e-9);
    }
  }
  assert.ok(hits > 300);
});
