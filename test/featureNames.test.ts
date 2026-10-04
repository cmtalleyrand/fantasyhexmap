import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import { reducer } from '../src/state/store.ts';
import { buildRiverFromPath } from '../shared/validate.ts';
import type { MapState } from '../shared/types.ts';

const COLS = 10;
const ROWS = 6;

function mapWithTerrain(): MapState {
  let map = createMapState('Test.', COLS, ROWS, 'Test');
  const base = Array.from({ length: COLS * ROWS }, () => 'Land' as const);
  const elevation = Array.from({ length: COLS * ROWS }, (_, i) =>
    i >= 2 * COLS + 2 && i <= 2 * COLS + 6 ? ('Mountains' as const) : ('Lowland' as const),
  );
  map = reducer(map, { type: 'applyGeneration', layer: 'base', data: base, warnings: [], notes: null });
  map = reducer(map, { type: 'applyGeneration', layer: 'elevation', data: elevation, warnings: [], notes: null });
  const river = buildRiverFromPath(
    { name: 'Silverrun', path: [1, 2, 3, 4, 5, 6, 7].map((col) => ({ col, row: 4 })), navigable: [] },
    'r1',
    base,
    null,
    COLS,
    ROWS,
    [],
  );
  assert.ok(river);
  return reducer(map, { type: 'addRiver', river });
}

const visible = { ...defaultVisibility(), elevation: true, rivers: true };
const texts = (map: MapState, opts: { riverNames?: boolean; rangeNames?: boolean; seaNames?: boolean; landNames?: boolean }) =>
  buildScene(map, { size: 32, visible, labels: false, ...opts }).prims.flatMap((p) =>
    p.kind === 'text' ? [p.text] : [],
  );

test('names are off unless asked for', () => {
  let map = mapWithTerrain();
  map = reducer(map, { type: 'nameMountainRange', id: 'm1', name: 'Kelder Spine', indices: [2 * COLS + 3] });
  assert.deepEqual(texts(map, {}), []);
});

test('river and range names are drawn when enabled', () => {
  let map = mapWithTerrain();
  map = reducer(map, {
    type: 'nameMountainRange',
    id: 'm1',
    name: 'Kelder Spine',
    indices: [2 * COLS + 2, 2 * COLS + 3, 2 * COLS + 4, 0],
  });
  assert.deepEqual(map.mountainRanges?.[0]?.hexes, [2 * COLS + 2, 2 * COLS + 3, 2 * COLS + 4]);
  assert.deepEqual(texts(map, { riverNames: true }), ['Silverrun']);
  assert.deepEqual(texts(map, { rangeNames: true }), ['KELDER SPINE']);
});

test('a hex belongs to one range, and ranges that stop being mountains vanish', () => {
  let map = mapWithTerrain();
  const a = 2 * COLS + 2;
  const b = 2 * COLS + 3;
  map = reducer(map, { type: 'nameMountainRange', id: 'm1', name: 'One', indices: [a, b] });
  map = reducer(map, { type: 'nameMountainRange', id: 'm2', name: 'Two', indices: [b] });
  assert.deepEqual(map.mountainRanges?.find((r) => r.id === 'm1')?.hexes, [a]);
  map = reducer(map, { type: 'setHexValues', layer: 'elevation', indices: [a, b], value: 'Hills' });
  assert.deepEqual(texts(map, { rangeNames: true }), []);
});

test('rename and remove', () => {
  let map = mapWithTerrain();
  map = reducer(map, { type: 'nameMountainRange', id: 'm1', name: 'One', indices: [2 * COLS + 2] });
  map = reducer(map, { type: 'renameMountainRange', id: 'm1', name: 'Uno' });
  assert.equal(map.mountainRanges?.[0]?.name, 'Uno');
  map = reducer(map, { type: 'removeMountainRange', id: 'm1' });
  assert.deepEqual(map.mountainRanges, []);
});

test('individual geographical names can be excluded from the rendered map', () => {
  let map = mapWithTerrain();
  map = reducer(map, { type: 'nameGeo', id: 'land-1', kind: 'land', name: 'Green Reach', indices: [20, 21, 22] });
  map = reducer(map, { type: 'nameGeo', id: 'land-2', kind: 'land', name: 'Red Reach', indices: [30, 31, 32] });
  assert.deepEqual(texts(map, { landNames: true }).sort(), ['GREEN REACH', 'RED REACH']);

  map = reducer(map, { type: 'setGeoNameHidden', id: 'land-1', hidden: true });
  assert.equal(map.geoNames?.find((name) => name.id === 'land-1')?.hidden, true);
  assert.deepEqual(texts(map, { landNames: true }), ['RED REACH']);

  map = reducer(map, { type: 'setGeoNameHidden', id: 'land-1', hidden: false });
  assert.equal(map.geoNames?.find((name) => name.id === 'land-1')?.hidden, false);
  assert.deepEqual(texts(map, { landNames: true }).sort(), ['GREEN REACH', 'RED REACH']);
});
