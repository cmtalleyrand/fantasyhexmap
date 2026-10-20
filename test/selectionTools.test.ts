import test from 'node:test';
import assert from 'node:assert/strict';
import { applySelectionStroke } from '../src/state/workspace.js';
import { decorationPrims } from '../src/render/scene.js';
import { createMapState } from '../shared/layers.js';

test('selection strokes consistently replace, add or remove across mixed hexes', () => {
  const initial = new Set([1, 2, 3]);
  const touched = new Set([2, 3, 4]);
  assert.deepEqual([...applySelectionStroke(initial, touched, 'replace')], [2, 3, 4]);
  assert.deepEqual([...applySelectionStroke(initial, touched, 'add')], [1, 2, 3, 4]);
  assert.deepEqual([...applySelectionStroke(initial, touched, 'remove')], [1]);
  assert.deepEqual([...initial], [1, 2, 3], 'a stroke keeps its starting selection intact');
});

test('current feature area and selection remain distinct even on the same hex', () => {
  const map = createMapState('', 3, 3);
  const prims = decorationPrims(map, { size: 26, featureArea: [4], selection: new Set([4]) });
  assert.equal(prims.length, 2);
  const [area, selection] = prims;
  assert.ok(area?.kind === 'polygon' && selection?.kind === 'polygon');
  assert.notEqual(area.stroke, selection.stroke);
  assert.notDeepEqual(area.points, selection.points, 'selection is inset so both outlines remain visible');
  const noSelection = decorationPrims(map, { size: 26, featureArea: [4], selection: new Set() });
  assert.equal(noSelection.length, 1, 'a visible feature does not imply selected hexes');
});

test('addition and removal previews differ and ignore out-of-bounds hexes', () => {
  const map = createMapState('', 3, 3);
  const opts = { size: 26, areaStroke: new Set([4, -1, 9]) };
  const add = decorationPrims(map, { ...opts, areaStrokeMode: 'add' });
  const remove = decorationPrims(map, { ...opts, areaStrokeMode: 'remove' });
  assert.equal(add.length, 1);
  assert.equal(remove.length, 1);
  assert.ok(add[0]?.kind === 'polygon' && remove[0]?.kind === 'polygon');
  assert.notEqual(add[0].stroke, remove[0].stroke);
});

// Named features keep their saved extent when a separate edit selection changes.
import { featureFocus } from '../src/state/featureFocus.js';
import { reducer } from '../src/state/store.js';
import { holdersOf } from '../shared/polityShares.js';

function editorMap() {
  let map = createMapState('', 4, 2);
  map = reducer(map, { type: 'applyGeneration', layer: 'base', data: Array(8).fill('Land'), warnings: [], notes: null });
  map = reducer(map, { type: 'applyGeneration', layer: 'elevation', data: ['Lowland', 'Mountains', 'Highland', 'Mountains', 'Lowland', 'Lowland', 'Lowland', 'Lowland'], warnings: [], notes: null });
  map.mountainRanges = [{ id: 'r', name: 'A very long mountain range name', hexes: [0, 1, 2] }];
  map = reducer(map, { type: 'applyGeneration', layer: 'polities', data: { polities: [{ id: 'a', name: 'A', colour: '#aa0000' }, { id: 'b', name: 'B', colour: '#0000aa' }], owner: ['a', 'a', 'b', null, null, null, null, null], shares: { '1': { polityId: 'b', share: .25 } } }, warnings: [], notes: null });
  return map;
}

test('range focus excludes changed terrain and reads the latest name and extent', () => {
  const map = editorMap();
  assert.deepEqual(featureFocus(map, 'elevation', 'r')?.hexes, [1, 2]);
  const renamed = reducer(map, { type: 'renameMountainRange', id: 'r', name: 'New name' });
  assert.equal(featureFocus(renamed, 'elevation', 'r')?.name, 'New name');
  assert.equal(featureFocus(map, 'elevation', 'missing'), null);
});

test('removing range hexes retains other assignments and supports undo', () => {
  const map = editorMap();
  const removed = reducer(map, { type: 'unnameMountainRangeHexes', id: 'r', indices: [1, 7] });
  assert.deepEqual(removed.mountainRanges?.[0]?.hexes, [0, 2]);
  assert.deepEqual(reducer(removed, { type: 'undo' }).mountainRanges, map.mountainRanges);
  const emptied = reducer(removed, { type: 'unnameMountainRangeHexes', id: 'r', indices: [0, 2] });
  assert.equal(featureFocus(emptied, 'elevation', 'r'), null);
});

test('removing polity claims preserves the other holder and ignores unrelated hexes', () => {
  const map = editorMap();
  assert.deepEqual(featureFocus(map, 'polities', 'b')?.hexes, [1, 2]);
  const removed = reducer(map, { type: 'removePolityClaims', id: 'a', indices: [0, 1, 2, -1, 999] });
  assert.deepEqual(removed.layers.polities.data?.owner.slice(0, 3), [null, 'b', 'b']);
  assert.deepEqual(holdersOf(removed.layers.polities.data!, 1), [['b', 1]]);
  assert.deepEqual(reducer(removed, { type: 'undo' }).layers.polities.data, map.layers.polities.data);
  const minorityRemoved = reducer(map, { type: 'removePolityClaims', id: 'b', indices: [1] });
  assert.deepEqual(holdersOf(minorityRemoved.layers.polities.data!, 1), [['a', 1]]);
});
