import assert from 'node:assert/strict';
import test from 'node:test';
import { boundsOf, intersects } from '../src/render/bounds.ts';

test('bounds include Bezier controls and long stroke miters rather than only endpoints', () => {
  const curve = boundsOf({ kind: 'path', d: [['M', 0, 0], ['C', 120, -30, 120, 30, 0, 0]], stroke: '#000', strokeWidth: 2 });
  assert.ok(intersects(curve, { left: 80, top: -5, right: 90, bottom: 5 }));
  assert.ok(intersects(curve, { left: 5, top: -45, right: 10, bottom: -40 }));
  assert.equal(intersects(curve, { left: 300, top: 300, right: 310, bottom: 310 }), false);
});

test('a clip bounds unknown lettering and nested translations retain its world position', () => {
  const clipped = boundsOf({ kind: 'group', translate: { x: 100, y: 200 },
    clip: [['M', 0, 0], ['L', 10, 0], ['L', 10, 10], ['L', 0, 10], ['Z']],
    prims: [{ kind: 'text', at: { x: 5, y: 5 }, text: 'Long unusual lettering', size: 40, rotation: 1, fill: '#000' }],
  });
  assert.ok(intersects(clipped, { left: 105, top: 205, right: 106, bottom: 206 }));
  assert.equal(intersects(clipped, { left: 0, top: 0, right: 50, bottom: 50 }), false);
  assert.equal(boundsOf({ kind: 'text', at: { x: 0, y: 0 }, text: 'Unknown metrics', size: 10, fill: '#000' }), null);
});
