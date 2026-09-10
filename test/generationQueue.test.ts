import assert from 'node:assert/strict';
import test from 'node:test';

import { nextGenerationWave } from '../shared/generationQueue.js';
import { createMapState } from '../shared/layers.js';

test('generation waves respect hard dependencies and the concurrency limit', () => {
  const map = createMapState('test', 8, 8);
  assert.deepEqual(nextGenerationWave(['base', 'elevation', 'climate'], map, 3), ['base']);

  map.layers.base.data = new Array(64).fill('land');
  assert.deepEqual(nextGenerationWave(['elevation', 'climate', 'rivers'], map, 2), [
    'elevation',
    'climate',
  ]);
});

test('generation waves default invalid concurrency values to one task', () => {
  const map = createMapState('test', 8, 8);
  map.layers.base.data = new Array(64).fill('land');
  assert.deepEqual(nextGenerationWave(['elevation', 'climate'], map, 0), ['elevation']);
});
