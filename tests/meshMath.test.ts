import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeSolid, coplanarRegion, isClosed, type MeshPart } from '../src/engine/meshMath.ts';

/** Boîte à 24 sommets (faces non partagées), comme dans un export à arêtes vives. */
function box(sx: number, sy: number, sz: number, ox = 0, oy = 0, oz = 0): MeshPart {
  const positions: number[] = [];
  const index: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [1, 0, 0], [0, 0, -1]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],
    [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
  ];
  for (const [n, u, v] of faces) {
    const base = positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(
        ox + 0.5 * sx * (n[0] + su * u[0] + sv * v[0]),
        oy + 0.5 * sy * (n[1] + su * u[1] + sv * v[1]),
        oz + 0.5 * sz * (n[2] + su * u[2] + sv * v[2]),
      );
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions: new Float32Array(positions), index: new Uint16Array(index), start: 0, count: index.length };
}

const near = (actual: number, expected: number, tolerance = 1e-4) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

test('volume et surface d’une boîte', () => {
  const info = analyzeSolid([box(2, 3, 4)]);
  near(info.volume, 24);
  near(info.area, 2 * (6 + 12 + 8));
  assert.equal(info.closed, true);
  assert.equal(info.triangles, 12);
});

test('le volume ne dépend pas de la position (modèle loin de l’origine)', () => {
  near(analyzeSolid([box(2, 3, 4, 5000, 120, -8000)]).volume, 24, 0.05);
});

test('une boîte sans couvercle n’est pas fermée', () => {
  const part = box(1, 1, 1);
  const open: MeshPart = { ...part, start: 6, count: part.count - 6 };
  assert.equal(isClosed([open]), false);
  assert.equal(isClosed([part]), true);
});

test('une face retournée rend le maillage incohérent', () => {
  const part = box(1, 1, 1);
  const index = Uint16Array.from(part.index);
  [index[1], index[2]] = [index[2], index[1]];
  assert.equal(isClosed([{ ...part, index }]), false);
});

test('deux parties forment ensemble un solide fermé', () => {
  const part = box(1, 2, 1);
  const a: MeshPart = { ...part, start: 0, count: 18 };
  const b: MeshPart = { ...part, start: 18, count: 18 };
  assert.equal(isClosed([a]), false);
  assert.equal(analyzeSolid([a, b]).closed, true);
  near(analyzeSolid([a, b]).volume, 2);
});

test('coplanarRegion renvoie la face entière autour d’un triangle', () => {
  const part = box(2, 3, 4);
  // Les triangles 4 et 5 (index 12 à 17) forment la face du dessus (+Y) : 2 × 4.
  const top = coplanarRegion([part], 0, 12);
  assert.ok(top);
  near(top.area, 8);
  assert.deepEqual(top.normal.map((n) => Math.round(n) + 0), [0, 1, 0]);
  near(top.centroid[1], 1.5);
  assert.equal(top.positions.length, 18);

  const side = coplanarRegion([part], 0, 3);
  assert.ok(side);
  near(side.area, 12);
});

test('coplanarRegion ne relie pas deux faces coplanaires disjointes', () => {
  const a = box(1, 1, 1, 0, 0, 0);
  const b = box(1, 1, 1, 5, 0, 0);
  const region = coplanarRegion([a, b], 0, 12);
  assert.ok(region);
  near(region.area, 1);
});

test('coplanarRegion refuse un triangle absent ou dégénéré', () => {
  const part = box(1, 1, 1);
  assert.equal(coplanarRegion([part], 0, 13), null);
  const flat: MeshPart = { positions: new Float32Array(9), index: new Uint16Array([0, 1, 2]), start: 0, count: 3 };
  assert.equal(coplanarRegion([flat], 0, 0), null);
});
