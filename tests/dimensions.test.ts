import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convexHull, elementDimensions, minimalRectangle } from '../src/engine/dimensions.ts';
import { CUBE, buildFromNodes } from './helpers.ts';

/** Les quatre coins d'un rectangle L × W tourné de `degrees` autour de l'origine, plus des points intérieurs. */
function rotatedRectangle(length: number, width: number, degrees: number): [number, number][] {
  const a = (degrees * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const points: [number, number][] = [];
  for (const [u, v] of [[0, 0], [length, 0], [length, width], [0, width], [length / 2, width / 2], [length / 3, width / 4]] as [number, number][]) {
    points.push([u * cos - v * sin + 10, u * sin + v * cos - 5]);
  }
  return points;
}

test('convexHull garde les coins et écarte les points intérieurs et les doublons', () => {
  const hull = convexHull([...rotatedRectangle(4, 1, 0), [10, -5], [12, -4.5]]);
  assert.equal(hull.length, 4);
  assert.deepEqual(hull[0], [10, -5]);
  assert.equal(convexHull([]).length, 0);
  assert.equal(convexHull([[1, 1], [1, 1]]).length, 1);
});

test('minimalRectangle retrouve longueur et largeur quelle que soit l’orientation', () => {
  for (const degrees of [0, 30, 45, 90, 137]) {
    const { length, width } = minimalRectangle(rotatedRectangle(4, 1, degrees));
    assert.ok(Math.abs(length - 4) < 1e-9 && Math.abs(width - 1) < 1e-9, `${degrees}° : ${length} × ${width}`);
  }
  assert.deepEqual(minimalRectangle([[2, 3]]), { length: 0, width: 0, angle: 0 });
  const line = minimalRectangle([[0, 0], [3, 4]]);
  assert.ok(Math.abs(line.length - 5) < 1e-9 && line.width === 0);
});

test('elementDimensions : cube unité → 1 × 1 × 1, surface 6, volume 1, fermé', async () => {
  const model = await buildFromNodes([{ name: 'A', mesh: 0, extras: { id: 'a' } }], [0], CUBE);
  const dims = elementDimensions(model.parts(0));
  assert.ok(dims);
  assert.ok(Math.abs(dims.length - 1) < 1e-6 && Math.abs(dims.width - 1) < 1e-6 && Math.abs(dims.height - 1) < 1e-6);
  assert.ok(Math.abs(dims.area - 6) < 1e-6, `surface ${dims.area}`);
  assert.ok(Math.abs(dims.volume - 1) < 1e-6, `volume ${dims.volume}`);
  assert.equal(dims.closed, true);
  assert.equal(dims.triangles, 12);
  // Deux cubes côte à côte réunis : empreinte 2 × 1, volume 2.
  const two = await buildFromNodes([{ name: 'A', mesh: 0, extras: { id: 'a' } }, { name: 'B', mesh: 0, translation: [1, 0, 0], extras: { id: 'b' } }], [0, 1], CUBE);
  const both = elementDimensions([...two.parts(0), ...two.parts(1)]);
  assert.ok(both && Math.abs(both.length - 2) < 1e-6 && Math.abs(both.width - 1) < 1e-6 && Math.abs(both.volume - 2) < 1e-6);
  assert.equal(elementDimensions([]), null);
});
