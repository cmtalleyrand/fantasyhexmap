import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { edgeBetween, hexLine } from '../shared/hex.ts';
import {
  buildBranch,
  detachOrphanBranches,
  extendRiver,
  moveRiverSegment,
  removeRiverSegment,
  setRiverNavigability,
} from '../shared/riverEdit.ts';
import { buildRiverFromPath } from '../shared/validate.ts';
import { reducer } from '../src/state/store.ts';
import type { BaseData, River } from '../shared/types.ts';

const COLS = 8;
const ROWS = 5;
// Land everywhere except a sea column on the right edge.
const base: BaseData = Array.from({ length: COLS * ROWS }, (_, i) => (i % COLS === COLS - 1 ? 'Sea' : 'Land'));

function river(path: [number, number][], navigable: boolean[]): River {
  const r = buildRiverFromPath(
    { name: 'Test', path: path.map(([col, row]) => ({ col, row })), navigable },
    'r1',
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
    const a = r.segments[i - 1]!;
    const b = r.segments[i]!;
    assert.notEqual(edgeBetween(a, b), -1, `${a.col},${a.row} and ${b.col},${b.row} must touch`);
  }
}

test('hexLine steps only between adjacent hexes', () => {
  const line = hexLine({ col: 0, row: 0 }, { col: 5, row: 4 });
  assert.deepEqual(line[0], { col: 0, row: 0 });
  assert.deepEqual(line[line.length - 1], { col: 5, row: 4 });
  for (let i = 1; i < line.length; i++) assert.notEqual(edgeBetween(line[i - 1]!, line[i]!), -1);
});

test('moving a middle hex keeps the river connected and its navigability', () => {
  const r = river([[1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2]], [false, false, true, true, true, true, false]);
  const result = moveRiverSegment(r, 3, { col: 4, row: 0 }, base, null, COLS, ROWS);
  assert.ok(!('error' in result));
  assertConnected(result.river);
  assert.ok(result.river.segments.some((s) => s.col === 4 && s.row === 0));
  assert.equal(result.river.id, 'r1');
  assert.equal(result.river.terminus, 'Sea');
  assert.equal(result.river.segments[0]?.navigable, false);
  assert.equal(result.river.segments.find((s) => s.col === 4 && s.row === 0)?.navigable, true);
});

test('moving the source extends nothing and keeps the mouth', () => {
  const r = river([[1, 2], [2, 2], [3, 2], [7, 2]], [true, true, true, false]);
  const result = moveRiverSegment(r, 0, { col: 1, row: 1 }, base, null, COLS, ROWS);
  assert.ok(!('error' in result));
  assertConnected(result.river);
  assert.equal(result.river.segments[0]?.entryEdge, null);
});

test('a segment cannot be moved into water', () => {
  const r = river([[1, 2], [2, 2], [3, 2]], [true, true, true]);
  const result = moveRiverSegment(r, 1, { col: 7, row: 2 }, base, null, COLS, ROWS);
  assert.ok('error' in result);
});

test('removing a hex bridges the gap; removing the only hex reports null', () => {
  const r = river([[1, 2], [2, 2], [2, 1], [3, 2], [4, 2]], [true, true, true, true, true]);
  const result = removeRiverSegment(r, 2, base, null, COLS, ROWS);
  assert.ok(result && !('error' in result));
  assertConnected(result.river);
  assert.equal(result.river.segments.length, 4);

  const straight = river([[1, 2], [2, 2], [3, 2]], [true, true, true]);
  const refused = removeRiverSegment(straight, 1, base, null, COLS, ROWS);
  assert.ok(refused && 'error' in refused, 'a hex on a straight run cannot be bridged');

  const single = river([[3, 2], [7, 2]], [true, false]);
  assert.equal(single.segments.length, 1);
  assert.equal(removeRiverSegment(single, 0, base, null, COLS, ROWS), null);
});

test('navigability paints touched hexes, optionally everything downstream', () => {
  const r = river([[1, 2], [2, 2], [3, 2], [4, 2]], [false, false, false, false]);
  const hexes = new Set([2 * COLS + 2]);

  const here = setRiverNavigability([r], hexes, true, false, COLS);
  assert.deepEqual(here[0]!.segments.map((s) => s.navigable), [false, true, false, false]);

  const down = setRiverNavigability([r], hexes, true, true, COLS);
  assert.deepEqual(down[0]!.segments.map((s) => s.navigable), [false, true, true, true]);

  const rivers = [r];
  assert.equal(setRiverNavigability(rivers, new Set([0]), true, true, COLS), rivers, 'no hit returns same array');
  assert.equal(setRiverNavigability(down, hexes, true, true, COLS), down, 'no change returns same array');
});

