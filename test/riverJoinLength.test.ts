import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { edgeBetween } from '../shared/hex.ts';
import { mergeRivers, reverseRiver } from '../shared/riverEdit.ts';
import {
  formatLength,
  pathLength,
  riverLength,
  riverSystemLength,
  stepLength,
} from '../shared/riverLength.ts';
import { buildRiverFromPath, validateRivers } from '../shared/validate.ts';
import { reducer } from '../src/state/store.ts';
import { DEFAULT_HEX_DIMENSIONS, type BaseData, type River } from '../shared/types.ts';

const COLS = 8;
const ROWS = 5;
// Land everywhere except a sea column on the right edge.
const base: BaseData = Array.from({ length: COLS * ROWS }, (_, i) => (i % COLS === COLS - 1 ? 'Sea' : 'Land'));
const regular = { width: 10, height: DEFAULT_HEX_DIMENSIONS.height };

function river(id: string, path: [number, number][], navigable?: boolean[]): River {
  const r = buildRiverFromPath(
    { name: id, path: path.map(([col, row]) => ({ col, row })), navigable: navigable ?? path.map(() => false) },
    id,
    base,
    null,
    COLS,
    ROWS,
    [],
  );
  assert.ok(r);
  return r;
}

function assertConnected(r: River) {
  for (let i = 1; i < r.segments.length; i++) {
    assert.notEqual(edgeBetween(r.segments[i - 1]!, r.segments[i]!), -1);
  }
}

test('on a regular hex every step to a neighbour is one width', () => {
  for (let edge = 0; edge < 6; edge++) assert.ok(Math.abs(stepLength(edge, regular) - 10) < 1e-6);
  // A stretched hex makes diagonal steps longer than east-west ones.
  assert.ok(stepLength(1, { width: 10, height: 20 }) > stepLength(0, { width: 10, height: 20 }));
});

test('a river is measured from its source centre to where it leaves the land', () => {
  // Five land hexes running east into the sea column: four steps, then half a step to the coast.
  const r = river('r', [[2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2]]);
  assert.equal(r.terminus, 'Sea');
  assert.ok(Math.abs(riverLength(r, regular) - 45) < 1e-6);
  assert.ok(Math.abs(pathLength(r.segments, regular) - 40) < 1e-6);
});

test('a system length adds the branches to the main river', () => {
  const main = river('main', [[1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2]]);
  const branch = { ...river('branch', [[4, 2], [5, 1], [6, 1], [7, 1]]), branchOf: 'main' };
  const all = [main, branch];
  assert.ok(Math.abs(riverSystemLength(main, all, regular) - (riverLength(main, regular) + riverLength(branch, regular))) < 1e-6);
  assert.equal(formatLength(1234.4, 'km'), '1,230 km');
  assert.equal(formatLength(12.34, 'mi'), '10 mi');
  assert.equal(formatLength(12.34, 'mi', 0.5), '12.5 mi');
});

test('two pieces whose ends touch join into one river that keeps the chosen name', () => {
  const upper = river('upper', [[0, 2], [1, 2], [2, 2]], [false, false, true]);
  const lower = river('lower', [[3, 2], [4, 2], [5, 2], [6, 2], [7, 2]], [true, true, true, true, false]);
  const result = mergeRivers([lower, upper], 'lower', base, null, COLS, ROWS);
  assert.ok(!('error' in result), 'error' in result ? result.error : '');
  assert.equal(result.river.id, 'lower');
  assert.equal(result.river.name, 'lower');
  assert.deepEqual(result.absorbed, ['upper']);
  assert.equal(result.bridged, 0);
  assert.equal(result.river.terminus, 'Sea');
  assert.deepEqual(result.river.segments.map((s) => [s.col, s.row]), [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2]]);
  assert.deepEqual(result.river.segments.map((s) => s.navigable), [false, false, true, true, true, true, true]);
  assertConnected(result.river);
});

test('a gap between pieces is bridged with a straight run of land', () => {
  const upper = river('upper', [[0, 1], [1, 1]]);
  const lower = river('lower', [[4, 1], [5, 1], [6, 1], [7, 1]]);
  const result = mergeRivers([upper, lower], 'upper', base, null, COLS, ROWS);
  assert.ok(!('error' in result));
  assert.equal(result.bridged, 2);
  assert.equal(result.river.segments.length, 7);
  assertConnected(result.river);
});

test('three pieces chain in flow order whatever order they are picked in', () => {
  const a = river('a', [[0, 3], [1, 3]]);
  const b = river('b', [[2, 3], [3, 3]]);
  const c = river('c', [[4, 3], [5, 3], [6, 3], [7, 3]]);
  const result = mergeRivers([c, a, b], 'b', base, null, COLS, ROWS);
  assert.ok(!('error' in result));
  assert.equal(result.river.segments[0]!.col, 0);
  assert.equal(result.river.segments.length, 7);
  assert.deepEqual(result.absorbed.sort(), ['a', 'c']);
});

