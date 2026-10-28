import { createMapState } from '../seededMap.ts';
import type { ChannelWidth, Irregularity, MapState } from '../../shared/types.ts';

export interface LakeStraitCase { width: ChannelWidth; side?: number; land?: number; irregular: Irregularity }

/** Diagnostic layout only: this is not the user's saved map. */
export function lakeStraitFixture({ width, side, land, irregular }: LakeStraitCase): MapState {
  const map = createMapState('Lake strait diagnostic fixture', 7, 7);
  map.id = 'lake-strait';
  const base = map.layers.base.data = Array(49).fill('Land');
  for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) base[y * 7 + x] = 'Lake';
  base[24] = 'Strait';
  // Broad, connected mainland banks, not one-hex spokes surrounded by water.
  // The northern shore spans NW/NE; the peninsula reaches the SW edge.
  for (let y = 0; y <= 2; y++) for (let x = 0; x < 7; x++) base[y * 7 + x] = 'Land';
  for (let y = 4; y < 7; y++) for (let x = 0; x <= (y % 2 ? 2 : 3); x++) base[y * 7 + x] = 'Land';
  map.hexShapes = { '24': { type: 'Strait', width, straitJunctionSide: side, land, irregular } };
  map.defaultLakeIrregularity = irregular;
  return map;
}

/** Sixteen chosen cases, covering the controls without an exhaustive Cartesian product. */
export const LAKE_STRAIT_CASES: LakeStraitCase[] = [
  { width: 'Very narrow', irregular: 'Ragged' },
  { width: 'Very narrow', side: 3, irregular: 'Smooth' },
  { width: 'Very narrow', side: 0, irregular: 'Wavy' },
  { width: 'Very narrow', side: 4, land: 30, irregular: 'Fractured' },
  { width: 'Narrow', irregular: 'Ragged' },
  { width: 'Narrow', side: 3, irregular: 'Ragged' },
  { width: 'Narrow', side: 0, irregular: 'Ragged' },
  { width: 'Narrow', land: 50, irregular: 'Ragged' },
  { width: 'Normal', irregular: 'Ragged' },
  { width: 'Normal', side: 3, irregular: 'Ragged' },
  { width: 'Normal', side: 0, irregular: 'Ragged' },
  { width: 'Normal', side: 5, land: 50, irregular: 'Wavy' },
  { width: 'Wide', irregular: 'Smooth' },
  { width: 'Wide', side: 1, land: 30, irregular: 'Ragged' },
  { width: 'Wide', side: 2, land: 50, irregular: 'Wavy' },
  { width: 'Wide', side: 4, irregular: 'Fractured' },
];

/**
 * One case per width runs in the fast tier: those that also set a junction side,
 * a land share or an unusual roughness. All sixteen run in the slow tier.
 */
export const FAST_LAKE_STRAIT_CASES: ReadonlySet<number> = new Set([3, 7, 11, 13]);
