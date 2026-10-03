import assert from 'node:assert/strict';
import test from 'node:test';

import { customLayersOf } from '../shared/customLayers.js';
import { createMapState } from '../shared/layers.js';
import { buildScene } from '../src/render/scene.js';
import { defaultVisibility } from '../src/render/scene.js';
import { customLegendSections, DEFAULT_LEGEND_OPTIONS } from '../src/render/legend.js';
import { reducer } from '../src/state/store.js';

function withLayer() {
  let map = createMapState('', 6, 5);
  map = reducer(map, { type: 'addCustomLayer', id: 'c1', name: 'Trade routes' });
  return map;
}

test('adding a layer gives it a first category and leaves the built-in layers alone', () => {
  const map = withLayer();
  const [layer] = customLayersOf(map);
  assert.equal(layer!.name, 'Trade routes');
  assert.equal(layer!.categories.length, 1);
  assert.deepEqual(layer!.values, {});
  assert.equal(map.layers.base.version, 0, 'no built-in layer changes, so nothing goes stale');
});

test('hexes are assigned, reassigned, and erased; unknown categories and out-of-grid hexes are ignored', () => {
  let map = withLayer();
  const cat = customLayersOf(map)[0]!.categories[0]!.id;
  map = reducer(map, { type: 'setCustomHexes', layerId: 'c1', indices: [1, 2, 99, -1], categoryId: cat });
  assert.deepEqual(customLayersOf(map)[0]!.values, { '1': cat, '2': cat });
  const unchanged = reducer(map, { type: 'setCustomHexes', layerId: 'c1', indices: [3], categoryId: 'nope' });
  assert.deepEqual(customLayersOf(unchanged)[0]!.values, { '1': cat, '2': cat });
  map = reducer(map, { type: 'setCustomHexes', layerId: 'c1', indices: [1], categoryId: null });
  assert.deepEqual(customLayersOf(map)[0]!.values, { '2': cat });
});

test('removing a category unassigns its hexes; bad colours and blank names are refused', () => {
  let map = withLayer();
  map = reducer(map, { type: 'addCustomCategory', layerId: 'c1', id: 'k2', name: 'Roads' });
  const first = customLayersOf(map)[0]!.categories[0]!.id;
  map = reducer(map, { type: 'setCustomHexes', layerId: 'c1', indices: [0, 1], categoryId: first });
  map = reducer(map, { type: 'setCustomHexes', layerId: 'c1', indices: [2], categoryId: 'k2' });
  map = reducer(map, { type: 'updateCustomCategory', layerId: 'c1', id: 'k2', colour: 'red; x', name: '  ' });
  const roads = customLayersOf(map)[0]!.categories.find((c) => c.id === 'k2')!;
  assert.equal(roads.name, 'Roads');
  assert.match(roads.colour, /^#[0-9a-f]{6}$/i);
  map = reducer(map, { type: 'removeCustomCategory', layerId: 'c1', id: first });
  assert.deepEqual(customLayersOf(map)[0]!.values, { '2': 'k2' });
});

test('a shown layer is drawn, a hidden one is not, and exports can leave it out', () => {
  let map = withLayer();
  const cat = customLayersOf(map)[0]!.categories[0]!.id;
  map = reducer(map, { type: 'setCustomHexes', layerId: 'c1', indices: [0, 7], categoryId: cat });
  const count = (m: typeof map, customLayers?: boolean) =>
    buildScene(m, { size: 20, visible: defaultVisibility(), labels: false, customLayers }).prims.length;
  const bare = count(createMapState('', 6, 5));
  assert.equal(count(map), bare + 2);
  assert.equal(count(map, false), bare);
  assert.equal(count(reducer(map, { type: 'setCustomLayerShown', id: 'c1', shown: false })), bare);
  const sections = customLegendSections(map, DEFAULT_LEGEND_OPTIONS);
  assert.equal(sections.length, 1);
  assert.equal(sections[0]!.title, 'Trade routes');
});

test('growing the map keeps custom hexes on the same places', () => {
  let map = withLayer();
  const cat = customLayersOf(map)[0]!.categories[0]!.id;
  map = reducer(map, { type: 'setCustomHexes', layerId: 'c1', indices: [0], categoryId: cat });
  map = reducer(map, { type: 'growMap', amounts: { left: 1 } });
  assert.equal(map.cols, 7);
  assert.deepEqual(Object.keys(customLayersOf(map)[0]!.values), ['1'], 'old (0,0) is now (1,0)');
});

test('deleting a layer removes it', () => {
  const map = reducer(withLayer(), { type: 'removeCustomLayer', id: 'c1' });
  assert.equal(customLayersOf(map).length, 0);
});