test('a bridge that would cross the sea is refused', () => {
  const sea: BaseData = base.map((v, i) => (i % COLS === 3 ? 'Sea' : v));
  const west = buildRiverFromPath({ name: 'west', path: [{ col: 0, row: 2 }, { col: 1, row: 2 }] }, 'west', sea, null, COLS, ROWS, [])!;
  const east = buildRiverFromPath({ name: 'east', path: [{ col: 5, row: 2 }, { col: 6, row: 2 }, { col: 7, row: 2 }] }, 'east', sea, null, COLS, ROWS, [])!;
  const result = mergeRivers([west, east], 'west', sea, null, COLS, ROWS);
  assert.ok('error' in result);
  assert.match(result.error, /crosses the sea/);
});

test('reversing a river swaps source and mouth and finds a new way out', () => {
  const r = river('r', [[2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2]], [true, false, false, false, false, false]);
  const reversed = reverseRiver(r, base, null, COLS, ROWS);
  assert.ok(!('error' in reversed));
  assert.deepEqual([reversed.river.segments[0]!.col, reversed.river.segments.at(-1)!.col], [6, 2]);
  assert.equal(reversed.river.segments.at(-1)!.navigable, true);
  assertConnected(reversed.river);
});

test('joining in the reducer is one undo step and re-points branches of absorbed pieces', () => {
  const upper = river('upper', [[0, 2], [1, 2], [2, 2]]);
  const lower = river('lower', [[3, 2], [4, 2], [5, 2], [6, 2], [7, 2]]);
  const branch = { ...river('branch', [[1, 2], [1, 1], [0, 1]]), branchOf: 'upper' };
  let map = createMapState('Join', COLS, ROWS);
  map.layers.base.data = base;
  map.layers.rivers.data = { rivers: [upper, lower, branch] };
  const merged = mergeRivers([upper, lower], 'lower', base, null, COLS, ROWS);
  assert.ok(!('error' in merged));
  map = reducer(map, { type: 'mergeRivers', river: merged.river, absorbed: merged.absorbed });
  const rivers = map.layers.rivers.data!.rivers;
  assert.deepEqual(rivers.map((r) => r.id).sort(), ['branch', 'lower']);
  assert.equal(rivers.find((r) => r.id === 'branch')!.branchOf, 'lower');
  assert.equal(map.layers.rivers.past.length, 1);
  const undone = reducer(map, { type: 'undo', layer: 'rivers' });
  assert.equal(undone.layers.rivers.data!.rivers.length, 3);
});

test('the legend can list every river with its length', async () => {
  const { legendSections, DEFAULT_LEGEND_OPTIONS } = await import('../src/render/legend.ts');
  const { defaultVisibility } = await import('../src/render/scene.ts');
  const map = createMapState('Legend', COLS, ROWS);
  map.layers.base.data = base;
  map.layers.rivers.data = { rivers: [river('Kelder', [[2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2]])] };
  map.hexDimensions = { ...map.hexDimensions, width: 10, height: DEFAULT_HEX_DIMENSIONS.height, unit: 'km' };
  const visible = { ...defaultVisibility(), rivers: true };
  const labels = (riverLengths: boolean) =>
    legendSections(map, visible, 'colour', { ...DEFAULT_LEGEND_OPTIONS, riverLengths })
      .find((s) => s.id === 'rivers')!
      .entries.map((e) => e.label);
  assert.ok(!labels(false).some((l) => l.startsWith('Kelder')));
  assert.ok(labels(true).includes('Kelder - 50 km'));
});

test('a bridge across a lake joins two rivers into one that flows through it', () => {
  const lake: BaseData = base.map((v, i) => (i % COLS === 3 && Math.floor(i / COLS) === 2 ? 'Lake' : v));
  const west = buildRiverFromPath({ name: 'west', path: [{ col: 0, row: 2 }, { col: 1, row: 2 }, { col: 2, row: 2 }] }, 'west', lake, null, COLS, ROWS, [])!;
  const east = buildRiverFromPath({ name: 'east', path: [{ col: 4, row: 2 }, { col: 5, row: 2 }, { col: 6, row: 2 }] }, 'east', lake, null, COLS, ROWS, [])!;
  const result = mergeRivers([west, east], 'west', lake, null, COLS, ROWS);
  assert.ok(!('error' in result), 'error' in result ? result.error : '');
  assert.equal(result.river.segments.length, 7);
  assert.ok(result.river.segments.some((s) => s.col === 3 && s.row === 2), 'the lake hex is part of the river');
});

test('a river may run through a lake without a warning', () => {
  const lake: BaseData = base.map((v, i) => (i % COLS === 3 && Math.floor(i / COLS) === 2 ? 'Lake' : v));
  const thru = river('thru', [[1, 2], [2, 2], [3, 2], [4, 2], [5, 2]]);
  const checked = validateRivers([thru], lake, COLS, ROWS);
  assert.equal(checked.warnings.length, 0);
});
