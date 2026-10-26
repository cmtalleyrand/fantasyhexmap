import assert from 'node:assert/strict';
import test from 'node:test';
import { samplePoints, symbolAnchor, type Placed } from '../src/render/symbols.ts';
import type { Prim } from '../src/render/prims.ts';

test('reused symbol samples equal the original anchor calculation across nested paths and polygons', () => {
  const fixtures: Prim[][] = [[], [{ kind: 'group', prims: [] }]];
  for (const scale of [0, 1e-9, 1, 1e9, 1e308]) {
    const pts = [-1, -0, 0.2, 1].map(x => ({ x: x * scale, y: 4 }));
    fixtures.push([
      { kind: 'group', prims: [
        { kind: 'polygon', points: pts },
        { kind: 'polyline', points: pts.slice().reverse() },
        { kind: 'path', d: [['M', -scale, 0], ['C', scale, 1, 0, 2, scale, 3], ['Z'], ['M', 0, 0], ['Q', scale, 2, scale, 4]] },
      ] },
    ]);
  }
  for (const prims of fixtures) {
    const placed: Placed = { y: 13, prims };
    const xs = samplePoints(placed).map(p => p.x);
    const expected = { x: xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0, y: placed.y };
    assert.deepEqual(symbolAnchor(placed), expected);
    assert.deepEqual(symbolAnchor(placed, samplePoints(placed)), expected);
  }
});
