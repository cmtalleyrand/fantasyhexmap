import assert from 'node:assert/strict';
import test from 'node:test';
import { coastEdges, coastGeometryOf, type Roughness } from '../src/render/coast.ts';
import { coveredArea } from '../src/render/footprint.ts';
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
