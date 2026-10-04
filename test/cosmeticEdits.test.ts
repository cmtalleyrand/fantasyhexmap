import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState, stalenessOf } from '../shared/layers.ts';
import type { LayerDataMap, LayerId, MapState } from '../shared/types.ts';
import { reducer, type Action } from '../src/state/store.ts';

/** A small map whose layers were all generated in order, so nothing starts stale. */
function generatedMap(): MapState {
  let map = createMapState('Renames', 3, 1, 'Renames', ['base', 'rivers', 'cities', 'polities', 'population']);
  const generate = <K extends LayerId>(layer: K, data: LayerDataMap[K]) => {
    map = reducer(map, { type: 'applyGeneration', layer, data, warnings: [], notes: null } as Action);
  };
  generate('base', ['Land', 'Land', 'Sea']);
  generate('rivers', {
    rivers: [{
      id: 'river',
      name: 'Kelder',
      terminus: 'Sea',
      segments: [
        { col: 0, row: 0, entryEdge: null, exitEdge: 0, navigable: true },
        { col: 1, row: 0, entryEdge: 3, exitEdge: 0, navigable: true },
      ],
    }],
  });
  generate('cities', {
    cities: [{
      id: 'city',
      col: 1,
      row: 0,
      name: 'Old Port',
      population: 20_000,
      onRiver: true,
      riverId: 'river',
      coastal: true,
      coastalEdges: [0],
    }],
  });
  generate('polities', {
    polities: [{ id: 'realm', name: 'The Ardhic League', colour: '#b5533c' }],
    owner: ['realm', 'realm', null],
  });
  generate('population', [100, 200, null]);
  return map;
}

const staleLayers = (map: MapState) =>
  (['rivers', 'cities', 'polities', 'population'] as const).filter((id) => stalenessOf(map, id).stale);

test('the fixture starts with nothing stale', () => {
  assert.deepEqual(staleLayers(generatedMap()), []);
});

test('renaming a river is undoable but marks nothing stale', () => {
  const map = generatedMap();
  const river = map.layers.rivers.data!.rivers[0]!;
  const renamed = reducer(map, { type: 'updateRiver', river: { ...river, name: 'Kelder Major' } });

  assert.equal(renamed.layers.rivers.data!.rivers[0]!.name, 'Kelder Major');
  assert.equal(renamed.layers.rivers.past.length, map.layers.rivers.past.length + 1);
  assert.equal(renamed.layers.rivers.version, map.layers.rivers.version);
  assert.deepEqual(staleLayers(renamed), []);

  const undone = reducer(renamed, { type: 'undo', layer: 'rivers' });
  assert.equal(undone.layers.rivers.data!.rivers[0]!.name, 'Kelder');
  assert.equal(undone.layers.rivers.version, map.layers.rivers.version);
  assert.deepEqual(staleLayers(undone), []);

  const redone = reducer(undone, { type: 'redo', layer: 'rivers' });
  assert.equal(redone.layers.rivers.data!.rivers[0]!.name, 'Kelder Major');
  assert.deepEqual(staleLayers(redone), []);
});

test('renaming or recolouring a polity marks nothing stale', () => {
  const map = generatedMap();
  const polity = map.layers.polities.data!.polities[0]!;
  const renamed = reducer(map, {
    type: 'upsertPolity',
    polity: { ...polity, name: 'The Ardhic Crown', shortName: 'Ardh', colour: '#336699' },
  });
  assert.equal(renamed.layers.polities.version, map.layers.polities.version);
  assert.equal(renamed.layers.polities.past.length, map.layers.polities.past.length + 1);
  assert.deepEqual(staleLayers(renamed), []);

  const recoloured = reducer(renamed, { type: 'setPolityColours', colours: { realm: '#112233' } });
  assert.equal(recoloured.layers.polities.version, map.layers.polities.version);
  assert.deepEqual(staleLayers(recoloured), []);
});

test('renaming a city marks nothing stale, but changing its population does', () => {
  const map = generatedMap();
  const city = map.layers.cities.data!.cities[0]!;
  const renamed = reducer(map, { type: 'upsertCity', city: { ...city, name: 'New Port' } });
  assert.equal(renamed.layers.cities.version, map.layers.cities.version);
  assert.deepEqual(staleLayers(renamed), []);

  const grown = reducer(renamed, { type: 'upsertCity', city: { ...city, name: 'New Port', population: 90_000 } });
  assert.equal(grown.layers.cities.version, map.layers.cities.version + 1);
  assert.deepEqual(staleLayers(grown), ['polities', 'population']);
});

test('an edit that changes nothing is not recorded at all', () => {
  const map = generatedMap();
  const river = map.layers.rivers.data!.rivers[0]!;
  const polity = map.layers.polities.data!.polities[0]!;
  const city = map.layers.cities.data!.cities[0]!;
  assert.equal(reducer(map, { type: 'updateRiver', river: { ...river } }), map);
  assert.equal(reducer(map, { type: 'upsertPolity', polity: { ...polity } }), map);
  assert.equal(reducer(map, { type: 'upsertCity', city: { ...city } }), map);
  assert.equal(reducer(map, { type: 'setPolityColours', colours: {} }), map);
});

test('whole-map undo restores the exact dependency version from before an edit', () => {
  const map = generatedMap();
  const moved = reducer(map, { type: 'setPolityOwner', indices: [1], polityId: null });
  assert.equal(moved.layers.polities.version, map.layers.polities.version + 1);
  const polity = moved.layers.polities.data!.polities[0]!;
  const renamed = reducer(moved, { type: 'upsertPolity', polity: { ...polity, name: 'Renamed' } });
  const undoRename = reducer(renamed, { type: 'undo', layer: 'polities' });
  assert.equal(undoRename.layers.polities.version, moved.layers.polities.version);
  const undoMove = reducer(undoRename, { type: 'undo', layer: 'polities' });
  assert.equal(undoMove.layers.polities.data!.owner[1], 'realm');
  assert.equal(undoMove.layers.polities.version, map.layers.polities.version);
  assert.deepEqual(staleLayers(undoMove), []);
});

test('a generation that only renames polities, such as short names, marks nothing stale', () => {
  const map = generatedMap();
  const data = map.layers.polities.data!;
  const named = reducer(map, {
    type: 'applyGeneration',
    layer: 'polities',
    data: { ...data, polities: data.polities.map((p) => ({ ...p, shortName: 'Ardh' })) },
    warnings: [],
    notes: null,
  });
  assert.equal(named.layers.polities.version, map.layers.polities.version);
  assert.deepEqual(staleLayers(named), []);
});

test('a brush stroke that changes no hex is not recorded', () => {
  const map = generatedMap();
  // Hex 2 is Sea, so the claim is ignored; hex 0 already belongs to the realm.
  assert.equal(reducer(map, { type: 'setPolityOwner', indices: [2], polityId: 'realm' }), map);
  assert.equal(reducer(map, { type: 'setPolityOwner', indices: [0], polityId: 'realm' }), map);
  assert.equal(reducer(map, { type: 'setHexValues', layer: 'population', indices: [0], value: 100 }), map);
  assert.notEqual(reducer(map, { type: 'setHexValues', layer: 'population', indices: [0], value: 150 }), map);
});
