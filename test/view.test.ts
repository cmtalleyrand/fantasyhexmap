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
