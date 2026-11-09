import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStaticScene, type Scene } from '../src/render/scene.ts';
import { beginRenderProfile, endRenderProfile } from '../src/render/profile.ts';
import { editOptions } from '../scripts/render-edit-fixtures.ts';
import { validateHexDefinitions } from '../shared/hexValidation.ts';
import type { BaseGeo, MapState } from '../shared/types.ts';
import { createMapState } from './seededMap.ts';

const cols = 24, rows = 14;

/** A one-hex land bridge cut by a sea strait, and an island well away from it to edit. */
function straitMap(): MapState {
  const map = createMapState('Sea passage edits', cols, rows);
  map.layers.base.data = Array.from({ length: cols * rows }, (_, i): BaseGeo => {
    const c = i % cols, r = Math.floor(i / cols);
    if (c === 6) return r === 7 ? 'Strait' : 'Land';
    return c >= 15 && c <= 20 && r >= 3 && r <= 10 ? 'Land' : 'Sea';
  });
  return map;
}

function withSea(map: MapState, i: number): MapState {
  const data = [...map.layers.base.data];
  data[i] = 'Sea';
  return { ...map, layers: { ...map.layers, base: { ...map.layers.base, data } } };
}

function profiled(work: () => Scene): { scene: Scene; counters: Record<string, number> } {
  beginRenderProfile();
  const scene = work();
  return { scene, counters: endRenderProfile()!.counters };
}

// A sea strait's shore is drawn from a background coast traced with the strait open. An edit far
// from the strait must not redraw that shore, nor refit the background whole in an incremental build
// (DECISIONS §102).
test('an edit away from a sea strait keeps its shore and refits its background locally', () => {
  const map = straitMap();
  assert.deepEqual(validateHexDefinitions(map), []);
  const options = editOptions(), incremental = { ...options, incrementalCoast: true };
  buildStaticScene(map, options);
  buildStaticScene(map, incremental);

  const edited = withSea(map, 6 * cols + 15);
  // Kept shores are exact: a cached build equals an uncached one.
  const plain = profiled(() => buildStaticScene(edited, options));
  assert.ok((plain.counters['passage.contourKept'] ?? 0) > 0, 'the strait shore was kept');
  assert.equal(plain.counters['passage.contourBuilt'] ?? 0, 0, 'the strait shore was not drawn again');
  assert.deepEqual(plain.scene.prims, buildStaticScene(edited, { ...options, cache: 'off' }).prims);

  // Both the coast and the background it is replaced by are refitted in windows.
  const local = profiled(() => buildStaticScene(edited, incremental));
  assert.equal(local.counters['coast.windowFallbacks'] ?? 0, 0);
  assert.equal(local.counters['coast.windowFits'], local.counters['coast.fitGroupBuilds']);
});
