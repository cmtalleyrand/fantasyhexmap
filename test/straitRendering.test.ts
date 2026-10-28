import assert from 'node:assert/strict';
import test from 'node:test';
import { chainEdges, coastEdges, evenOddTest, surfaceMap } from '../src/render/coast.ts';
import { areaCoverage, polyArea, shapeCoast } from '../src/render/footprint.ts';
import { hexCorners, neighbourOf } from '../shared/hex.ts';
import type { BaseGeo } from '../shared/types.ts';
const size = 30, cols = 7, centre = 24, area = 1.5 * Math.sqrt(3) * size * size;
function layout(mask: number) {
  const base: BaseGeo[] = Array(49).fill('Sea');
  base[centre] = 'Strait';
  for (let e = 0; e < 6; e++) if (mask & (1 << e)) {
    const n = neighbourOf(3, 3, e);
    base[n.row * cols + n.col] = 'Land';
  }
  return base;
}
test('non-opposite strait banks grow to 50% and 60% without creating the reported two islands', () => {
  const base = layout((1 << 3) | (1 << 1));
  for (const share of [0.1, 0.3, 0.5, 0.6]) {
    const shaped = shapeCoast(coastEdges(base, cols, cols, size), surfaceMap(base, cols, cols), size,
      new Map([[centre, { share, kind: 'channel', width: 0.3 * Math.sqrt(3) * size, fit: true }]]))!;
    assert.ok(Math.abs(shaped.land.get(centre)!.reduce((a, p) => a + polyArea(p), 0) / area - share) < 0.002);
    const chains = chainEdges(shaped.edges);
    assert.equal(chains.length, 2, 'two mainland components, no extra islands or holes');
    for (const chain of chains) assert.ok(chain.edges.some(e => e.hex !== centre));
  }
});
test('every strait land component reaches a mainland across neighbour patterns, widths and shares', () => {
  for (let mask = 1; mask < 63; mask++) for (const width of [0.05, 0.15, 0.3, 0.5]) for (const share of [0.1, 0.5, 0.9]) {
    const base = layout(mask);
    const shaped = shapeCoast(coastEdges(base, cols, cols, size), surfaceMap(base, cols, cols), size,
      new Map([[centre, { share, kind: 'channel', width: width * Math.sqrt(3) * size, fit: true,
        bankBias: [0.81, 1.13, 0.96, 1.19, 0.88, 1.07] }]]))!;
    for (const chain of chainEdges(shaped.edges)) {
      assert.ok(chain.edges.some(e => e.hex !== centre), `isolated component: mask=${mask} width=${width} share=${share}`);
    }
  }
});
test('selected strait junctions retain mainland attachment at each width and land share', () => {
  const base = layout((1 << 3) | (1 << 1));
  for (let junctionSide = 0; junctionSide < 6; junctionSide++) for (const width of [0.05, 0.15, 0.3, 0.5]) for (const share of [0.1, 0.5, 0.9]) {
    const shaped = shapeCoast(coastEdges(base, cols, cols, size), surfaceMap(base, cols, cols), size,
      new Map([[centre, { share, kind: 'channel', width: width * Math.sqrt(3) * size, fit: true, junctionSide }]]))!;
    for (const chain of chainEdges(shaped.edges)) assert.ok(chain.closed && chain.edges.some(e => e.hex !== centre));
  }
});
test('independent bank profiles change the two shores while preserving their combined area', () => {
  const base = layout((1 << 3) | (1 << 1));
  const draw = (bankBias: number[]) => shapeCoast(coastEdges(base, cols, cols, size), surfaceMap(base, cols, cols), size,
    new Map([[centre, { share: 0.3, kind: 'channel', width: 0.3 * Math.sqrt(3) * size, fit: true, bankBias }]]))!.land.get(centre)!;
  const a = draw([1, 0.8, 1, 1.2, 1, 1]), b = draw([1, 1.2, 1, 0.8, 1, 1]);
  assert.notDeepEqual(a, b);
  for (const land of [a, b]) assert.ok(Math.abs(land.reduce((sum, p) => sum + polyArea(p), 0) / area - 0.3) < 0.002);
});
test('low-share strait banks project inland instead of remaining thin bands along hex sides', () => {
  for (let rotation = 0; rotation < 6; rotation++) for (const share of [0.1, 0.3]) {
    const dry = [(3 + rotation) % 6, (1 + rotation) % 6];
    const base = layout(dry.reduce((mask, e) => mask | (1 << e), 0));
    const shaped = shapeCoast(coastEdges(base, cols, cols, size), surfaceMap(base, cols, cols), size,
      new Map([[centre, { share, kind: 'channel', width: 0.3 * Math.sqrt(3) * size, fit: true }]]))!;
    for (const chain of chainEdges(shaped.edges)) {
      const e = dry.find(e => {
        const n = neighbourOf(3, 3, e);
        return chain.edges.some(edge => edge.hex === n.row * cols + n.col);
      })!;
      const corners = hexCorners(3, 3, size), a = corners[e]!, b = corners[(e + 1) % 6]!;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const points = chain.edges.filter(edge => edge.hex === centre).flatMap(edge => [edge.from, edge.to]);
      const depth = points.map(p => ((p.x - a.x) * (a.y - b.y) + (p.y - a.y) * (b.x - a.x)) / length);
      const along = points.map(p => ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length);
      assert.ok(Math.max(...depth) / (Math.max(...along) - Math.min(...along)) > 0.65,
        `rotation=${rotation}, share=${share}: shallow edge-parallel land bar`);
    }
  }
});
test('coverage measures holes and overlapping coastline ink once, inside the hex', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const hole = [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }];
  assert.ok(Math.abs(areaCoverage([square, hole], { evenOdd: true })(square, 200) - 64) < 0.01);
  const line = [{ x: 0, y: 5 }, { x: 10, y: 5 }];
  assert.ok(Math.abs(areaCoverage([], { evenOdd: true, stroke: { rings: [line, line], reach: 1 } })(square, 200) - 20) < 0.01);
  assert.equal(evenOddTest([square, hole], 1)({ x: 5, y: 5 }), false);
});