test('a navigability stroke is a single undoable change', () => {
  const map = createMapState('Rivers', COLS, ROWS);
  map.layers.base.data = base;
  map.layers.rivers.data = { rivers: [river([[1, 2], [2, 2], [3, 2]], [false, false, false])] };
  const indices = [2 * COLS + 1, 2 * COLS + 2, 2 * COLS + 3];

  const painted = reducer(map, { type: 'setRiverNavigability', indices, navigable: true, downstream: false });
  assert.ok(painted.layers.rivers.data?.rivers[0]?.segments.every((s) => s.navigable));
  assert.equal(painted.layers.rivers.past.length, map.layers.rivers.past.length + 1);

  const undone = reducer(painted, { type: 'undo', layer: 'rivers' });
  assert.ok(undone.layers.rivers.data?.rivers[0]?.segments.every((s) => !s.navigable));
});

test('extending at the source adds the straight run of hexes in between', () => {
  const r = river([[3, 2], [4, 2], [5, 2]], [false, true, true]);
  const result = extendRiver(r, { col: 0, row: 2 }, base, null, COLS, ROWS);
  assert.ok(!('error' in result));
  assertConnected(result.river);
  const first = result.river.segments[0]!;
  assert.deepEqual([first.col, first.row], [0, 2]);
  assert.equal(first.entryEdge, null);
  assert.equal(result.river.segments.length, 6);
  assert.equal(result.river.segments[3]!.navigable, false, 'new hexes inherit the end they extend');
});

test('extending at the mouth reaches new water or inland ground', () => {
  const r = river([[1, 2], [2, 2], [3, 2]], [true, true, true]);
  assert.equal(r.terminus, 'Unresolved');
  const toSea = extendRiver(r, { col: 7, row: 2 }, base, null, COLS, ROWS);
  assert.ok(!('error' in toSea));
  assertConnected(toSea.river);
  assert.equal(toSea.river.terminus, 'Sea');
  assert.equal(toSea.river.segments.length, 6);

  const refused = extendRiver(r, { col: 2, row: 2 }, base, null, COLS, ROWS);
  assert.ok('error' in refused, 'cannot extend onto itself');
});

test('a branch leaves from a river hex and a river can have several', () => {
  const main = river([[1, 2], [2, 2], [3, 2], [4, 2], [7, 2]], [true, true, true, true, false]);
  const fork = { col: 4, row: 2 };
  const north = buildBranch(main, fork, hexLine(fork, { col: 7, row: 0 }), 'b1', base, null, COLS, ROWS);
  const south = buildBranch(main, fork, hexLine(fork, { col: 7, row: 4 }), 'b2', base, null, COLS, ROWS);
  assert.ok(!('error' in north) && !('error' in south));
  assert.equal(north.river.branchOf, 'r1');
  assert.equal(south.river.branchOf, 'r1');
  assert.equal(north.river.terminus, 'Sea');
  assert.equal(north.river.segments[0]!.entryEdge, null);
  assert.ok(north.river.segments[0]!.navigable, 'inherits navigability at the fork');
  assertConnected(north.river);

  const away = buildBranch(main, { col: 0, row: 0 }, [{ col: 0, row: 0 }, { col: 1, row: 0 }], 'b3', base, null, COLS, ROWS);
  assert.ok('error' in away, 'the fork must be one of the parent\'s hexes');
});

test('branches detach when their fork leaves the parent, and survive otherwise', () => {
  const main = river([[1, 2], [2, 2], [3, 2], [4, 2], [7, 2]], [true, true, true, true, false]);
  const fork = { col: 4, row: 2 };
  const built = buildBranch(main, fork, hexLine(fork, { col: 7, row: 0 }), 'b1', base, null, COLS, ROWS);
  assert.ok(!('error' in built));
  const rivers = [main, built.river];
  assert.equal(detachOrphanBranches(rivers), rivers, 'untouched when still forked');

  const map = createMapState('Rivers', COLS, ROWS);
  map.layers.base.data = base;
  map.layers.rivers.data = { rivers };
  const removed = reducer(map, { type: 'removeRiver', id: 'r1' });
  assert.equal(removed.layers.rivers.data?.rivers[0]?.branchOf, undefined);

  const moved = moveRiverSegment(main, 3, { col: 4, row: 4 }, base, null, COLS, ROWS);
  assert.ok(!('error' in moved));
  const after = reducer(map, { type: 'updateRiver', river: moved.river });
  assert.equal(after.layers.rivers.data?.rivers.find((r) => r.id === 'b1')?.branchOf, undefined);
});
