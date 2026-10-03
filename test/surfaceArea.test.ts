import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { DEFAULT_HEX_DIMENSIONS } from '../shared/types.ts';
import { formatArea, politySurfaceAreas } from '../shared/surfaceArea.ts';
import { reducer } from '../src/state/store.ts';

test('polity surface area weights coast and island land shares', () => {
  const areas = politySurfaceAreas(
    ['Land', 'Coastal Land', 'Islands', 'Sea'],
    {
      polities: [{ id: 'realm', name: 'Realm', colour: '#123456' }],
      owner: ['realm', 'realm', 'realm', 'realm'],
    },
    { ...DEFAULT_HEX_DIMENSIONS, width: 10, height: 8, coastalLandPercent: 60, smallIslandPercent: 40 },
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
    { ...DEFAULT_HEX_DIMENSIONS, width: 4, height: 2, unit: 'mi', coastalLandPercent: 50 },
  );

  assert.deepEqual(Object.fromEntries(areas), { a: 6, b: 9 });
});

test('area settings can be changed after a map has been created', () => {
  const map = createMapState('Editable dimensions', 3, 3);
  const updated = reducer(map, {
    type: 'setHexDimensions',
    hexDimensions: {
      ...DEFAULT_HEX_DIMENSIONS,
      width: 24,
      height: 20,
      unit: 'mi',
      coastalLandPercent: 70,
      smallIslandPercent: 15,
      areaRounding: 50,
      lengthRounding: 5,
    },
  });

  assert.deepEqual(updated.hexDimensions, {
    ...DEFAULT_HEX_DIMENSIONS,
    width: 24,
    height: 20,
    unit: 'mi',
    coastalLandPercent: 70,
    smallIslandPercent: 15,
    areaRounding: 50,
    lengthRounding: 5,
  });
  assert.ok(updated.updatedAt >= map.updatedAt);
});

test('surface areas round to the configured display increment', () => {
  assert.equal(formatArea(1249, 'km'), '1,200 km²');
  assert.equal(formatArea(1249, 'km', 50), '1,250 km²');
  assert.equal(formatArea(12.34, 'mi', 0.5), '12.5 mi²');
});

test('an unowned strait is shared between the realms on its banks; an owned one is not', async () => {
  const { straitSharers } = await import('../shared/straits.ts');
  const polities = [
    { id: 'a', name: 'A', colour: '#111111' },
    { id: 'b', name: 'B', colour: '#222222' },
  ];
  const dims = { ...DEFAULT_HEX_DIMENSIONS, width: 4, height: 2, unit: 'mi', straitPercent: 100 };
  // One row: land, strait, land. Hex area is 4 * 2 * 0.75 = 6.
  const base = ['Land', 'Strait', 'Land'] as const;
  const shared = politySurfaceAreas([...base], { polities, owner: ['a', null, 'b'] }, dims, undefined, undefined, 3);
  assert.deepEqual(Object.fromEntries(shared), { a: 9, b: 9 });
  assert.deepEqual(Object.fromEntries(straitSharers([...base], ['a', null, 'b'], 3, 1, 1)), { a: 0.5, b: 0.5 });
  const owned = politySurfaceAreas([...base], { polities, owner: ['a', 'a', 'b'] }, dims, undefined, undefined, 3);
  assert.deepEqual(Object.fromEntries(owned), { a: 12, b: 6 });
  assert.equal(straitSharers([...base], ['a', 'a', 'b'], 3, 1, 1).size, 0);
});
