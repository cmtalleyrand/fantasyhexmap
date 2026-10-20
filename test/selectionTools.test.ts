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
