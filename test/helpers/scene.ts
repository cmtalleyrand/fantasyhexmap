import assert from 'node:assert/strict';
import type { Prim } from '../../src/render/prims.ts';
import { buildStaticScene, type SceneOptions } from '../../src/render/scene.ts';
import type { MapState } from '../../shared/types.ts';

/** Paths in paint order, including nested groups. This does not apply group clips or transforms. */
export function scenePaths(prims: readonly Prim[]): Extract<Prim, { kind: 'path' }>[] {
  return prims.flatMap(prim => {
    if (prim.kind === 'group') return scenePaths(prim.prims);
    return prim.kind === 'path' ? [prim] : [];
  });
}

/** Builds each case in order with caches on, and checks it equals the same state built with caches off. */
export function assertCachedBuildsMatch(cases: ReadonlyArray<{ name: string; map: MapState; options: SceneOptions }>): void {
  for (const { name, map, options } of cases) {
    assert.deepEqual(buildStaticScene(map, options), buildStaticScene(structuredClone(map), { ...options, cache: 'off' }), name);
  }
}
