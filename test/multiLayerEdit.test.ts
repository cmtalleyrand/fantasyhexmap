import assert from 'node:assert/strict';
import test from 'node:test';

import { createMapState } from '../shared/layers.js';
import { instructionForLayer, planMultiLayerEdit } from '../shared/multiEdit.js';

test('a multi-layer edit runs in pipeline order and skips layers with nothing to edit', () => {
  const map = createMapState('test', 8, 8);
  map.layers.base.data = new Array(64).fill('t');
  map.layers.elevation.data = new Array(64).fill('Lowland');

  const plan = planMultiLayerEdit(map, ['elevation', 'climate', 'base']);
  assert.deepEqual(plan.layers, ['base', 'elevation']);
  assert.deepEqual(plan.skipped, ['climate']);
});

test('a layer left out of the map plan is skipped even if it holds data', () => {
  const map = createMapState('test', 8, 8, undefined, ['base', 'elevation']);
  map.layers.base.data = new Array(64).fill('t');
  map.layers.climate.data = new Array(64).fill(null);
  const plan = planMultiLayerEdit(map, ['base', 'climate']);
  assert.deepEqual(plan.layers, ['base']);
  assert.deepEqual(plan.skipped, ['climate']);
});

test('each layer is told its place in the sequence', () => {
  const order = ['base', 'elevation', 'climate'] as const;
  const first = instructionForLayer('Add a volcanic island chain.', order, 'base');
  assert.match(first, /^Add a volcanic island chain\./);
  assert.match(first, /doing the Base Geography layer only/);
  assert.match(first, /will be updated after you/);
  assert.doesNotMatch(first, /already been updated/);

  const last = instructionForLayer('Add a volcanic island chain.', order, 'climate');
  assert.match(last, /already been updated/);
  assert.doesNotMatch(last, /will be updated after you/);
});

test('a single-layer edit is sent exactly as written', () => {
  assert.equal(instructionForLayer('  Move the capital. ', ['cities'], 'cities'), 'Move the capital.');
});
