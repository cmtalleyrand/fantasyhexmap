import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { politySurfaceAreas } from '../shared/surfaceArea.ts';
import { reducer } from '../src/state/store.ts';

test('polity surface area weights coast and island land shares', () => {
  const areas = politySurfaceAreas(
    ['Land', 'Coastal Land', 'Islands', 'Sea'],
    {
      polities: [{ id: 'realm', name: 'Realm', colour: '#123456' }],
      owner: ['realm', 'realm', 'realm', 'realm'],
    },
    { width: 10, height: 8, unit: 'km', coastalLandPercent: 60, islandLandPercent: 40 },
    // One small islet, as the old single Island was.
    { '2': { large: 0, small: 1 } },
  );

  // Each hex is 60 km²; weighted land is 1 + 0.6 + 0.4 hexes. Sea contributes zero.
  assert.equal(areas.get('realm'), 120);
});

test('polity surface area remains linear across multiple owners', () => {
  const areas = politySurfaceAreas(
    ['Land', 'Land', 'Coastal Land'],
    {
      polities: [
        { id: 'a', name: 'A', colour: '#111111' },
        { id: 'b', name: 'B', colour: '#222222' },
      ],
      owner: ['a', 'b', 'b'],
    },
    { width: 4, height: 2, unit: 'mi', coastalLandPercent: 50, islandLandPercent: 40 },
  );

  assert.deepEqual(Object.fromEntries(areas), { a: 6, b: 9 });
});

test('area settings can be changed after a map has been created', () => {
  const map = createMapState('Editable dimensions', 3, 3);
  const updated = reducer(map, {
    type: 'setHexDimensions',
    hexDimensions: {
      width: 24,
      height: 20,
      unit: 'mi',
      coastalLandPercent: 70,
      islandLandPercent: 30,
    },
  });

  assert.deepEqual(updated.hexDimensions, {
    width: 24,
    height: 20,
    unit: 'mi',
    coastalLandPercent: 70,
    islandLandPercent: 30,
  });
  assert.ok(updated.updatedAt >= map.updatedAt);
});
