import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrthographicCamera, Vector3 } from 'three';
import { captureTiles, frameCamera, holdView, onlyBackground, tileRects, viewHeld } from '../src/engine/capture.ts';
import { clipRange } from '../src/engine/clipRange.ts';
import type { Viewer } from '../src/engine/Viewer.ts';

test('the capture camera takes the depth range of its own pose, not the one the display loop last drew', () => {
  // The parallel {3D} view of a 36 m model seen from about 495 m, while the shared parallel camera still has the near and far
  // planes of a floor plan seen from 80 m (no frame drawn since the view was opened: hidden tab, slowed loop).
  const camera = new OrthographicCamera(-30, 30, 20, -20, 52, 108);
  camera.position.set(300, 82, 385);
  camera.lookAt(0, 0, 0);
  const centre = new Vector3(0, 0, 0), radius = 36, target = new Vector3(0, 0, 0);
  const viewer = {
    camera,
    clipRangeOf: (c: OrthographicCamera) => clipRange(c.position, c.getWorldDirection(new Vector3()), centre, radius, c.position.distanceTo(target)),
  } as unknown as Viewer;
  const copy = frameCamera(viewer, 1.6, { world: { width: 80, height: 50 } });
  const depth = camera.position.length();
  assert.ok(copy.near <= depth - radius && copy.far >= depth + radius, `the whole model lies between near ${copy.near} and far ${copy.far} (depth ${depth})`);
  assert.equal(camera.near, 52, 'the view camera is not touched');
});

test('captures take the view one at a time, in order, and a failure frees it', async () => {
  const order: string[] = [];
  let release = () => {};
  const print = holdView(async () => {
    order.push('print starts');
    assert.equal(viewHeld(), true);
    await new Promise<void>((resolve) => { release = resolve; });
    order.push('print ends');
  });
  const copy = holdView(async () => { order.push('copy image'); });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ['print starts'], 'the copy waits while the print holds the view');
  release();
  await Promise.all([print, copy]);
  assert.deepEqual(order, ['print starts', 'print ends', 'copy image']);
  assert.equal(viewHeld(), false);
  await assert.rejects(holdView(async () => { throw new Error('échec'); }), /échec/);
  assert.equal(await holdView(async () => 'suivante'), 'suivante', 'a failed capture frees the view');
  // A capture that does not go through the queue is refused.
  await assert.rejects(captureTiles({} as Viewer, { widthPx: 1, heightPx: 1 }).next(), /holdView/);
});

test('a tile with nothing but the paper colour is blank', () => {
  const white = new Uint8Array(4 * 4 * 4).fill(255);
  assert.equal(onlyBackground(white, 16, [255, 255, 255]), true);
  // Alpha is not read; a pixel one step off is still the paper (rounding of the sRGB target).
  white[3] = 0;
  white[4] = 254;
  assert.equal(onlyBackground(white, 16, [255, 255, 255]), true);
  white[60] = 120;
  assert.equal(onlyBackground(white, 16, [255, 255, 255]), false, 'one drawn pixel is enough');
  // Only the first `count` pixels belong to the tile (the buffer is the size of the largest tile).
  assert.equal(onlyBackground(white, 15, [255, 255, 255]), true);
});

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

test('a mirrored view (ceiling plan read as in Revit) is captured mirrored, tiles included: a point on the right stays on the right', () => {
  const camera = new OrthographicCamera(20, -20, 10, -10, 1, 100);
  camera.position.set(0, -30, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const viewer = { camera, clipRangeOf: () => ({ near: 1, far: 100 }) } as unknown as Viewer;
  const east = new Vector3(5, 0, 0);
  const onScreen = east.clone().project(camera).x;
  const copy = frameCamera(viewer, 2, { world: { width: 40, height: 20 } }) as OrthographicCamera;
  assert.ok(copy.right < copy.left, 'still mirrored');
  assert.ok(Math.abs(east.clone().project(copy).x - onScreen) < 1e-9, 'same side of the page as on screen');
  // Seen from below without the mirror, east would be on the left: the mirror puts it back on the right, as on the floor plan.
  assert.ok(onScreen > 0);
  const tile = copy.clone();
  tile.setViewOffset(400, 200, 200, 0, 200, 200);
  assert.ok(east.clone().project(tile).x > -1, 'the right-hand tile holds the right-hand half');
});
