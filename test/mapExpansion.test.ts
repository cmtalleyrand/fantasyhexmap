import assert from 'node:assert/strict';
import test from 'node:test';

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

    const expanded = reducer(map, { type: 'expandMap', edge });
    const colShift = edge === 'left' ? 1 : 0;
    const rowShift = edge === 'top' ? 1 : 0;
    assert.equal(expanded.cols, 3 + (edge === 'left' || edge === 'right' ? 1 : 0));
    assert.equal(expanded.rows, 2 + (edge === 'top' || edge === 'bottom' ? 1 : 0));
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

  map = reducer(map, { type: 'expandMap', edge: 'top' });

  assert.deepEqual(map.layers.population.data!.slice(0, 3), [15, 40, 55]);
});
