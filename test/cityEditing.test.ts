import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { reducer } from '../src/state/store.ts';

test('moving a city updates its coordinates and re-derives location facts', () => {
  const map = createMapState('City movement', 3, 1);
  map.layers.base.data = ['Land', 'Land', 'Sea'];
  map.layers.rivers.data = {
    rivers: [{
      id: 'river',
      name: 'River',
      terminus: 'Sea',
      segments: [{ col: 1, row: 0, entryEdge: null, exitEdge: 0, navigable: true }],
    }],
  };
  const city = {
    id: 'city',
    col: 0,
    row: 0,
    name: 'Old Site',
    population: 20_000,
    onRiver: false,
    riverId: null,
    coastal: false,
    coastalEdges: [],
  };
  map.layers.cities.data = { cities: [city] };

  const moved = reducer(map, { type: 'upsertCity', city: { ...city, col: 1 } });
  const result = moved.layers.cities.data?.cities[0];

  assert.equal(map.layers.cities.data.cities[0]?.col, 0);
  assert.equal(result?.col, 1);
  assert.equal(result?.row, 0);
  assert.equal(result?.onRiver, true);
  assert.equal(result?.riverId, 'river');
  assert.equal(result?.coastal, true);
  assert.ok((result?.coastalEdges.length ?? 0) > 0);
});
