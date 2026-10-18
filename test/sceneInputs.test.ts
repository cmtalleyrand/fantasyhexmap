import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { renderSnapshot, SceneInputs } from '../src/render/sceneInputs.ts';

test('worker snapshots retain unchanged layer identities and restore them on undo', () => {
  const inputs = new SceneInputs();
  const map = createMapState('cache', 4, 4);
  map.layers.base.data = Array(16).fill('Land');
  const first = inputs.retain(structuredClone(map));
  const display = inputs.retain(structuredClone(map));
  assert.equal(display, first);
  const edit = structuredClone(map);
  edit.layers.base.data![0] = 'Sea';
  const changed = inputs.retain(edit);
  assert.notEqual(changed.layers.base.data, first.layers.base.data);
  assert.equal(changed.layers.elevation, first.layers.elevation);
  const undo = inputs.retain(structuredClone(map));
  assert.equal(undo.layers.base.data, first.layers.base.data);
  assert.equal(first.layers.base.data![0], 'Land', 'retention must not mutate previous snapshots');
  const redo = inputs.retain(structuredClone(edit));
  assert.equal(redo.layers.base.data, changed.layers.base.data);
});

test('another map cannot reuse seed-dependent input identities', () => {
  const inputs = new SceneInputs();
  const map = createMapState('cache', 4, 4);
  const first = inputs.retain(map);
  const other = structuredClone(map);
  other.id += '-other';
  assert.notEqual(inputs.retain(other), first);
});

test('render snapshots exclude undo payloads while retaining current render data', () => {
  const map = createMapState('snapshot', 4, 4);
  map.layers.base.past.push({ data: Array(16).fill('Sea'), notes: 'old generation', warnings: [], generatedAt: 1, depVersions: {} });
  const snapshot = renderSnapshot(map);
  assert.equal(snapshot.layers.base.data, map.layers.base.data);
  assert.deepEqual(snapshot.layers.base.past, []);
  assert.deepEqual(snapshot.journal, []);
  assert.equal(snapshot.history, undefined);
  assert.equal(map.layers.base.past.length, 1);
});
