import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PAPERS, clipSegment, frameOnScreen, frameRect, mmOf, nextPaperThatFits, northAngle, pageScale, paperSize, parseScale, scaleBar, sheetOf, suggestScale, tilePlacement, titleBlockCells, worldSize, fits, flowLayout, wrapText } from '../src/data/sheet.ts';

const close = (actual: number, expected: number, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ≠ ${expected}`);

test('paper sizes follow ISO 216 in both orientations', () => {
  assert.deepEqual(paperSize('A4', false), { width: 210, height: 297 });
  assert.deepEqual(paperSize('A3', true), { width: 420, height: 297 });
  assert.deepEqual(paperSize('A0', true), { width: 1189, height: 841 });
});

test('A3 landscape with 10 mm margins: the frame leaves room for the title block', () => {
  const sheet = sheetOf('A3', true, 10);
  assert.deepEqual(sheet.frame, { x: 10, y: 10, width: 400, height: 249 });
  assert.deepEqual(sheet.titleBlock, { x: 10, y: 259, width: 400, height: 28 });
});

test('at 1:100 on A3 landscape a 20 m wide plan fits and 1 m is 10 mm', () => {
  const sheet = sheetOf('A3', true, 10);
  close(mmOf(1, 100), 10);
  close(mmOf(20, 100), 200);
  const world = worldSize(sheet, 100);
  close(world.width, 40);
  close(world.height, 24.9);
  assert.equal(fits(sheet, 100, { width: 20, height: 15 }), true);
  assert.equal(fits(sheet, 100, { width: 41, height: 10 }), false);
});

test('the framed model rectangle is centred on the view centre', () => {
  const rect = frameRect(sheetOf('A3', true, 10), 100, [10, 5]);
  close(rect.minX, -10);
  close(rect.maxX, 30);
  close(rect.minY, 5 - 12.45);
  close(rect.maxY, 5 + 12.45);
});

test('a plan too large for the paper reports the next paper size that holds it', () => {
  const sheet = sheetOf('A3', true, 10);
  assert.equal(nextPaperThatFits(sheet, 100, { width: 20, height: 10 }), 'A3');
  assert.equal(nextPaperThatFits(sheet, 100, { width: 50, height: 20 }), 'A2');
  assert.equal(nextPaperThatFits(sheet, 100, { width: 200, height: 20 }), null);
});

test('the suggested scale is the largest standard one that fits', () => {
  const sheet = sheetOf('A3', true, 10);
  assert.equal(suggestScale(sheet, { width: 30, height: 20 }), 100);
  assert.equal(suggestScale(sheet, { width: 7, height: 4 }), 20);
  assert.equal(suggestScale(sheet, { width: 500, height: 20 }), null);
});

test('fit to page: the largest standard scale that holds a 30 × 20 m box, on each paper', () => {
  // Landscape frames: A4 277 × 162, A3 400 × 249, A2 574 × 372, A1 821 × 546, A0 1169 × 793 mm.
  const expected = { A4: 200, A3: 100, A2: 100, A1: 50, A0: 50 };
  for (const paper of PAPERS) {
    const sheet = sheetOf(paper, true, 10);
    assert.deepEqual(pageScale(sheet, { width: 30, height: 20 }, null), { scale: expected[paper], fits: true }, paper);
  }
  // A fixed scale is kept, and says whether the box holds.
  assert.deepEqual(pageScale(sheetOf('A3', true, 10), { width: 30, height: 20 }, 50), { scale: 50, fits: false });
  assert.deepEqual(pageScale(sheetOf('A3', true, 10), { width: 30, height: 20 }, 200), { scale: 200, fits: true });
});

test('a box larger than A0 at the smallest scale is reported', () => {
  const box = { width: 700, height: 500 };
  // Fit to page falls back on the smallest standard scale and says it does not hold, on any paper.
  assert.deepEqual(pageScale(sheetOf('A0', true, 10), box, null), { scale: 500, fits: false });
  assert.equal(nextPaperThatFits(sheetOf('A4', true, 10), 500, box), null);
});

test('typed scales: 1:75, 75 and 1/75 mean the same', () => {
  assert.equal(parseScale('1:75'), 75);
  assert.equal(parseScale(' 75 '), 75);
  assert.equal(parseScale('1/75'), 75);
  assert.equal(parseScale('0'), null);
  assert.equal(parseScale('abc'), null);
  assert.equal(parseScale('2:1'), null);
});

test('the scale bar picks a round length that fits the room', () => {
  assert.deepEqual(scaleBar(100, 100), { metres: 10, mm: 100, divisions: 5 });
  assert.deepEqual(scaleBar(100, 90), { metres: 5, mm: 50, divisions: 5 });
  assert.deepEqual(scaleBar(50, 60), { metres: 2, mm: 40, divisions: 4 });
});

test('segments are clipped to the frame', () => {
  const frame = { x: 0, y: 0, width: 10, height: 10 };
  assert.deepEqual(clipSegment(2, 2, 8, 8, frame), [2, 2, 8, 8]);
  assert.equal(clipSegment(-5, -5, -1, -1, frame), null);
  assert.deepEqual(clipSegment(-5, 5, 5, 5, frame), [0, 5, 5, 5]);
  assert.deepEqual(clipSegment(5, 5, 20, 5, frame), [5, 5, 10, 5]);
});

test('a tile in pixels lands in millimetres on the frame', () => {
  const frame = { x: 10, y: 10, width: 400, height: 200 };
  // 4000 x 2000 px over 400 x 200 mm: 10 px per mm.
  const placed = tilePlacement({ x: 2048, y: 0, width: 1952, height: 2000 }, frame, { width: 4000, height: 2000 });
  close(placed.x, 10 + 204.8);
  close(placed.y, 10);
  close(placed.width, 195.2);
  close(placed.height, 200);
  const overlap = tilePlacement({ x: 0, y: 0, width: 2048, height: 2000 }, frame, { width: 4000, height: 2000 }, 0.05);
  close(overlap.width, 204.8 + 0.05);
  close(overlap.height, 200, 1e-9);
});

test('the north arrow turns with the view', () => {
  // Looking down, page up = −Z of the viewer frame, page right = +X: the model's +Y (north) points up.
  close(northAngle([0, 0, -1], [1, 0, 0], [0, 0, -1]), 0);
  // The view rotated a quarter turn: north now points to the page's right.
  close(northAngle([0, 0, -1], [0, 0, -1], [1, 0, 0]), 90);
  close(northAngle([1, 0, 0], [1, 0, 0], [0, 0, -1]), 90);
});

test('the framed area on screen is centred and says when it overflows', () => {
  const inside = frameOnScreen({ width: 40, height: 24.9 }, 50, { width: 1000, height: 500 });
  close(inside.height, 249);
  close(inside.width, 400);
  close(inside.x, 300);
  close(inside.y, 125.5);
  assert.equal(inside.overflow, false);
  assert.equal(frameOnScreen({ width: 400, height: 24.9 }, 50, { width: 1000, height: 500 }).overflow, true);
});

test('title block cells stay inside the block and do not overlap the north and scale bar cells', () => {
  const sheet = sheetOf('A4', false, 10);
  const cells = titleBlockCells(sheet);
  for (const cell of Object.values(cells)) {
    assert.ok(cell.x >= sheet.titleBlock.x - 1e-9 && cell.x + cell.width <= sheet.titleBlock.x + sheet.titleBlock.width + 1e-9);
    assert.ok(cell.y >= sheet.titleBlock.y - 1e-9 && cell.y + cell.height <= sheet.titleBlock.y + sheet.titleBlock.height + 1e-9);
  }
  assert.ok(cells.bar.x + cells.bar.width <= cells.north.x + 1e-9);
  assert.ok(cells.file.x + cells.file.width <= cells.bar.x + 1e-9);
});

test('report flow: blocks go down the page, the next page takes what does not fit, a heading stays with its block', () => {
  const area = { top: 10, bottom: 100 };
  assert.deepEqual(flowLayout([{ height: 40 }, { height: 40 }, { height: 40 }], area), [{ page: 0, y: 10 }, { page: 0, y: 50 }, { page: 1, y: 10 }]);
  assert.deepEqual(flowLayout([{ height: 40 }, { height: 40 }, { height: 8, keepWithNext: true }, { height: 40 }], area), [{ page: 0, y: 10 }, { page: 0, y: 50 }, { page: 1, y: 10 }, { page: 1, y: 18 }]);
  // A gap between blocks; a block taller than the page still gets a page of its own.
  assert.deepEqual(flowLayout([{ height: 30 }, { height: 30 }, { height: 200 }], area, 5), [{ page: 0, y: 10 }, { page: 0, y: 45 }, { page: 1, y: 10 }]);
});

test('text wraps on words to the width (Helvetica estimate), long words are cut, extra lines end in an ellipsis', () => {
  // 10 pt: about 1.764 mm per character, so 20 mm hold 11 characters.
  assert.deepEqual(wrapText('un deux trois quatre', 20, 10), ['un deux', 'trois', 'quatre']);
  assert.deepEqual(wrapText('ligne\nsuivante', 100, 10), ['ligne', 'suivante']);
  assert.deepEqual(wrapText('anticonstitutionnellement', 20, 10), ['anticonstit', 'utionnellem', 'ent']);
  assert.deepEqual(wrapText('un deux trois quatre', 20, 10, 2), ['un deux', 'trois...']);
  assert.deepEqual(wrapText('', 20, 10), []);
});
