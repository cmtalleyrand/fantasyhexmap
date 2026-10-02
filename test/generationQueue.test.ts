import assert from 'node:assert/strict';
import test from 'node:test';

import { generationOrder, nextGenerationWave } from '../shared/generationQueue.js';
import { LAYER_META } from '../shared/layers.js';
import { LAYER_ORDER, type LayerId } from '../shared/types.js';
import { createMapState } from '../shared/layers.js';

test('generation waves respect hard dependencies and the concurrency limit', () => {
  const map = createMapState('test', 8, 8);
  assert.deepEqual(nextGenerationWave(['base', 'elevation', 'climate'], map, 3), ['base']);

  map.layers.base.data = new Array(64).fill('land');
  assert.deepEqual(nextGenerationWave(['elevation', 'vegetation', 'cities'], map, 2), [
    'elevation',
  ]);
  assert.deepEqual(nextGenerationWave(['climate', 'rivers', 'polities'], map, 3), [
    'climate',
    'rivers',
  ]);
});

test('generation waves default invalid concurrency values to one task', () => {
  const map = createMapState('test', 8, 8);
  map.layers.base.data = new Array(64).fill('land');
  assert.deepEqual(nextGenerationWave(['elevation', 'climate'], map, 0), ['elevation']);
});

test('generation order puts every layer after everything it reads', () => {
  const order = generationOrder();
  assert.deepEqual(order, [
    'base',
    'elevation',
    'climate',
    'rivers',
    'vegetation',
    'cities',
    'polities',
    'population',
  ]);
  for (const id of order) {
    for (const dep of [...LAYER_META[id].requires, ...LAYER_META[id].uses]) {
      assert.ok(order.indexOf(dep) < order.indexOf(id), `${dep} before ${id}`);
    }
  }
});

test('a whole batch never runs a layer alongside one of its own inputs', () => {
  for (const concurrency of [1, 2, 4]) {
    const map = createMapState('test', 8, 8);
    let pending: LayerId[] = [...LAYER_ORDER];
    const finished: LayerId[] = [];
    while (pending.length > 0) {
      const wave = nextGenerationWave(pending, map, concurrency);
      assert.ok(wave.length > 0, `stalled with ${pending.join(', ')} pending`);
      for (const id of wave) {
        for (const dep of [...LAYER_META[id].requires, ...LAYER_META[id].uses]) {
          assert.ok(finished.includes(dep), `${id} ran before its input ${dep} (concurrency ${concurrency})`);
        }
      }
      for (const id of wave) (map.layers[id] as { data: unknown }).data = [];
      finished.push(...wave);
      pending = pending.filter((id) => !wave.includes(id));
    }
    assert.equal(finished.length, LAYER_ORDER.length);
  }
});
