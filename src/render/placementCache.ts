import { BoundedMemo } from './cache.js';
import { profileCount, profileTime } from './profile.js';

const placements = new BoundedMemo<unknown>(96, 8_000_000);
export function clearPlacementCache(): void { placements.clear(); }

/** Inputs are value snapshots, including ordered obstacles and measurement epoch. */
export function cachedPlacement<T>(family: string, inputs: unknown, place: () => T): T {
  const key = profileTime(`${family}.cacheKey`, () => JSON.stringify([family, inputs]));
  const known = placements.get(key) as T | undefined;
  if (known !== undefined) { profileCount(`${family}.cacheHits`); profileCount('placement.cacheHits'); return profileTime(`${family}.cacheRead`, () => structuredClone(known)); }
  profileCount(`${family}.searches`); profileCount('placement.searches');
  const result = profileTime(`${family}.placement`, place);
  profileTime(`${family}.cacheWrite`, () => placements.set(key, structuredClone(result), JSON.stringify(result).length * 2));
  return result;
}
