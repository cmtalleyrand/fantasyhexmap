import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedMemo, withRenderCaches } from '../src/render/cache.ts';
import { buildStaticScene } from '../src/render/scene.ts';
import { beginRenderProfile, endRenderProfile } from '../src/render/profile.ts';
import { invalidateTextMeasures } from '../src/render/fonts.ts';
import { islandSpecFor } from '../shared/types.ts';
import { componentFixture, placementFixture, editOptions, editCases } from '../scripts/render-edit-fixtures.ts';

function profiled(map: ReturnType<typeof componentFixture>, options = editOptions()) {
  beginRenderProfile();
  const scene = buildStaticScene(map, options), profile = endRenderProfile()!;
  return { scene, profile };
}
test('cache bounds and forced-full policy cannot leave stale values or leak into the next build', () => {
  const cache = new BoundedMemo<number>(2, 100);
  cache.set('a', 1); cache.set('b', 2); cache.get('a'); cache.set('c', 3);
  assert.equal(cache.get('b'), undefined); assert.equal(cache.get('a'), 1);
  assert.throws(() => withRenderCaches(false, () => { assert.equal(cache.get('a'), undefined); cache.set('a', 8); throw Error('expected'); }));
  assert.equal(cache.get('a'), 1);
  withRenderCaches(false, () => withRenderCaches(true, () => assert.equal(cache.get('a'), undefined)));
  cache.set('a', 7, 101); assert.equal(cache.get('a'), undefined);
});
test('a distant component reuses its silhouette and performs no fitting after a local shore edit', () => {
  const map = componentFixture(); profiled(map);
  const edited = structuredClone(map); edited.layers.base.data![5 * 40 + 3] = 'Sea';
  const { scene, profile } = profiled(edited);
  assert.equal(profile.counters['coast.componentBuilds'], 1);
  assert.ok(profile.counters['coast.componentHits']! >= 1);
  assert.equal(profile.counters['fit.rounds'] ?? 0, 0);
  assert.deepEqual(scene, buildStaticScene(edited, { ...editOptions(), cache: 'off' }));
});
test('incremental rebuilds equal uncached rebuilds after merges, splits, settings, islands, hierarchy and obstacle edits', () => {
  const cases = editCases();
  const island = cases.find(c => c.name === 'placement/islands')!.map;
  const more = cases.find(c => c.name === 'placement/island-count')!.map;
  assert.notDeepEqual(islandSpecFor('Islands', island.islandSpecs!['51']), islandSpecFor('Islands', more.islandSpecs!['51']));
  for (const c of cases) {
    const cached = buildStaticScene(c.map, c.options);
    const full = buildStaticScene(structuredClone(c.map), { ...c.options, cache: 'off' });
    assert.deepEqual(cached, full, c.name);
  }
});
test('unchanged placement inputs reuse every search, while marker, font and terrain changes invalidate correctly', () => {
  const map = placementFixture(), options = editOptions();
  // This invalidation case needs a fully water-filled lake, with no remaining land for old symbols.
  map.hexDimensions.lakeLandPercent = 0;
  profiled(map, options);
  const changed = { ...options, polityOpacity: .3 };
  const repeat = profiled(structuredClone(map), changed);
  assert.equal(repeat.profile.counters['symbols.searches'] ?? 0, 0);
  assert.equal(repeat.profile.counters['placement.searches'] ?? 0, 0);
  assert.ok(repeat.profile.counters['placement.cacheHits']! >= 4);
  assert.deepEqual(repeat.scene, buildStaticScene(map, { ...changed, cache: 'off' }));
  const marker = { ...changed, style: { ...changed.style!, knobs: { ...changed.style!.knobs, cityMarkers: 'classic' as const } } };
  const markerResult = profiled(map, marker);
  assert.ok(markerResult.profile.counters['polityLabels.searches']! > 0, 'actual marker bounds affect polity names');
  assert.deepEqual(markerResult.scene, buildStaticScene(map, { ...marker, cache: 'off' }));
  invalidateTextMeasures();
  const fontResult = profiled(map, marker);
  assert.ok(fontResult.profile.counters['placement.searches']! >= 4);
  assert.deepEqual(fontResult.scene, buildStaticScene(map, { ...marker, cache: 'off' }));
  const lake = structuredClone(map); lake.layers.base.data![5 * 12 + 7] = 'Lake';
  const landResult = profiled(lake, marker);
  assert.ok(landResult.profile.counters['symbols.revalidatedFits']! > 0);
  assert.ok(landResult.profile.counters['symbols.searches']! > 0);
  assert.deepEqual(landResult.scene, buildStaticScene(lake, { ...marker, cache: 'off' }));
});
