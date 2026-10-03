import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { reducer } from '../src/state/store.ts';
import type { BaseGeo, MapState, River } from '../shared/types.ts';

/** 5x1 strip: Land Land Land Land Land, with every land-only layer filled. */
function strip(extra: Partial<MapState> = {}): MapState {
  const map = createMapState('strip', 5, 1);
  map.layers.base.data = ['Land', 'Land', 'Land', 'Land', 'Land'];
  map.layers.elevation.data = ['Mountains', 'Hills', 'Rolling', 'Lowland', 'Lowland'];
  map.layers.climate.data = ['Cfb', 'Cfb', 'Cfb', 'Cfa', 'Cfa'];
  map.layers.vegetation.data = ['Coniferous Forest', 'Deciduous Forest', 'Prairie', 'Breadbasket', 'Breadbasket'];
  map.layers.population.data = [1, 2, 3, 4, 5];
  map.layers.polities.data = {
    polities: [{ id: 'p', name: 'P', colour: '#ff0000' }],
    owner: ['p', 'p', 'p', 'p', null],
  };
  map.layers.cities.data = {
    cities: [{ id: 'c', col: 1, row: 0, name: 'C', population: 100, onRiver: false, riverId: null, coastal: false, coastalEdges: [] }],
  };
  return Object.assign(map, extra);
}

const setBase = (map: MapState, indices: number[], value: BaseGeo) =>
  reducer(map, { type: 'setHexValues', layer: 'base', indices, value });

test('land turned to sea or lake clears the land-only layers at once', () => {
  for (const water of ['Sea', 'Lake'] as const) {
    const next = setBase(strip(), [1], water);
    assert.equal(next.layers.elevation.data?.[1], null);
    assert.equal(next.layers.climate.data?.[1], null);
    assert.equal(next.layers.vegetation.data?.[1], null);
    assert.equal(next.layers.population.data?.[1], null);
    // Neighbours are untouched.
    assert.equal(next.layers.elevation.data?.[0], 'Mountains');
    assert.equal(next.layers.population.data?.[2], 3);
  }
});

test('land-only layers clear for every land form, and each clear is undoable', () => {
  for (const land of ['Land', 'Coastal Land', 'Islands', 'Mainland and islands', 'Isthmus'] as const) {
    const map = strip();
    map.layers.base.data = [land, land, land, land, land];
    const next = setBase(map, [2], 'Sea');
    assert.equal(next.layers.climate.data?.[2], null);
    const undone = reducer(next, { type: 'undo', layer: 'climate' });
    assert.equal(undone.layers.climate.data?.[2], 'Cfb');
  }
});

test('a river through flooded hexes ends at the new water', () => {
  const map = strip();
  const river: River = {
    id: 'r', name: 'R', terminus: 'OffMap',
    segments: [0, 1, 2, 3, 4].map((col) => ({
      col, row: 0, entryEdge: col === 0 ? null : 3, exitEdge: 0, navigable: false,
    })),
  };
  map.layers.rivers.data = { rivers: [river] };

  const tail = setBase(map, [3, 4], 'Sea').layers.rivers.data!.rivers;
  assert.equal(tail.length, 1);
  assert.deepEqual(tail[0]!.segments.map((s) => s.col), [0, 1, 2]);
  assert.equal(tail[0]!.terminus, 'Sea');
  assert.equal(tail[0]!.segments[2]!.exitEdge, 0);

  const middle = setBase(map, [2], 'Lake').layers.rivers.data!.rivers;
  assert.equal(middle.length, 2);
  assert.deepEqual(middle[0]!.segments.map((s) => s.col), [0, 1]);
  assert.equal(middle[0]!.terminus, 'Lake');
  assert.deepEqual(middle[1]!.segments.map((s) => s.col), [3, 4]);
  // The lower course now flows out of the new lake, entering from it.
  assert.equal(middle[1]!.fromLake, true);
  assert.equal(middle[1]!.segments[0]!.entryEdge, 3);

  const whole = setBase(map, [0, 1, 2, 3, 4], 'Sea').layers.rivers.data!.rivers;
  assert.equal(whole.length, 0);
});

