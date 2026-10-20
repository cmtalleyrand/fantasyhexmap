import assert from 'node:assert/strict';
import test from 'node:test';
import { coastPaintPatches, coastPaintPaths } from '../src/render/coastPaint.ts';
import { coastGeometryOf, evenOddTest, type CoastEdge } from '../src/render/coast.ts';
import { pathPolylines } from '../src/render/ice.ts';
import type { Point } from '../shared/hex.ts';

function geometry() {
  const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 10 }];
  const edges: CoastEdge[] = points.slice(1).map((p, i) => ({ from: points[i]!, to: p, land: i < 2 ? 1 : 2, water: 3 }));
  return coastGeometryOf(edges, false);
}
const inside = (polys: Point[][], p: Point) => polys.some(poly => evenOddTest([poly], 1)(p));

test('paint follows a replacement final shore rather than stale pre-fit patches', () => {
  const source = geometry();
  const fitted = { ...source, component: true, paths: [[['M', -3, -4], ['L', 5, -5], ['L', 13, 0], ['L', 15, 6], ['L', 22, 7]]] as typeof source.paths };
  assert.equal(source.toLand.length, 0);
  const patches = coastPaintPatches(fitted, 10);
  const polys = patches.flatMap(s => pathPolylines(s.d, 4));
  // These points lie in the new donor extension outside the source land.
  for (const p of [{ x: 5, y: -4 }, { x: 12, y: 0 }, { x: 19, y: 8 }]) assert.ok(inside(polys, p), JSON.stringify(p));
  assert.equal(coastPaintPatches(fitted, 10), patches, 'a style redraw reuses immutable paint geometry');
  assert.notEqual(coastPaintPatches({ ...fitted, paths: source.paths }, 10), patches, 'a changed final coast invalidates the mesh');
});

test('compound donor paths have consistent winding and keep separate owners', () => {
  const source = geometry();
  const patches = coastPaintPatches({ ...source, component: true, paths: [[['M', 0, -3], ['L', 12, -3], ['L', 12, 8], ['L', 20, 8]]] }, 10);
  const paths = coastPaintPaths(patches);
  assert.deepEqual([...paths.keys()].sort(), [1, 2]);
  assert.equal(coastPaintPaths(patches), paths);
  for (const d of paths.values()) for (const ring of pathPolylines(d, 4)) {
    const area = ring.reduce((sum, p, i) => { const q = ring[(i + 1) % ring.length]!; return sum + p.x * q.y - q.x * p.y; }, 0);
    assert.ok(area >= 0, 'overlapping donor polygons form a union rather than cancel');
  }
  assert.ok(inside(pathPolylines(paths.get(1)!, 4), { x: 4, y: -2 }));
  assert.ok(!inside(pathPolylines(paths.get(2)!, 4), { x: 4, y: -2 }), 'the other donor does not acquire the first shore');
});

test('legacy corner corrections retain their original geometry', () => {
  const source = geometry();
  assert.equal(coastPaintPatches(source, 10), source.toLand);
});
