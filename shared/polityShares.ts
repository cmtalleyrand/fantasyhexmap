/**
 * Hexes shared between two polities. `owner` names the larger holder (or the
 * first, for an even split) and `shares[index]` the other with its fraction.
 */

import type { HexShare, PolitiesData } from './types.js';

export const MIN_SHARE = 0.05;

/** Every holder of a hex with the fraction each holds; empty for an unclaimed hex. */
export function holdersOf(data: Pick<PolitiesData, 'owner' | 'shares'>, index: number): Array<[string, number]> {
  const owner = data.owner[index];
  if (!owner) return [];
  const share = data.shares?.[String(index)];
  if (!share || share.polityId === owner) return [[owner, 1]];
  return [[owner, 1 - share.share], [share.polityId, share.share]];
}

/** Clamp a requested fraction to what a share may be. */
export function clampShare(share: number): number {
  return Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, Number.isFinite(share) ? share : 0.5));
}

/**
 * Drop shares that no longer describe anything: on an unowned hex, to a polity
 * that does not exist, to the owner itself, or with a nonsensical fraction.
 * Returns the same object when nothing needed dropping.
 */
export function pruneShares(data: PolitiesData): PolitiesData {
  const shares = data.shares;
  if (!shares) return data;
  const known = new Set(data.polities.map((p) => p.id));
  const kept: Record<string, HexShare> = {};
  let changed = false;
  for (const [key, share] of Object.entries(shares)) {
    const owner = data.owner[Number(key)];
    const valid =
      owner && known.has(owner) && known.has(share.polityId) && share.polityId !== owner &&
      share.share > 0 && share.share < 1;
    if (valid) kept[key] = share;
    else changed = true;
  }
  if (!changed) return data;
  const { shares: _old, ...rest } = data;
  return Object.keys(kept).length > 0 ? { ...rest, shares: kept } : rest;
}

/** The share table with the given hexes made whole again. */
export function withoutShares(
  shares: PolitiesData['shares'],
  indices: Iterable<number>,
): PolitiesData['shares'] {
  if (!shares) return shares;
  const next = { ...shares };
  for (const i of indices) delete next[String(i)];
  return Object.keys(next).length > 0 ? next : undefined;
}
