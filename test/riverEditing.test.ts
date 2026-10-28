import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { edgeBetween, hexLine } from '../shared/hex.ts';
import {
  buildBranch,
  detachOrphanBranches,
  extendRiver,
  moveRiverSegment,
  riverLabel,
  removeRiverSegment,
  setRiverNavigability,
  setRiverTributary,
  setRiverDistributary,
} from '../shared/riverEdit.ts';
import { buildRiverFromPath } from '../shared/validate.ts';
import { reducer } from '../src/state/store.ts';
import type { BaseData, River } from '../shared/types.ts';
import { riverCourses } from '../src/render/rivers.ts';

const COLS = 8;
const ROWS = 5;
// Land everywhere except a sea column on the right edge.
const base: BaseData = Array.from({ length: COLS * ROWS }, (_, i) => (i % COLS === COLS - 1 ? 'Sea' : 'Land'));

for (const outlet of ['Sea', 'Lake', 'OffMap'] as const) {
  test(`assigning a river already on its host replaces its ${outlet} outlet with a rendered confluence`, () => {
    const outletBase = base.map((v, i) => outlet === 'OffMap' ? 'Land' : i % COLS === COLS - 1 ? outlet : v) as BaseData;
    const col = outlet === 'OffMap' ? COLS - 1 : 6;
    const build = (id: string, path: Array<{ col: number; row: number }>) => {
      const r = buildRiverFromPath({ name: id, path }, id, outletBase, null, COLS, ROWS, []);
      assert.ok(r);
      return r;
    };
    const tributary = build('tributary', hexLine({ col: col - 2, row: 2 }, { col, row: 2 }));
    const host = build('host', [{ col, row: 1 }, { col, row: 2 }, { col, row: 3 }]);
    const oldLast = tributary.segments.at(-1)!;
    assert.equal(tributary.terminus, outlet);
    assert.notEqual(oldLast.exitEdge, null);
    oldLast.navigability = 'estuarine';
    oldLast.navigable = true;
    oldLast.reach = { min: 0.1, max: 0.4 };
    const before = structuredClone(tributary);

    const result = setRiverTributary(tributary, host.id, outletBase, null, COLS, ROWS, [host]);
    assert.ok(!('error' in result));
    assert.equal(result.river.joins, host.id);
    assert.equal(result.river.terminus, 'River');
    assert.deepEqual(result.river.segments, before.segments.map((s, i) =>
      i === before.segments.length - 1 ? { ...s, exitEdge: null } : s));
    assert.deepEqual(tributary, before, 'assignment does not mutate the original river');

    const courses = riverCourses([result.river, host], 26, 'host-assignment');
    const mouth = courses.get(tributary.id)!.centreline.at(-1)!;
    assert.ok(courses.get(host.id)!.centreline.some(p => Math.hypot(p.x - mouth.x, p.y - mouth.y) < 1e-6),
      'the tributary mouth ends on the rendered host course');
  });
}

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
  assert.equal(north.river.name, '', 'a branch is unnamed unless the user names it');
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

test('an unnamed branch keeps its blank name through edits and is described by its parent', () => {
  const main = river([[1, 2], [2, 2], [3, 2], [4, 2], [7, 2]], [true, true, true, true, false]);
  const fork = { col: 4, row: 2 };
  const built = buildBranch(main, fork, hexLine(fork, { col: 7, row: 0 }), 'b1', base, null, COLS, ROWS);
  assert.ok(!('error' in built));
  assert.equal(riverLabel(built.river, [main, built.river]), 'unnamed branch of Test');

  const reshaped = extendRiver(built.river, { col: 7, row: 1 }, base, null, COLS, ROWS, [main]);
  assert.ok(!('error' in reshaped), JSON.stringify(reshaped));
  assert.equal(reshaped.river.name, '', 'editing does not invent a name');

  const plain = buildRiverFromPath({ name: ' ', path: [{ col: 1, row: 2 }, { col: 2, row: 2 }] }, 'x', base, null, COLS, ROWS, []);
  assert.equal(plain?.name, 'Unnamed river', 'only distributaries may go unnamed');
});

test('3-way navigability supports non-navigable, navigable, and estuarine', () => {
  const r = river([[1, 2], [2, 2], [3, 2], [4, 2]], [false, false, false, false]);
  const hexes = new Set([2 * COLS + 2]);

  const est = setRiverNavigability([r], hexes, 'estuarine', false, COLS);
  assert.equal(est[0]!.segments[1]!.navigability, 'estuarine');
  assert.equal(est[0]!.segments[1]!.navigable, true);
  assert.equal(est[0]!.segments[0]!.navigability, 'non-navigable');

  const nav = setRiverNavigability([r], hexes, 'navigable', false, COLS);
  assert.equal(nav[0]!.segments[1]!.navigability, 'navigable');
  assert.equal(nav[0]!.segments[1]!.navigable, true);

  const nonNav = setRiverNavigability(nav, hexes, 'non-navigable', false, COLS);
  assert.equal(nonNav[0]!.segments[1]!.navigability, 'non-navigable');
  assert.equal(nonNav[0]!.segments[1]!.navigable, false);
});

test('rivers can traverse lake hexes without losing identity or disconnecting', () => {
  // Base with lake at col 3, row 2
  const lakeBase: BaseData = base.slice();
  lakeBase[2 * COLS + 3] = 'Lake';

  const fullPath = hexLine({ col: 1, row: 2 }, { col: 7, row: 2 });
  const r = buildRiverFromPath(
    { name: 'Through Lake', path: fullPath },
    'r_lake',
    lakeBase,
    null,
    COLS,
    ROWS,
    [],
  );
  assert.ok(r);
  assert.equal(r.name, 'Through Lake');
  assert.equal(r.terminus, 'Sea');
  // Middle lake segment exists
  assert.ok(r.segments.some((s) => s.col === 3 && s.row === 2));
  assertConnected(r);

  // Moving segment into lake is allowed
  const moveResult = moveRiverSegment(r, 1, { col: 3, row: 2 }, lakeBase, null, COLS, ROWS);
  assert.ok(!('error' in moveResult));
  assertConnected(moveResult.river);
});

test('tributary and distributary relationships can be defined', () => {
  const main = river([[1, 2], [2, 2], [3, 2], [4, 2], [7, 2]], [true, true, true, true, false]);
  const otherBuilt = river([[1, 0], [2, 0], [3, 0]], [false, false, false]);
  const other: River = { ...otherBuilt, id: 'r2', name: 'Other River' };

  // Connect other as tributary to main
  const tribResult = setRiverTributary(other, main.id, base, null, COLS, ROWS, [main]);
  assert.ok(!('error' in tribResult));
  assert.equal(tribResult.river.joins, main.id);
  assert.equal(tribResult.river.terminus, 'River');

  // Disconnect tributary
  const untribResult = setRiverTributary(tribResult.river, null, base, null, COLS, ROWS, [main]);
  assert.ok(!('error' in untribResult));
  assert.equal(untribResult.river.joins, undefined);

  // Distributary assignment
  const distResult = setRiverDistributary(other, main.id, base, null, COLS, ROWS, [main]);
  assert.ok(!('error' in distResult));
  assert.equal(distResult.river.branchOf, main.id);

  // Detach distributary
  const undistResult = setRiverDistributary(distResult.river, null, base, null, COLS, ROWS, [main]);
  assert.ok(!('error' in undistResult));
  assert.equal(undistResult.river.branchOf, undefined);
});


