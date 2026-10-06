import assert from 'node:assert/strict';
import test from 'node:test';
import { chainEdges, coastEdges, evenOddTest, surfaceMap } from '../src/render/coast.ts';
import { areaCoverage, polyArea, shapeCoast } from '../src/render/footprint.ts';
import { hexCenter, hexCorners, neighbourOf, type Point } from '../shared/hex.ts';
import { createMapState } from '../shared/layers.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';
import { pathPolylines } from '../src/render/ice.ts';
import type { BaseGeo, MapState } from '../shared/types.ts';
import type { Prim } from '../src/render/prims.ts';
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
const style = resolveStyle({ preset: 'parchment', overrides: { water: 'flat', grain: false, grid: 'none', land: 'uniform' } });
function fixture(percent: number, seed = 'investigation'): MapState {
  const map = createMapState('Strait regression', cols, cols);
  map.id = seed;
  map.defaultIrregularity = 'Ragged';
  map.hexDimensions.coastalLandPercent = percent;
  map.hexShapes = { '24': { type: 'Strait', land: percent } };
  const base = layout((1 << 3) | (1 << 1));
  for (const e of [3, 1]) {
    const n = neighbourOf(3, 3, e), n2 = neighbourOf(n.col, n.row, e);
    base[n.row * cols + n.col] = 'Coastal Land';
    base[n2.row * cols + n2.col] = 'Land';
  }
  map.layers.base.data = base;
  return map;
}
function renderedCoverage(map: MapState) {
  const scene = buildScene(map, { size, visible: defaultVisibility(), labels: false, style });
  const ground = scene.prims.find(p => p.kind === 'group' && p.clip);
  assert.ok(ground?.kind === 'group' && ground.clip, 'final land silhouette clips ground');
  const strokes: Array<{ d: ReturnType<typeof pathPolylines>; reach: number }> = [];
  const gather = (prims: Prim[]) => {
    for (const p of prims) {
      if (p.kind === 'group') gather(p.prims);
      if (p.kind === 'path' && p.stroke === style.palette.coast) strokes.push({ d: pathPolylines(p.d, 8), reach: (p.strokeWidth ?? 0) / 2 });
    }
  };
  gather(scene.prims);
  assert.equal(strokes.flatMap(s => s.d).length, 2, 'two connected mainland shores, no detached banks or islands');
  const measure = areaCoverage(pathPolylines(ground.clip, 8), { evenOdd: true,
    stroke: { rings: strokes.flatMap(s => s.d), reach: strokes[0]?.reach ?? 0 } });
  return { scene, rings: strokes.flatMap(s => s.d), measure: (i: number) => measure(hexCorners(i % cols, Math.floor(i / cols), size), 192) / area };
}
function crosses(rings: Point[][]) {
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let r = 0; r < rings.length; r++) for (let i = 0; i + 1 < rings[r]!.length; i++) {
    const a = rings[r]![i]!, b = rings[r]![i + 1]!;
    for (let s = r; s < rings.length; s++) for (let j = s === r ? i + 2 : 0; j + 1 < rings[s]!.length; j++) {
      const c = rings[s]![j]!, d = rings[s]![j + 1]!;
      if (cross(a, b, c) * cross(a, b, d) < -1e-8 && cross(c, d, a) * cross(c, d, b) < -1e-8) return true;
    }
  }
  return false;
}
test('final irregular strait and neighbouring coastal hexes meet achievable percentages', () => {
  for (const seed of ['investigation', 'coast-driftwood', 'coast-reefs']) for (const percent of [30, 50, 60]) {
    const { measure, rings } = renderedCoverage(fixture(percent, seed));
    assert.equal(crosses(rings), false, 'final coastline fitting preserves simple, disjoint shores');
    assert.equal(evenOddTest(rings, size / 8)(hexCenter(3, 3, size)), false, 'water remains through the strait centre');
    for (const i of [23, 24, 32]) assert.ok(Math.abs(measure(i) - percent / 100) < 0.01,
      `${seed}: hex ${i} requested ${percent}%, drew ${(measure(i) * 100).toFixed(2)}%`);
  }
});
test('an unattainable strait share is reported with its measured result and a useful width explanation', () => {
  const { scene, measure } = renderedCoverage(fixture(90));
  const note = scene.compromises?.find(c => c.hexes.includes(centre));
  assert.ok(note);
  assert.match(note.what, /instead of 90%/);
  assert.match(note.why, /width/);
  assert.ok(measure(centre) > 0.6 && measure(centre) < 0.8);
});
test('coverage measures holes and overlapping coastline ink once, inside the hex', () => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
  const hole = [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }, { x: 2, y: 8 }];
  assert.ok(Math.abs(areaCoverage([square, hole], { evenOdd: true })(square, 200) - 64) < 0.01);
  const line = [{ x: 0, y: 5 }, { x: 10, y: 5 }];
  assert.ok(Math.abs(areaCoverage([], { evenOdd: true, stroke: { rings: [line, line], reach: 1 } })(square, 200) - 20) < 0.01);
  assert.equal(evenOddTest([square, hole], 1)({ x: 5, y: 5 }), false);
});
