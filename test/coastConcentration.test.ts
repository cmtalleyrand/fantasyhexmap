import assert from 'node:assert/strict';
import test from 'node:test';
import { LAND_SHARE_TOLERANCE } from '../shared/surfaceArea.ts';
import { hexCenter, hexCorners, neighbourOf } from '../shared/hex.ts';
import type { BaseGeo } from '../shared/types.ts';
import { coastEdges, coastGeometryOf, drawnLand, surfaceMap } from '../src/render/coast.ts';
import { areaCoverage, polyArea, shapeCoast } from '../src/render/footprint.ts';
import { fitCoastAreas } from '../src/render/coastArea.ts';
import { pathPolylines } from '../src/render/ice.ts';

const cols = 5, rows = 5, size = 30, h = 12;
const corners = hexCorners(2, 2, size), centre = hexCenter(2, 2, size);
const full = polyArea(corners);

for (let wet = 0; wet < 6; wet++) {
  test(`single coastal edge ${wet}: concentration skews land while preserving area`, () => {
    const base: BaseGeo[] = Array.from({ length: cols * rows }, (_, i) =>
      i % cols === 0 || i % cols === cols - 1 || i < cols || i >= cols * (rows - 1) ? 'Sea' : 'Land');
    base[h] = 'Land';
    const sea = neighbourOf(2, 2, wet);
    base[sea.row * cols + sea.col] = 'Sea';
    const edges = coastEdges(base, cols, rows, size), surface = surfaceMap(base, cols, rows);
    const shape = (share: number, concentration?: number, side = (wet + 1) % 6) => shapeCoast(edges, surface, size,
      new Map([[h, { kind: 'inset', share, concentrationSide: side, concentration }]]))!;
    for (const share of [0.2, 0.5, 0.8, 0.95]) {
      const plain = shape(share, 0);
      assert.deepEqual(shape(share, 0, (wet + 4) % 6).land.get(h), plain.land.get(h));
      const a = corners[wet]!, b = corners[(wet + 1) % 6]!;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const projection = (p: { x: number; y: number }) => ((p.x - centre.x) * (b.x - a.x) + (p.y - centre.y) * (b.y - a.y)) / len;
      // Compare the land's first moment along the coastal edge, independent of
      // where a particular tessellation puts its vertices.
      const moment = (polys: typeof corners[]) => polys.reduce((sum, p) => sum + p.reduce((n, u, k) => {
        const v = p[(k + 1) % p.length]!;
        return n + (projection(u) + projection(v)) * (u.x * v.y - v.x * u.y) / 6;
      }, 0), 0) / (full * size);
      const plus = shape(share, 100), minus = shape(share, 100, (wet + 4) % 6);
      for (const shaped of [plus, minus]) assert.ok(Math.abs(shaped.land.get(h)!.reduce((s, p) => s + polyArea(p), 0) / full - share) < 1e-6);
      assert.ok(moment(plus.land.get(h)!) > moment(plain.land.get(h)!) + 0.001);
      assert.ok(moment(minus.land.get(h)!) < moment(plain.land.get(h)!) - 0.001);
    }
    for (let side = 0; side < 6; side++) for (const share of [0, 0.01, 0.8, 0.99]) {
      const land = shape(share, 100, side).land.get(h) ?? [];
      assert.ok(Math.abs(land.reduce((sum, p) => sum + polyArea(p), 0) / full - share) < 1e-6);
    }
    // Exercise the actual smoothed coast and coupled area fitter. The land on
    // opposite sides of the hex must still respond to the selected direction.
    const mid = (e: number) => ({ x: (corners[e % 6]!.x + corners[(e + 1) % 6]!.x) / 2, y: (corners[e % 6]!.y + corners[(e + 1) % 6]!.y) / 2 });
    const half = [mid(wet), corners[(wet + 1) % 6]!, corners[(wet + 2) % 6]!, corners[(wet + 3) % 6]!, mid(wet + 3)];
    const fittedHalf = (side: number) => {
      const shaped = shape(0.8, 100, side);
      const geometry = coastGeometryOf(shaped.edges, true, { size, noise: () => 0.5, amplitude: () => 0.1 });
      const page = { width: 300, height: 300 };
      const fitted = fitCoastAreas(geometry, new Map([[h, { share: 0.8 }]]), cols, rows, size, page, 0);
      const coverage = areaCoverage(pathPolylines(drawnLand(fitted, page.width, page.height, size), 8), { evenOdd: true });
      assert.ok(Math.abs(coverage(corners) / full - 0.8) <= LAND_SHARE_TOLERANCE, `shown ${coverage(corners) / full}`);
      return coverage(half) / full;
    };
    const plus = fittedHalf((wet + 1) % 6), minus = fittedHalf((wet + 4) % 6);
    assert.ok(plus > minus + 0.01, `${plus} vs ${minus}`);
  });
}
