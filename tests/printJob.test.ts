import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Vector3 } from 'three';
import { planSectionBox, type SavedView } from '../src/data/savedViews.ts';
import { frameRect, sheetOf } from '../src/data/sheet.ts';
import { Sections } from '../src/engine/Sections.ts';
import { framing, visibleBox, type ViewRect } from '../src/ui/printJob.ts';

type Box = [number, number, number, number, number, number];

/** A model reduced to what `visibleBox` reads: element boxes and whether each is drawn. */
function model(boxes: Box[], hidden: number[] = []) {
  return { count: boxes.length, boxes: Float32Array.from(boxes.flat()), state: { isRendered: (index: number) => !hidden.includes(index) } };
}

// A floor plan: looking down, north (−Z of the viewer) at the top of the sheet.
const right = new Vector3(1, 0, 0), up = new Vector3(0, 0, -1);

const SLAB: Box = [0, 0, 0, 20, 0.3, 10];
const SOUTH_WALL: Box = [0, 0, 0, 20, 3, 0.2];
const NORTH_WALL: Box = [0, 0, 9.8, 20, 3, 10];
/** The upper floor overhangs the ground floor on every side. */
const UPPER: Box = [-30, 6, -20, 50, 6.3, 30];
const NO_GEOMETRY: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
const building = [SLAB, SOUTH_WALL, NORTH_WALL, UPPER, NO_GEOMETRY];

function close(actual: ViewRect | null, expected: ViewRect, tolerance = 1e-5): void {
  assert.ok(actual, 'something is visible');
  for (const key of ['minX', 'maxX', 'minY', 'maxY'] as const) assert.ok(Math.abs(actual[key] - expected[key]) <= tolerance, `${key}: ${actual[key]} ≠ ${expected[key]}`);
}

/** The sections of a plan view opened by the app: its box from the plan's range (and crop), as `App.openView` sets it. */
function planSections(view: Pick<SavedView, 'range' | 'sectionBox'>, boxes: Box[]): Sections {
  const sections = new Sections();
  const solid = boxes.filter((box) => box[0] <= box[3]);
  const min: [number, number, number] = [0, 1, 2].map((axis) => Math.min(...solid.map((box) => box[axis]))) as [number, number, number];
  const max: [number, number, number] = [3, 4, 5].map((axis) => Math.max(...solid.map((box) => box[axis]))) as [number, number, number];
  sections.setBox(planSectionBox(view, [0, 0, 0], { min, max }));
  return sections;
}

test('the visible box leaves hidden elements out', () => {
  const ANNEX: Box = [20, 0, 0, 26, 1, 5];
  const boxes = [SLAB, SOUTH_WALL, NORTH_WALL, ANNEX];
  close(visibleBox(model(boxes), new Sections(), right, up), { minX: 0, maxX: 26, minY: -10, maxY: 0 });
  close(visibleBox(model(boxes, [3]), new Sections(), right, up), { minX: 0, maxX: 20, minY: -10, maxY: 0 });
});

test('the visible box honours the plan range: what lies above the cut or below the view depth is not shown', () => {
  // Ground floor: cut at 1.2 m, the upper floor's overhang does not stretch the page.
  close(visibleBox(model(building), planSections({ range: { bottom: 0, top: 1.2 } }, building), right, up), { minX: 0, maxX: 20, minY: -10, maxY: 0 });
  // Upper floor: the ground floor lies below the view depth.
  close(visibleBox(model(building), planSections({ range: { bottom: 6, top: 7.2 } }, building), right, up), { minX: -30, maxX: 50, minY: -30, maxY: 20 });
});

