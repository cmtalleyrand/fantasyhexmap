import assert from 'node:assert/strict';
import test from 'node:test';
import { BoundedMemo, withRenderCaches } from '../src/render/cache.ts';
import { buildStaticScene } from '../src/render/scene.ts';
import { beginRenderProfile, endRenderProfile } from '../src/render/profile.ts';
import { invalidateTextMeasures } from '../src/render/fonts.ts';
import { islandSpecFor } from '../shared/types.ts';
import { componentFixture, placementFixture, editOptions, editCases } from '../scripts/render-edit-fixtures.ts';
import { createMapState } from './seededMap.ts';

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
test('unchanged glacier margins reuse their exact geometry and invalidate on terrain or policy edits', () => {
  const map = createMapState('Glacier cache', 5, 4);
  map.layers.base.data = Array(20).fill('Land');
  map.layers.base.data![6] = 'Glacier';
  map.layers.elevation.data = Array(20).fill('Hills');
  const options = editOptions();
  profiled(map, options);
  const warm = profiled(structuredClone(map), { ...options, polityOpacity: .3 });
  assert.equal(warm.profile.counters['coast.componentBuilds'] ?? 0, 0, 'warm redraw must not retrace ice margins');
  assert.deepEqual(warm.scene, buildStaticScene(map, { ...options, polityOpacity: .3, cache: 'off' }));
  const check = (changed: typeof map, opts = options) => {
    const result = profiled(changed, opts);
    assert.ok(result.profile.counters['glacier.marginBuilds']! > 0, 'changed geometry inputs rebuild');
    assert.deepEqual(result.scene, buildStaticScene(structuredClone(changed), { ...opts, cache: 'off' }));
  };
  const raised = structuredClone(map); raised.layers.elevation.data![7] = 'Mountains'; check(raised);
  const rough = structuredClone(map); rough.defaultIrregularity = 'Fractured'; check(rough);
  const sea = structuredClone(map); sea.layers.base.data![7] = 'Sea'; check(sea);
  const resized = structuredClone(map); check(resized, { ...options, size: options.size + 1 });
});
test('returning to an already validated land revision does not replay unchanged symbol probes', () => {
  const map = createMapState('Symbol revision reuse', 5, 4), options = editOptions();
  map.layers.base.data = Array(20).fill('Land'); map.layers.base.data![19] = 'Sea';
  map.layers.elevation.data = Array(20).fill(null); map.layers.elevation.data![6] = 'Hills';
  profiled(map, options);
  const changed = structuredClone(map); changed.layers.base.data![19] = 'Sea Ice';
  const validated = profiled(changed, options);
  assert.ok(validated.profile.counters['symbols.revalidatedFits']! > 0);
  const again = profiled(structuredClone(map), options);
  assert.equal(again.profile.counters['symbols.revalidatedFits'] ?? 0, 0);
  assert.deepEqual(again.scene, buildStaticScene(map, { ...options, cache: 'off' }));
});
test('pack ice reuses its exact drawing and invalidates on shore, roughness and appearance edits', () => {
  const map = createMapState('Pack ice cache', 5, 4), options = editOptions();
  map.layers.base.data = Array(20).fill('Sea');
  map.layers.base.data![6] = 'Sea Ice'; map.layers.base.data![7] = 'Sea Ice';
  profiled(map, options);
  const warm = profiled(structuredClone(map), { ...options, polityOpacity: .3 });
  assert.equal(warm.profile.counters['coast.componentBuilds'] ?? 0, 0);
  assert.equal(warm.profile.counters['ice.packHits'], 1);
  assert.deepEqual(warm.scene, buildStaticScene(map, { ...options, polityOpacity: .3, cache: 'off' }));
  const check = (changed: typeof map, opts = options) => {
    const result = profiled(changed, opts);
    assert.equal(result.profile.counters['ice.packBuilds'], 1);
    assert.deepEqual(result.scene, buildStaticScene(structuredClone(changed), { ...opts, cache: 'off' }));
  };
  const shore = structuredClone(map); shore.layers.base.data![1] = 'Land'; check(shore);
  const rough = structuredClone(map); rough.defaultIrregularity = 'Fractured'; check(rough);
  check(map, { ...options, style: { ...options.style!, palette: { ...options.style!.palette, seaIce: '#c0c0ee' } } });
  check(map, { ...options, style: { ...options.style!, knobs: { ...options.style!.knobs, ice: 'flat' } } });
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


test('unchanged island drawings reuse layouts and outlines while shape edits invalidate them', () => {
  const map=createMapState('Island drawing reuse',5,4), options=editOptions();
  map.layers.base.data=Array(20).fill('Sea');map.layers.base.data![6]='Islands';
  map.islandSpecs={'6':{large:1,small:2}};
  profiled(map,options);
  const warm=profiled(structuredClone(map),{...options,polityOpacity:.3});
  assert.equal(warm.profile.counters['islands.drawingBuilds']??0,0);
  assert.ok(warm.profile.counters['islands.drawingHits']!>0);
  assert.deepEqual(warm.scene,buildStaticScene(map,{...options,polityOpacity:.3,cache:'off'}));
  const edited=structuredClone(map);edited.islandSpecs!['6']={large:2,small:1};
  const changed=profiled(edited,options);
  assert.ok(changed.profile.counters['islands.drawingBuilds']!>0);
  assert.deepEqual(changed.scene,buildStaticScene(edited,{...options,cache:'off'}));
});

test('coast paint geometry survives colour redraws without retaining old colours', () => {
  const map = componentFixture(), options = editOptions();
  const underlay = (scene: ReturnType<typeof buildStaticScene>) => {
    const group = scene.prims.find(p => p.kind === 'group' && p.clip && p.prims[0]?.kind === 'polygon');
    assert.ok(group?.kind === 'group' && group.clip);
    const ground = group.prims[0]!;
    assert.ok(ground.kind === 'polygon');
    return { clip: group.clip, points: ground.points, fill: ground.fill };
  };
  const before = underlay(buildStaticScene(map, options));
  const coloured = { ...options, style: { ...options.style!, palette: { ...options.style!.palette, land: '#c01030' } } };
  const warm = buildStaticScene(structuredClone(map), coloured), after = underlay(warm);
  assert.equal(after.clip, before.clip);
  assert.equal(after.points, before.points);
  assert.notEqual(after.fill, before.fill);
  const full = buildStaticScene(map, { ...coloured, cache: 'off' });
  assert.notEqual(underlay(full).clip, before.clip);
  assert.deepEqual(warm, full);
});
