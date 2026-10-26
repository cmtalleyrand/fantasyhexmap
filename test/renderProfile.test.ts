import assert from 'node:assert/strict';
import test from 'node:test';
import { beginRenderProfile, endRenderProfile, profileCount, profileTime, profilePhases } from '../src/render/profile.ts';
import { buildStaticScene, defaultVisibility } from '../src/render/scene.ts';
import { createMapState } from './seededMap.ts';

test('profiling is opt-in, resets between jobs, and does not alter the scene', () => {
  profileCount('disabled');
  assert.equal(endRenderProfile(), undefined);
  const map = createMapState('profile', 4, 4);
  map.id = 'profile'; map.layers.base.data = Array(16).fill('Sea');
  map.layers.base.data![5] = 'Coastal Land';
  const opts = { size: 26, visible: defaultVisibility(), labels: false };
  const direct = buildStaticScene(structuredClone(map), { ...opts, cache: 'off' });
  beginRenderProfile();
  const profiled = buildStaticScene(structuredClone(map), opts);
  const profile = endRenderProfile()!;
  assert.deepEqual(profiled, direct);
  assert.ok(profile.duration > 0 && profile.timeOrigin > 0);
  assert.equal(profile.counters['coast.cacheMiss'], 1);
  assert.ok(profile.timings.some(t => t.name === 'scene.total'));
  assert.ok(profile.timings.every(t => t.start >= profile.start && t.duration >= 0));
  beginRenderProfile();
  const phase = profilePhases('test'); phase('first');
  assert.equal(profileTime('value', () => 42), 42);
  assert.throws(() => profileTime('throw', () => { throw Error('expected'); }));
  phase('second'); phase();
  const next = endRenderProfile()!;
  assert.deepEqual(next.counters, {});
  assert.deepEqual(next.timings.map(t => t.name).sort(), ['test.first','test.second','throw','value']);
  assert.equal(endRenderProfile(), undefined);
});

test('river diagnostics preserve both compatibility and surface-fallback results', async () => {
  const { placeRiverLabels } = await import('../src/render/featureLabels.ts');
  const river = { id: 'river', name: 'Wend', terminus: 'Sea', segments: [] } as never;
  const path = () => Array.from({ length: 41 }, (_, i) => ({ x: i * 10, y: 100 }));
  for (const land of [true, false]) {
    const place = () => placeRiverLabels([river], 20, path, undefined, [], undefined, undefined, undefined, () => land);
    const expected = place();
    beginRenderProfile();
    const actual = place();
    const profile = endRenderProfile()!;
    assert.deepEqual(actual, expected);
    assert.equal(profile.counters['riverLabels.surfaceFallbacks'] ?? 0, land ? 0 : 1);
    assert.ok(profile.counters['riverLabels.probes']! > 0);
    assert.ok(profile.timings.some(t => t.name === 'riverLabels.preparation'));
    assert.ok(profile.timings.some(t => t.name === 'riverLabels.candidateSearch'));
  }
});
