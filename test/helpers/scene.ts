import assert from 'node:assert/strict';
import type { Prim } from '../../src/render/prims.ts';
import { buildStaticScene, type Scene, type SceneOptions } from '../../src/render/scene.ts';
import type { MapState } from '../../shared/types.ts';

/** Paths in paint order, including nested groups. This does not apply group clips or transforms. */
export function scenePaths(prims: readonly Prim[]): Extract<Prim, { kind: 'path' }>[] {
  return prims.flatMap(prim => {
    if (prim.kind === 'group') return scenePaths(prim.prims);
    return prim.kind === 'path' ? [prim] : [];
  });
}

/**
 * Where two plain-data values first differ, as a path such as `.prims[3].d[0][1]`,
 * or null where they hold the same data.
 */
export function firstDifference(a: unknown, b: unknown, at = ''): string | null {
  if (Object.is(a, b)) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return at || '(root)';
  if (Array.isArray(a) !== Array.isArray(b)) return at || '(root)';
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const found = firstDifference(a[i], b[i], `${at}[${i}]`);
      if (found !== null) return found;
    }
    return null;
  }
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) {
    if (!(key in x) || !(key in y)) return `${at}.${key}`;
    const found = firstDifference(x[key], y[key], `${at}.${key}`);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Builds each case with the render caches on, in order (so each build reuses what
 * the earlier ones left), and asserts it equals the same state built with caches off.
 * A failure names the case and the first path at which the scenes differ.
 */
export function assertCachedBuildsMatch(
  cases: ReadonlyArray<{ name: string; map: MapState; options: SceneOptions }>,
  build: (map: MapState, options: SceneOptions) => Scene = buildStaticScene,
): void {
  for (const { name, map, options } of cases) {
    const cached = build(map, options);
    const uncached = build(structuredClone(map), { ...options, cache: 'off' });
    const diff = firstDifference(cached, uncached);
    if (diff !== null) assert.fail(`${name}: the cached build differs from the uncached one at ${diff}`);
    assert.deepEqual(cached, uncached, name);
  }
}
