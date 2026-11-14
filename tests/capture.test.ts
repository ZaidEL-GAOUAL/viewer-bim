import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tileRects } from '../src/engine/capture.ts';

test('tiles cover the image exactly once', () => {
  for (const [width, height, tile] of [[10, 7, 4], [4, 4, 4], [1, 1, 2048], [4725, 3150, 2048], [13807, 9366, 2048]]) {
    const rects = tileRects(width, height, tile);
    assert.equal(rects.reduce((sum, r) => sum + r.width * r.height, 0), width * height, `${width}x${height}: total area`);
    assert.ok(rects.every((r) => r.width > 0 && r.height > 0 && r.width <= tile && r.height <= tile && r.x >= 0 && r.y >= 0 && r.x + r.width <= width && r.y + r.height <= height));
    // No two tiles overlap: rows and columns are consecutive.
    for (const r of rects) assert.ok(r.x % tile === 0 && r.y % tile === 0);
  }
  const grid = new Uint8Array(10 * 7);
  for (const r of tileRects(10, 7, 4)) for (let y = r.y; y < r.y + r.height; y++) for (let x = r.x; x < r.x + r.width; x++) grid[y * 10 + x]++;
  assert.ok(grid.every((count) => count === 1));
});

test('tiles come row by row, left to right', () => {
  assert.deepEqual(tileRects(10, 7, 4), [
    { x: 0, y: 0, width: 4, height: 4 }, { x: 4, y: 0, width: 4, height: 4 }, { x: 8, y: 0, width: 2, height: 4 },
    { x: 0, y: 4, width: 4, height: 3 }, { x: 4, y: 4, width: 4, height: 3 }, { x: 8, y: 4, width: 2, height: 3 },
  ]);
});

test('an empty or invalid size has no tile', () => {
  assert.deepEqual(tileRects(0, 5, 4), []);
  assert.throws(() => tileRects(5, 5, 0));
});

test('printed pages are opaque white JPEG; the clipboard capture keeps the screen background', async () => {
  const { printCaptureOptions } = await import('../src/engine/capture.ts');
  const options = printCaptureOptions({ widthPx: 10, heightPx: 10 });
  assert.equal(options.background, '#ffffff');
  assert.equal(options.format, 'jpeg');
  // capturePng (copy image) passes no background of its own.
  const source = (await import('node:fs')).readFileSync(new URL('../src/ui/ExportActions.ts', import.meta.url), 'utf8');
  assert.ok(!/background/.test(source));
});
