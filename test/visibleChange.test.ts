import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error The browser scripts' helper is plain JavaScript.
import { visibleChange } from '../scripts/visible-change.mjs';

const W = 64, H = 48;
/** A white image with a dark vertical edge at `edge` (fractional columns antialiased) and optional extras. */
function image(edge: number, paint?: (x: number, y: number) => number | undefined): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const cover = Math.max(0, Math.min(1, edge - x));
    const value = paint?.(x, y) ?? Math.round(255 - 215 * cover);
    data.set([value, value, value, 255], (y * W + x) * 4);
  }
  return data;
}

test('identical images and sub-pixel edge moves are not visible changes', () => {
  assert.deepEqual(visibleChange(image(20), image(20), W, H).changedPixels, 0);
  const moved = visibleChange(image(20.2), image(20.6), W, H);
  assert.ok(moved.changedPixels > 0 && moved.maxChannelDelta > 32, 'the plain difference is large at the edge');
  assert.equal(moved.visible, false);
});

test('an edge moved by up to a pixel stays within the tolerance', () => {
  assert.equal(visibleChange(image(20), image(21), W, H).visible, false);
  assert.equal(visibleChange(image(20.3), image(21.1), W, H).visible, false);
});

test('a feature that appears, or a shift beyond a pixel, is visible', () => {
  const dot = visibleChange(image(20), image(20, (x, y) => x >= 40 && x < 43 && y >= 10 && y < 13 ? 0 : undefined), W, H);
  assert.equal(dot.visible, true);
  assert.equal(visibleChange(image(20), image(23), W, H).visible, true);
});

test('a faint change over much of the picture is visible even when no pixel changes much', () => {
  const tinted = visibleChange(image(20), image(20, (x) => x > 24 ? 243 : undefined), W, H);
  assert.ok(tinted.maxChannelDelta <= 12);
  assert.equal(tinted.visible, true);
});

test('single-level raster variation is not visible', () => {
  assert.equal(visibleChange(image(20), image(20, (x, y) => x > 21 && (x * 7 + y * 3) % 5 === 0 ? 254 : undefined), W, H).visible, false);
});
