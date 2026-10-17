import assert from 'node:assert/strict';
import test from 'node:test';
import { SceneBuilder } from '../src/render/sceneBuilder.ts';
import { stableMap } from '../src/render/stableMap.ts';
import type { BuildReply, BuildRequest } from '../src/render/buildProtocol.ts';
import type { Scene } from '../src/render/scene.ts';
import { createMapState } from '../shared/layers.ts';

function fixture() {
  const messages: BuildRequest[] = [];
  const worker = {
    onmessage: null as Worker['onmessage'], onerror: null as Worker['onerror'],
    postMessage: (message: BuildRequest) => messages.push(message),
    terminate: () => {},
  };
  const built: Scene[] = [];
  let failures = 0;
  const builder = new SceneBuilder({ built: scene => built.push(scene), failed: () => failures++ }, worker as unknown as Worker);
  const reply = (data: BuildReply) => worker.onmessage?.call(worker as unknown as Worker, new MessageEvent('message', { data }));
  const scene = (width: number): Scene => ({ width, height: 10, background: '#fff', prims: [] });
  const map = createMapState('Builder', 4, 4);
  const options = { size: 26, visible: {} as never, labels: false };
  return { builder, messages, reply, scene, built, map, options, failures: () => failures };
}

test('a run of edits builds the first and then only the latest, never a stale scene', () => {
  const f = fixture();
  f.builder.build(f.map, f.options, 'classic');
  f.builder.build({ ...f.map, name: 'second' }, f.options, 'classic');
  f.builder.build({ ...f.map, name: 'third' }, f.options, 'classic');
  assert.equal(f.messages.length, 1, 'one build in flight');
  f.reply({ id: f.messages[0]!.id, scene: f.scene(1) });
  assert.deepEqual(f.built, [], 'the first build is out of date once a later one is asked for');
  assert.equal(f.messages.length, 2);
  assert.equal(f.messages[1]!.map.name, 'third', 'the intermediate edit is skipped');
  f.reply({ id: f.messages[1]!.id, scene: f.scene(3) });
  assert.deepEqual(f.built.map(s => s.width), [3]);
});

test('a failed build reports failure, so the view can build on the page instead', () => {
  const f = fixture();
  f.builder.build(f.map, f.options, 'classic');
  f.reply({ id: f.messages[0]!.id, error: 'boom' });
  assert.equal(f.failures(), 1);
  assert.deepEqual(f.built, []);
});

test('the worker keeps the parts of a map that did not change, so its caches still apply', () => {
  const stable = stableMap();
  const map = createMapState('Stable', 4, 4);
  map.layers.base.data = Array(16).fill('Sea');
  map.layers.elevation.data = Array(16).fill(null);
  const first = stable(structuredClone(map));
  // The same map again, as a fresh copy: every part is the one used before.
  const again = stable(structuredClone(map));
  assert.equal(again.layers.base.data, first.layers.base.data);
  assert.equal(again.hexShapes, first.hexShapes);
  // One layer edited: that layer is new, the others are kept.
  const edited = structuredClone(map);
  edited.layers.base.data![0] = 'Land';
  const third = stable(edited);
  assert.notEqual(third.layers.base.data, first.layers.base.data);
  assert.deepEqual(third.layers.base.data![0], 'Land');
  assert.equal(third.layers.elevation.data, again.layers.elevation.data);
});
