import assert from 'node:assert/strict';
import test from 'node:test';

import { neighbourOf } from '../shared/hex.js';
import { createMapState } from '../shared/layers.js';
import type { BaseGeo } from '../shared/types.js';
import { reducer } from '../src/state/store.js';

test('expanding every edge preserves old cells and infers the new boundary from neighbours', () => {
  const edges = ['top', 'bottom', 'left', 'right'] as const;
  for (const edge of edges) {
    let map = createMapState('', 3, 2);
    const base: BaseGeo[] = ['Land', 'Land', 'Sea', 'Land', 'Sea', 'Sea'];
    map = reducer(map, { type: 'applyGeneration', layer: 'base', data: base, warnings: [], notes: null });
    map = reducer(map, {
      type: 'applyGeneration',
      layer: 'population',
      data: [10, 20, null, 30, null, null],
      warnings: [],
      notes: null,
    });
    map = reducer(map, {
      type: 'applyGeneration',
      layer: 'cities',
      data: { cities: [{ id: 'c', col: 0, row: 1, name: 'A', population: 1, onRiver: false, riverId: null, coastal: false, coastalEdges: [] }] },
      warnings: [],
      notes: null,
    });

    const expanded = reducer(map, { type: 'growMap', amounts: { [edge]: edge === 'top' ? 2 : 1 } });
    const colShift = edge === 'left' ? 1 : 0;
    const rowShift = edge === 'top' ? 2 : 0;
    assert.equal(expanded.cols, 3 + (edge === 'left' || edge === 'right' ? 1 : 0));
    assert.equal(expanded.rows, 2 + (edge === 'top' ? 2 : edge === 'bottom' ? 1 : 0));
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        assert.equal(
          expanded.layers.base.data![(row + rowShift) * expanded.cols + col + colShift],
          base[row * 3 + col],
        );
      }
    }
    assert.equal(expanded.layers.cities.data!.cities[0]!.col, colShift);
    assert.equal(expanded.layers.cities.data!.cities[0]!.row, 1 + rowShift);
    assert.equal(expanded.layers.base.data!.length, expanded.cols * expanded.rows);
    assert.equal(expanded.layers.population.data!.length, expanded.cols * expanded.rows);
  }
});

test('new population cells use the rounded mean of their available boundary neighbours', () => {
  let map = createMapState('', 3, 1);
  map = reducer(map, { type: 'applyGeneration', layer: 'base', data: ['Land', 'Land', 'Land'], warnings: [], notes: null });
  map = reducer(map, { type: 'applyGeneration', layer: 'population', data: [10, 20, 90], warnings: [], notes: null });

  map = reducer(map, { type: 'growMap', amounts: { top: 2 } });

  assert.equal(map.rows, 3, 'two rows at the top');
  assert.deepEqual(map.layers.population.data!.slice(3, 6), [15, 40, 55]);
  assert.deepEqual(map.layers.population.data!.slice(6, 9), [10, 20, 90]);
});

test('expanding keeps every river segment adjacent to the next, on every edge', () => {
  for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
    let map = createMapState('', 5, 5);
    map = reducer(map, { type: 'applyGeneration', layer: 'base', data: Array(25).fill('Land'), warnings: [], notes: null });
    // (2,1) -> (2,2) -> (1,3): SE of an odd row hex is (c+1), SW of an even... edges are as the hex grid defines them.
    const a = neighbourOf(2, 1, 1);
    const b = neighbourOf(a.col, a.row, 2);
    map = reducer(map, {
      type: 'applyGeneration',
      layer: 'rivers',
      data: { rivers: [{ id: 'r', name: 'R', terminus: 'Unresolved', segments: [
        { col: 2, row: 1, entryEdge: null, exitEdge: 1, navigable: false },
        { col: a.col, row: a.row, entryEdge: 4, exitEdge: 2, navigable: false },
        { col: b.col, row: b.row, entryEdge: 5, exitEdge: null, navigable: false },
      ] }] },
      warnings: [],
      notes: null,
    });
    const segs = reducer(map, { type: 'growMap', amounts: { [edge]: edge === 'top' ? 2 : 1 } }).layers.rivers.data!.rivers[0]!.segments;
    for (let i = 0; i + 1 < segs.length; i++) {
      const n = neighbourOf(segs[i]!.col, segs[i]!.row, segs[i]!.exitEdge!);
      assert.deepEqual([n.col, n.row], [segs[i + 1]!.col, segs[i + 1]!.row], `${edge}: segment ${i}`);
    }
  }
});

test('every amount on every side keeps rivers connected and cells where they were', () => {
  const amounts = [
    { top: 1 }, { top: 2 }, { bottom: 1 }, { bottom: 2 }, { left: 1 }, { left: 2 }, { right: 1 }, { right: 2 },
    { top: 1, bottom: 1 }, { top: 2, bottom: 2 }, { left: 1, right: 1 }, { left: 2, right: 2 },
    { top: 1, bottom: 1, left: 1, right: 1 },
  ];
  for (const a of amounts) {
    let map = createMapState('', 5, 5);
    const base: BaseGeo[] = Array.from({ length: 25 }, (_, i) => (i % 7 === 0 ? 'Sea' : 'Land'));
    map = reducer(map, { type: 'applyGeneration', layer: 'base', data: base, warnings: [], notes: null });
    const p = neighbourOf(2, 1, 1);
    const q = neighbourOf(p.col, p.row, 2);
    map = reducer(map, {
      type: 'applyGeneration',
      layer: 'rivers',
      data: { rivers: [{ id: 'r', name: 'R', terminus: 'Unresolved', segments: [
        { col: 2, row: 1, entryEdge: null, exitEdge: 1, navigable: false },
        { col: p.col, row: p.row, entryEdge: 4, exitEdge: 2, navigable: false },
        { col: q.col, row: q.row, entryEdge: 5, exitEdge: null, navigable: false },
      ] }] },
      warnings: [],
      notes: null,
    });
    const grown = reducer(map, { type: 'growMap', amounts: a });
    const top = a.top ?? 0;
    assert.equal(grown.rows, 5 + top + (a.bottom ?? 0), JSON.stringify(a));
    assert.equal(grown.cols, 5 + (a.left ?? 0) + (a.right ?? 0) + (top === 1 ? 1 : 0), JSON.stringify(a));
    const segs = grown.layers.rivers.data!.rivers[0]!.segments;
    for (let i = 0; i + 1 < segs.length; i++) {
      const n = neighbourOf(segs[i]!.col, segs[i]!.row, segs[i]!.exitEdge!);
      assert.deepEqual([n.col, n.row], [segs[i + 1]!.col, segs[i + 1]!.row], `${JSON.stringify(a)} segment ${i}`);
    }
    // Every old cell keeps its value at the place the river's own remapping gives it.
    const first = segs[0]!;
    assert.equal(grown.layers.base.data![first.row * grown.cols + first.col], base[1 * 5 + 2]);
  }
});

test('growing past the size limit, or by nothing, changes nothing', () => {
  let map = createMapState('', 49, 49);
  map = reducer(map, { type: 'applyGeneration', layer: 'base', data: Array(49 * 49).fill('Land'), warnings: [], notes: null });
  assert.equal(reducer(map, { type: 'growMap', amounts: { left: 2 } }), map);
  assert.equal(reducer(map, { type: 'growMap', amounts: {} }), map);
  assert.equal(reducer(map, { type: 'growMap', amounts: { top: 1, left: 1 } }), map, 'a single top row needs a spare column');
  assert.equal(reducer(map, { type: 'growMap', amounts: { top: 1 } }).cols, 50);
});
