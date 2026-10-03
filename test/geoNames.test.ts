import assert from 'node:assert/strict';
import test from 'node:test';

import { geoEligibility, islandLandHexes } from '../shared/geoNames.js';
import { createMapState } from '../shared/layers.js';
import type { BaseGeo, MapState } from '../shared/types.js';
import { reducer } from '../src/state/store.js';

const COLS = 7;
const ROWS = 7;
const at = (col: number, row: number) => row * COLS + col;

/**
 * Sea all round, with: a one-hex island at (3,1), a two-hex island at (3,3)-(4,3),
 * an island-sea hex at (1,5), a lake at (5,3), and a landmass on the west edge.
 */
function world(): MapState {
  let map = createMapState('', COLS, ROWS);
  const base: BaseGeo[] = Array(COLS * ROWS).fill('Sea');
  base[at(3, 1)] = 'Land';
  base[at(3, 3)] = 'Land';
  base[at(4, 3)] = 'Coastal Land';
  base[at(1, 5)] = 'Islands';
  base[at(5, 3)] = 'Lake';
  base[at(0, 3)] = 'Land';
  base[at(0, 4)] = 'Land';
  map = reducer(map, { type: 'applyGeneration', layer: 'base', data: base, warnings: [], notes: null });
  return map;
}

test('each kind accepts only its own hexes', () => {
  const map = world();
  const base = map.layers.base.data!;
  const seas = geoEligibility('sea', base, COLS, ROWS);
  assert.ok(seas(at(2, 2)) && seas(at(1, 5)), 'sea and island-sea hexes');
  assert.ok(!seas(at(3, 1)) && !seas(at(5, 3)), 'neither land nor lake');
  const lakes = geoEligibility('lake', base, COLS, ROWS);
  assert.ok(lakes(at(5, 3)) && !lakes(at(2, 2)));
  const land = geoEligibility('land', base, COLS, ROWS);
  assert.ok(land(at(3, 1)) && land(at(4, 3)) && !land(at(1, 5)) && !land(at(2, 2)));
  const islands = geoEligibility('island', base, COLS, ROWS);
  assert.ok(islands(at(3, 1)) && islands(at(3, 3)) && islands(at(4, 3)) && islands(at(1, 5)));
  assert.ok(!islands(at(0, 3)), 'land on the map edge may be mainland');
  assert.ok(!islands(at(2, 2)));
  assert.deepEqual([...islandLandHexes(base, COLS, ROWS)].sort((a, b) => a - b), [at(3, 1), at(3, 3), at(4, 3)]);
});

test('naming filters ineligible hexes, can extend, shrink, rename and remove a name', () => {
  let map = world();
  map = reducer(map, { type: 'nameGeo', id: 'a', kind: 'island', name: 'Tern', indices: [at(3, 3), at(2, 2), at(0, 3)] });
  assert.deepEqual(map.geoNames?.[0]?.hexes, [at(3, 3)]);
  map = reducer(map, { type: 'nameGeo', id: 'a', kind: 'island', name: 'ignored', indices: [at(4, 3)] });
  assert.deepEqual(map.geoNames?.[0]?.hexes, [at(3, 3), at(4, 3)]);
  assert.equal(map.geoNames?.[0]?.name, 'Tern', 'extending keeps the name');
  map = reducer(map, { type: 'unnameGeoHexes', id: 'a', indices: [at(4, 3)] });
  assert.deepEqual(map.geoNames?.[0]?.hexes, [at(3, 3)]);
  // The same hex can carry a land-feature name too: a different kind.
  map = reducer(map, { type: 'nameGeo', id: 'b', kind: 'land', name: 'Tern Heath', indices: [at(3, 3)] });
  assert.equal(map.geoNames?.length, 2);
  // Within a kind a hex has one name.
  map = reducer(map, { type: 'nameGeo', id: 'c', kind: 'island', name: 'Other', indices: [at(3, 3)] });
  assert.equal(map.geoNames?.find((n) => n.id === 'a'), undefined, 'a name left with no hexes is removed');
  // A kind cannot be changed by extending with another kind.
  const same = reducer(map, { type: 'nameGeo', id: 'c', kind: 'sea', name: 'x', indices: [at(2, 2)] });
  assert.equal(same, map);
  map = reducer(map, { type: 'removeGeo', id: 'b' });
  assert.deepEqual(map.geoNames?.map((n) => n.id), ['c']);
});

test('names and island specs follow their hexes when the map grows', () => {
  const edges = ['top', 'bottom', 'left', 'right'] as const;
  for (const edge of edges) {
    let map = world();
    map = reducer(map, { type: 'nameGeo', id: 's', kind: 'sea', name: 'Deep', indices: [at(2, 2), at(1, 5)] });
    map = reducer(map, { type: 'nameGeo', id: 'l', kind: 'lake', name: 'Mere', indices: [at(5, 3)] });
    map = reducer(map, { type: 'setIslandSpec', indices: [at(1, 5)], change: { large: 2 } });
    const expanded = reducer(map, { type: 'growMap', amounts: { [edge]: edge === 'top' ? 2 : 1 } });
    const dc = edge === 'left' ? 1 : 0;
    const dr = edge === 'top' ? 2 : 0;
    const to = (col: number, row: number) => (row + dr) * expanded.cols + col + dc;
    const sea = expanded.geoNames!.find((n) => n.id === 's')!;
    assert.deepEqual(sea.hexes, [to(2, 2), to(1, 5)].sort((a, b) => a - b), edge);
    assert.deepEqual(expanded.geoNames!.find((n) => n.id === 'l')!.hexes, [to(5, 3)], edge);
    assert.equal(expanded.layers.base.data![to(5, 3)], 'Lake');
    assert.equal(expanded.islandSpecs![String(to(1, 5))]?.large, 2, edge);
  }
});

test('expanding also moves names kept in the older waterNames list', () => {
  let map = world();
  map = { ...map, waterNames: [{ id: 'w', name: 'Old', hexes: [at(2, 2)] }] };
  map = reducer(map, { type: 'growMap', amounts: { left: 1 } });
  assert.deepEqual(map.geoNames?.[0]?.hexes, [2 * map.cols + 3]);
  assert.equal(map.waterNames, undefined);
});
