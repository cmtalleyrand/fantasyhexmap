import assert from 'node:assert/strict';
import test from 'node:test';
import { coastEdges, coastGeometryOf, evenOddTest, type Roughness } from '../src/render/coast.ts';
import { areaCoverage, coveredArea, driftOf } from '../src/render/footprint.ts';
import { polygonSliver } from '../src/render/sliver.ts';
import { hexCorners } from '../shared/hex.ts';
import { unit } from '../src/render/seed.ts';
import type { BaseGeo } from '../shared/types.ts';

const fixture = () => {
  const base: BaseGeo[] = Array(200).fill('Sea');
  for (const col of [4, 5, 14, 15]) for (const row of [3, 4]) base[row * 20 + col] = 'Land';
  return base;
};

test('unchanged component geometry is reused without repeating noise work', () => {
  let calls = 0;
  const rough: Roughness = { size: 26, amplitude: () => 0.12, noise: (x, y, k) => { calls++; return unit('perf', x, y, k); } };
  const edges = coastEdges(fixture(), 20, 10, 26);
  const first = coastGeometryOf(edges, true, rough);
  const before = calls;
  assert.ok(before > 0);
  const second = coastGeometryOf(edges, true, rough);
  assert.equal(calls, before, 'a fitting pass must not repeat work for an unchanged component');
  assert.deepEqual(second, first);
  assert.equal(second.paths[0], first.paths[0]);
});

test('nearby coast edits invalidate cached clearance constraints; distant components are reusable', () => {
  const base = fixture();
  const rough: Roughness = { size: 26, amplitude: () => 0.12, noise: (x, y, k) => unit('perf', x, y, k) };
  const original = coastGeometryOf(coastEdges(base, 20, 10, 26), true, rough);
  // A new component one hex away changes the existing island's clearance.
  base[3 * 20 + 7] = 'Land';
  const updated = coastGeometryOf(coastEdges(base, 20, 10, 26), true, rough);
  const fresh = coastGeometryOf(coastEdges(base, 20, 10, 26), true, { ...rough });
  assert.deepEqual(updated, fresh, 'cached geometry must agree with a fresh build after an edit');
  assert.ok(updated.paths.some(path => original.paths.includes(path)), 'the distant island should retain its cached path');
  assert.ok(updated.paths.some(path => !original.paths.includes(path)), 'affected components must be rebuilt');
});

test('area scan keeps enclosing contours and merges overlaps while ignoring distant rings', () => {
  const rectangle = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const clip = rectangle(0, 0, 10, 10);
  assert.equal(coveredArea([rectangle(-100, -100, 200, 200)], clip, 100), 100);
  assert.ok(Math.abs(coveredArea([rectangle(-5, 0, 10, 10), rectangle(3, 0, 10, 10), rectangle(100, 100, 10, 10)], clip, 100) - 100) < 1e-10);
  assert.ok(Math.abs(coveredArea([rectangle(-5, 2, 10, 6)], clip, 100) - 30) < 1e-10);
});


test('indexed land queries retain ray parity at vertices, holes and cell boundaries', () => {
  const rings = [
    [{ x: -40, y: -20 }, { x: 80, y: -10 }, { x: 60, y: 90 }, { x: -30, y: 50 }],
    [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 30 }, { x: 0, y: 30 }],
    [{ x: 120, y: 10 }, { x: 150, y: 35 }, { x: 120, y: 60 }],
  ];
  const indexed = evenOddTest(rings, 3.25);
  const brute = (x: number, y: number) => {
    let inside = false;
    for (const ring of rings) for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
  };
  for (let i = 0; i < 10000; i++) {
    const x = -70 + unit('land-query', i, 0) * 250, y = -40 + unit('land-query', i, 1) * 160;
    assert.equal(indexed({ x, y }), brute(x, y));
  }
  for (const ring of rings) for (const p of ring) assert.equal(indexed(p), brute(p.x, p.y));
  for (let x = -52; x <= 156; x += 13) for (let y = -26; y <= 104; y += 3.25) assert.equal(indexed({ x, y }), brute(x, y));
});


test('coast fitting measures raw swept polygons without constructing render commands', () => {
  const points = hexCorners(1, 1, 26);
  const sliver = polygonSliver(points, 4);
  const expected = sliver.d;
  assert.deepEqual(expected, [...points.map((p, i) => [i ? 'L' : 'M', p.x, p.y]), ['Z']]);
  const lazy = polygonSliver(points, 4);
  Object.defineProperty(lazy, 'd', { get() { throw new Error('fitting materialized render commands'); } });
  const drift = driftOf({ toWater: [], toLand: [lazy] }, 0, new Set([4]), 3, 3, 26, () => { throw new Error('fitting flattened a polygon'); });
  assert.ok(Math.abs(drift.get(4)! - 1.5 * Math.sqrt(3) * 26 ** 2) < 1e-8);
});


test('local coverage preparation preserves enclosing rings, holes, ink and queries outside its region', () => {
  const rectangle = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const clip = rectangle(0, 0, 10, 10), elsewhere = rectangle(100, 100, 10, 10);
  const rings = [rectangle(-100, -100, 200, 200), rectangle(2, 2, 6, 6), rectangle(100, 100, 10, 10)];
  const strokes = [[{ x: -20, y: 5 }, { x: 20, y: 5 }], [{ x: 90, y: 105 }, { x: 120, y: 105 }]];
  const options = { evenOdd: true, stroke: { rings: strokes, reach: 1 } };
  const full = areaCoverage(rings, options), local = areaCoverage(rings, { ...options, within: clip });
  for (const lines of [32, 128, 257]) {
    assert.equal(local(clip, lines), full(clip, lines));
    assert.equal(local(elsewhere, lines), full(elsewhere, lines));
    assert.equal(local(clip.map(p => ({ ...p })), lines), full(clip, lines));
  }
});

test('reused scanlines preserve fill parity and stroke unions across adjacent and unrelated queries', () => {
  // Merging a scanline before clipping changes the order of floating-point sums.
  const sameArea = (actual: number, expected: number) =>
    assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(1, expected), `${actual} versus ${expected}`);
  const rings = [
    [{ x: -100, y: -100 }, { x: 300, y: -100 }, { x: 300, y: 300 }, { x: -100, y: 300 }],
    [{ x: 5, y: 0 }, { x: 70, y: 10 }, { x: 40, y: 95 }, { x: -5, y: 60 }],
    [{ x: 100, y: -20 }, { x: 140, y: 20 }, { x: 100, y: 50 }],
  ];
  const strokes = [...rings.map(r => [...r, r[0]!]), [{ x: -100, y: 20 }, { x: 300, y: 20 }]];
  for (const evenOdd of [true, false]) for (const reach of [0, 0.7, 2.5]) {
    const options = { evenOdd, stroke: { rings: strokes, reach } };
    const uncached = areaCoverage(rings, options), cached = areaCoverage(rings, { ...options, reuseScanlines: true });
    for (const lines of [17, 96, 128]) for (let r = 0; r < 7; r++) for (let c = 0; c < 8; c++) {
      const clip = hexCorners(c, r, 11);
      sameArea(cached(clip, lines), uncached(clip, lines));
    }
    const clip = hexCorners(1, 1, 11);
    const local = areaCoverage(rings, { ...options, within: clip, reuseScanlines: true });
    sameArea(local(clip, 128), uncached(clip, 128));
    sameArea(local(hexCorners(6, 4, 11), 17), uncached(hexCorners(6, 4, 11), 17));
  }
});
