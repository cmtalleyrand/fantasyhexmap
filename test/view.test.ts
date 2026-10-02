import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_SCALE, MIN_SCALE, zoomAt } from '../src/render/view.ts';

test('zooming keeps the world point under the zoom centre fixed', () => {
  const view = { scale: 1.3, x: -40, y: 25 };
  const px = 400;
  const py = 300;
  const before = { x: (px - view.x) / view.scale, y: (py - view.y) / view.scale };
  for (const factor of [1.2, 1 / 1.2, 3]) {
    const next = zoomAt(view, factor, px, py);
    assert.ok(Math.abs((px - next.x) / next.scale - before.x) < 1e-9);
    assert.ok(Math.abs((py - next.y) / next.scale - before.y) < 1e-9);
  }
});

test('zoom is clamped to the allowed range', () => {
  assert.equal(zoomAt({ scale: 5, x: 0, y: 0 }, 10, 0, 0).scale, MAX_SCALE);
  assert.equal(zoomAt({ scale: 0.2, x: 0, y: 0 }, 0.01, 0, 0).scale, MIN_SCALE);
});

test('a pinch zooms by the change in finger spread and keeps the point between the fingers', async () => {
  const { pinchView } = await import('../src/render/view.ts');
  const start = { scale: 1, x: 0, y: 0 };
  const next = pinchView(start, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 50, y: 100 }, { x: 250, y: 100 });
  assert.equal(next.scale, 2);
  // The map point at the start midpoint (150, 100) is still under the midpoint.
  assert.ok(Math.abs(next.x + 150 * next.scale - 150) < 1e-9);
  assert.ok(Math.abs(next.y + 100 * next.scale - 100) < 1e-9);
  // Moving both fingers together pans without zooming.
  const panned = pinchView(start, { x: 100, y: 100 }, { x: 200, y: 100 }, { x: 130, y: 120 }, { x: 230, y: 120 });
  assert.deepEqual(panned, { scale: 1, x: 30, y: 20 });
});
