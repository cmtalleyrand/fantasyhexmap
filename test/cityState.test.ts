import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityStateSeats } from '../shared/cityState.js';
import type { City, Polity } from '../shared/types.js';

const polity = (id: string, cityState?: boolean): Polity => ({ id, name: id, colour: '#888888', ...(cityState ? { cityState } : {}) });
const city = (id: string, col: number, row: number, population: number, capital?: boolean): City => ({
  id, col, row, name: id, population, onRiver: false, riverId: null, coastal: false, coastalEdges: [], ...(capital ? { capital } : {}),
});

test('a small city-state is seated at its capital, else its largest city', () => {
  const owner = ['a', 'a', null, null];
  assert.equal(cityStateSeats([polity('a', true)], owner, [city('x', 0, 0, 900), city('y', 1, 0, 100, true)], 4).get('a'), 'y');
  assert.equal(cityStateSeats([polity('a', true)], owner, [city('x', 0, 0, 900), city('y', 1, 0, 100)], 4).get('a'), 'x');
});

test('a polity that is not a city-state, is large, or has no city is not seated', () => {
  const cities = [city('x', 0, 0, 900)];
  assert.equal(cityStateSeats([polity('a')], ['a', null], cities, 2).size, 0);
  assert.equal(cityStateSeats([polity('a', true)], ['a', 'a', 'a', 'a'], cities, 4).size, 0);
  assert.equal(cityStateSeats([polity('a', true)], ['a', 'a', 'a', 'a'], cities, 4, 4).size, 1);
  assert.equal(cityStateSeats([polity('a', true)], [null, 'a'], cities, 2).size, 0);
});
