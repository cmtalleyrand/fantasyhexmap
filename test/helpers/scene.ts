import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import type { MapState } from '../../shared/types.ts';
import type { Prim } from '../../src/render/prims.ts';
import { buildStaticScene, type Scene, type SceneOptions } from '../../src/render/scene.ts';

/** Paths in paint order, including nested groups. This does not apply group clips or transforms. */
export function scenePaths(prims: readonly Prim[]): Extract<Prim, { kind: 'path' }>[] {
  return prims.flatMap(prim => {
    if (prim.kind === 'group') return scenePaths(prim.prims);
    return prim.kind === 'path' ? [prim] : [];
  });
}

/** Compare a rebuild (or an already profiled scene) with caches disabled; return the fresh scene. */
export function assertRebuildMatchesUncached(map: MapState, options: SceneOptions, edit: string,
  cached = buildStaticScene(map, options)): Scene {
  const uncached = buildStaticScene(structuredClone(map), { ...options, cache: 'off' });
  try {
    assert.deepEqual(cached, uncached);
  } catch (error) {
    if (error instanceof assert.AssertionError) {
      error.message = `${edit}: first difference at ${firstDifference(cached, uncached)}\n${error.message}`;
    }
    throw error;
  }
  return uncached;
}

/** Only walk mismatching branches, and only after an equality assertion fails. */
function firstDifference(actual: unknown, expected: unknown, path = 'scene'): string {
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    const a = actual as Record<string, unknown>, b = expected as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const next = Array.isArray(actual) ? `${path}[${key}]` : `${path}.${key}`;
      if (Object.hasOwn(a, key) !== Object.hasOwn(b, key)) return next;
      if (!isDeepStrictEqual(a[key], b[key])) return firstDifference(a[key], b[key], next);
    }
  }
  return path;
}
