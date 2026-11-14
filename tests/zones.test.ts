import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assignZones, parseZones, zonesToJson } from '../src/data/zones.ts';

type Point = [number, number];
const square = (x: number, y: number, size: number): Point[] => [[x, y], [x + size, y], [x + size, y + size], [x, y + size]];

test('an element goes to the zone holding the largest share of its footprint', () => {
  const west = square(0, 0, 10), east = square(10, 0, 10);
  const footprints = [square(2, 2, 2), square(30, 30, 2), square(9, 2, 2), square(8, 2, 3), null];
  // Inside, outside, half and half (the first zone wins a tie), mostly west, no geometry.
  assert.deepEqual(assignZones(footprints, [west, east]), [0, -1, 0, 0, -1]);
  assert.deepEqual(assignZones([square(9.5, 2, 2)], [west, east]), [1], 'three quarters east');
});

test('a concave zone holds only what is inside its outline, not its hull', () => {
  // An L: the notch (x > 5, y > 5) is outside.
  const ell: Point[] = [[0, 0], [10, 0], [10, 5], [5, 5], [5, 10], [0, 10]];
  assert.deepEqual(assignZones([square(7, 7, 2), square(1, 7, 2), square(4, 4, 2)], [ell]), [-1, 0, 0]);
  // A footprint seen as a line goes by its centre.
  assert.deepEqual(assignZones([[[1, 1], [2, 1]], [[7, 7], [8, 7]]], [ell]), [0, -1]);
});

test('the zones section reads back what it writes, and skips unreadable entries', () => {
  const zones = parseZones([{ name: 'A', points: [[0, 0, 0], [1, 0, 0], [1, 0, -1]] }, { name: '', points: [] }, { name: 'B', points: [[0, 0, 0]] }]);
  assert.deepEqual(zones.map((zone) => zone.name), ['A']);
  assert.deepEqual(parseZones(zonesToJson(zones)), zones);
});