test('the visible box stops at the crop of the plan', () => {
  const view = { range: { bottom: 0, top: 1.2 }, sectionBox: { min: [0, -100, 0] as [number, number, number], max: [10, 100, 10] as [number, number, number], rotation: 0 } };
  close(visibleBox(model(building), planSections(view, building), right, up), { minX: 0, maxX: 10, minY: -10, maxY: 0 });
  // A crop turned by 45°: its shadow on each axis is ± 5·√2.
  const turned = { range: { bottom: 0, top: 1.2 }, sectionBox: { min: [-5, -100, -5] as [number, number, number], max: [5, 100, 5] as [number, number, number], rotation: 45 } };
  const wide: Box[] = [[-20, 0, -20, 20, 0.3, 20]];
  const reach = 5 * Math.SQRT2;
  close(visibleBox(model(wide), planSections(turned, wide), right, up), { minX: -reach, maxX: reach, minY: -reach, maxY: reach });
});

test('an element lost far from the building does not stretch the page', () => {
  const boxes: Box[] = [];
  for (let i = 0; i < 120; i++) {
    const x = (i % 10) * 1.9, z = Math.floor(i / 10) * 1.9;
    boxes.push([x, 0, z, x + 1, 3, z + 1]);
  }
  boxes.push([2000, 0, 2000, 2001, 1, 2001]);
  close(visibleBox(model(boxes), new Sections(), right, up), { minX: 0, maxX: 18.1, minY: -21.9, maxY: 0 });
  // A second wing next to the first is part of the building.
  const wing = boxes.slice(0, 120).map(([x0, y0, z0, x1, y1, z1]): Box => [x0 + 25, y0, z0, x1 + 25, y1, z1]);
  close(visibleBox(model([...boxes.slice(0, 120), ...wing]), new Sections(), right, up), { minX: 0, maxX: 43.1, minY: -21.9, maxY: 0 });
});

test('a small model keeps every element: five centres at -10, 0, 0.1, 0.2 and 10 m all fit on the page', () => {
  const boxes: Box[] = [-10, 0, 0.1, 0.2, 10].map((x) => [x - 0.05, 0, 0, x + 0.05, 1, 0.1]);
  close(visibleBox(model(boxes), new Sections(), right, up), { minX: -10.05, maxX: 10.05, minY: -0.1, maxY: 0 });
});

test('on a large model the bounds are read on a sample, and the edge elements it skipped are kept', () => {
  // 70 000 elements on a 280 × 250 grid: every other centre is sampled, the last column (odd index) is not.
  const boxes: Box[] = [];
  for (let i = 0; i < 70_000; i++) {
    const x = (i % 280) * 0.1, z = Math.floor(i / 280) * 0.1;
    boxes.push([x, 0, z, x + 0.05, 3, z + 0.05]);
  }
  boxes.push([5000, 0, 5000, 5001, 1, 5001]);
  close(visibleBox(model(boxes), new Sections(), right, up), { minX: 0, maxX: 27.95, minY: -24.95, maxY: 0 }, 1e-4);
});

test('a view with nothing visible is reported empty', () => {
  assert.equal(visibleBox(model(building), planSections({ range: { bottom: 20, top: 21.2 } }, building), right, up), null);
  assert.equal(visibleBox(model(building, [0, 1, 2, 3]), new Sections(), right, up), null);
  assert.equal(visibleBox(model([]), new Sections(), right, up), null);
});

test('the page is centred on what the view shows, at the largest scale that holds it', () => {
  const sheet = sheetOf('A3', true, 10);
  const box = { minX: 2, maxX: 32, minY: -5, maxY: 15 };
  const fit = framing(box, sheet, null);
  assert.deepEqual(fit, { centre: [17, 5], scale: 100, fits: true });
  const shown = frameRect(sheet, fit.scale, fit.centre!);
  assert.ok(shown.minX <= box.minX && shown.maxX >= box.maxX && shown.minY <= box.minY && shown.maxY >= box.maxY, 'the whole box is on the sheet');
  // Fixed scale: same centre, and the dialog is told it does not hold.
  assert.deepEqual(framing(box, sheet, 50), { centre: [17, 5], scale: 50, fits: false });
  assert.equal(framing(null, sheet, null).centre, null);
});