test('water turned to land is filled from the surrounding land', () => {
  const map = strip();
  map.layers.base.data = ['Land', 'Land', 'Sea', 'Land', 'Land'];
  map.layers.elevation.data = ['Mountains', 'Mountains', null, 'Lowland', 'Lowland'];
  map.layers.climate.data = ['Cfb', 'Cfb', null, 'Cfb', 'Cfb'];
  map.layers.vegetation.data = ['Prairie', 'Prairie', null, 'Prairie', 'Prairie'];
  map.layers.population.data = [5, 5, null, 5, 5];
  map.layers.polities.data!.owner = ['p', 'p', null, 'p', 'p'];

  const next = setBase(map, [2], 'Coastal Land');
  assert.equal(next.layers.climate.data?.[2], 'Cfb');
  assert.equal(next.layers.vegetation.data?.[2], 'Prairie');
  assert.equal(next.layers.population.data?.[2], 0);
  assert.equal(next.layers.polities.data?.owner[2], 'p');
  // Mountains and Lowland tie; the lower wins, and a Mountain donor would be stepped down.
  assert.equal(next.layers.elevation.data?.[2], 'Lowland');
});

test('new land only fills layers that are enabled and generated', () => {
  const map = strip();
  map.layers.base.data = ['Land', 'Sea', 'Land', 'Land', 'Land'];
  map.layers.climate.data = ['Cfb', null, 'Cfb', 'Cfb', 'Cfb'];
  map.layers.vegetation.data = null;
  map.enabledLayers = map.enabledLayers.filter((id) => id !== 'population');
  map.layers.population.data = [1, null, 1, 1, 1];

  const next = setBase(map, [1], 'Land');
  assert.equal(next.layers.climate.data?.[1], 'Cfb');
  assert.equal(next.layers.vegetation.data, null);
  assert.equal(next.layers.population.data?.[1], null);
});

test('an Islands hex raised from the sea is lowland', () => {
  const map = strip();
  map.layers.base.data = ['Land', 'Sea', 'Land', 'Land', 'Land'];
  map.layers.elevation.data = ['Mountains', null, 'Mountains', 'Mountains', 'Mountains'];
  assert.equal(setBase(map, [1], 'Islands').layers.elevation.data?.[1], 'Lowland');
  assert.equal(setBase(map, [1], 'Land').layers.elevation.data?.[1], 'Highland');
});

test('cities and polity claims on water are dropped unless the map allows them', () => {
  const dropped = setBase(strip(), [1], 'Sea');
  assert.equal(dropped.layers.cities.data?.cities.length, 0);
  assert.equal(dropped.layers.polities.data?.owner[1], null);

  const kept = setBase(strip({ allowUnderwater: true }), [1], 'Sea');
  assert.equal(kept.layers.cities.data?.cities.length, 1);
  assert.equal(kept.layers.polities.data?.owner[1], 'p');
  // Land-only layers still clear: allowing settlement does not make water farmland.
  assert.equal(kept.layers.vegetation.data?.[1], null);
});

test('underwater placement is refused by default and allowed by the option', () => {
  const map = strip();
  map.layers.base.data = ['Land', 'Sea', 'Land', 'Land', 'Land'];
  map.layers.polities.data!.owner[1] = null;
  const city = { id: 'd', col: 1, row: 0, name: 'D', population: 5, onRiver: false, riverId: null, coastal: false, coastalEdges: [] };

  assert.equal(reducer(map, { type: 'upsertCity', city }).layers.cities.data?.cities.length, 1);
  assert.equal(reducer(map, { type: 'setPolityOwner', indices: [1], polityId: 'p' }).layers.polities.data?.owner[1], null);

  const allowed = reducer(map, { type: 'setAllowUnderwater', allow: true });
  assert.equal(reducer(allowed, { type: 'upsertCity', city }).layers.cities.data?.cities.length, 2);
  assert.equal(reducer(allowed, { type: 'setPolityOwner', indices: [1], polityId: 'p' }).layers.polities.data?.owner[1], 'p');
});

test('switching the option off removes what it allowed, undoably', () => {
  const on = strip({ allowUnderwater: true });
  const flooded = setBase(on, [1], 'Sea');
  const off = reducer(flooded, { type: 'setAllowUnderwater', allow: false });
  assert.equal(off.allowUnderwater, false);
  assert.equal(off.layers.cities.data?.cities.length, 0);
  assert.equal(off.layers.polities.data?.owner[1], null);
  assert.equal(reducer(off, { type: 'undo', layer: 'cities' }).layers.cities.data?.cities.length, 1);
});
