import { inBounds, neighbourOf } from './hex.js';
import type { BaseGeo, ChannelWidth, IslandSpec } from './types.js';

/**
 * Geography categories are distinct from eligibility for settlements or land layers.
 * Lookups tolerate unrecognised values (hand-edited or older imports), which are neither land nor water.
 */
export const HEX_CATEGORIES = {
  Sea: ['Water', 'Water'], Lake: ['Water', 'Water'], 'Sea Ice': ['Water', 'Water'],
  Islands: ['Water', 'Island'], Land: ['Land', 'Land'], Glacier: ['Land', 'Land'],
  'Mainland and islands': ['Land', 'Continent and island'],
  Isthmus: ['Land', 'Isthmus'], Strait: ['Land', 'Strait'],
} as const satisfies Record<BaseGeo, readonly [string, string]>;

export function isCategoryLand(value: BaseGeo | null | undefined): boolean {
  return !!value && HEX_CATEGORIES[value]?.[0] === 'Land';
}
export function isCategoryWater(value: BaseGeo | null | undefined): boolean {
  return !!value && HEX_CATEGORIES[value]?.[0] === 'Water';
}
export function adjacentHexes(base: ReadonlyArray<BaseGeo | null | undefined>, cols: number, index: number): number[] {
  const out: number[] = [];
  for (let side = 0; side < 6; side++) {
    const n = neighbourOf(index % cols, Math.floor(index / cols), side);
    if (inBounds(cols, base.length / cols, n.col, n.row)) out.push(n.row * cols + n.col);
  }
  return out;
}
/**
 * Count groups around the six sides; missing neighbours are neither land nor water. A passage
 * (strait or isthmus) needs exactly two of each: three of either is not one passage.
 */
export function passageNeighbours(base: ReadonlyArray<BaseGeo | null | undefined>, cols: number, index: number) {
  const ring = Array.from({ length: 6 }, (_, side) => {
    const n = neighbourOf(index % cols, Math.floor(index / cols), side);
    return inBounds(cols, base.length / cols, n.col, n.row) ? base[n.row * cols + n.col] : undefined;
  });
  const groups = (matches: (value: BaseGeo | null | undefined) => boolean) =>
    ring.every(matches) ? 1 : ring.filter((value, side) => matches(value) && !matches(ring[(side + 5) % 6])).length;
  const land = ring.filter(isCategoryLand).length, water = ring.filter(isCategoryWater).length;
  const landGroups = groups(isCategoryLand), waterGroups = groups(isCategoryWater);
  return { land, water, landGroups, waterGroups,
    valid: landGroups === 2 && waterGroups === 2 };
}
/** Land that islands need at the least: 2.5% for each small island, 5% for each large one. */
export function islandMinimum(spec?: IslandSpec): number {
  return (spec?.small ?? 0) * 2.5 + (spec?.large ?? 0) * 5;
}
/** Land a Mainland and islands hex keeps for its mainland at the least. */
export const MAINLAND_MINIMUM = 2.5;
/**
 * The land shares, in percent, an isthmus or strait of each width can be drawn with while it is still a
 * short narrows between two rounded tips (measured over the five neighbour patterns a passage can have,
 * to 5%; decision 85). More land round a strait, or less round an isthmus, could only be drawn as a canal.
 */
export const PASSAGE_LAND_RANGE: Record<'Isthmus' | 'Strait', Record<ChannelWidth, readonly [number, number]>> = {
  Isthmus: { 'Very narrow': [35, 85], Narrow: [45, 85], Normal: [55, 90], Wide: [70, 95] },
  Strait: { 'Very narrow': [20, 75], Narrow: [20, 65], Normal: [15, 55], Wide: [10, 40] },
};
/**
 * The land shares, in percent, a hex of this type may be set to. An isthmus or strait's depend on its
 * `width`; without one, the range covers every width.
 */
export function landShareRange(value: BaseGeo | null | undefined, spec?: IslandSpec, width?: ChannelWidth): readonly [number, number] {
  switch (value) {
    case 'Isthmus':
    case 'Strait': {
      const ranges = PASSAGE_LAND_RANGE[value];
      if (width && ranges[width]) return ranges[width];
      const all = Object.values(ranges);
      return [Math.min(...all.map(r => r[0])), Math.max(...all.map(r => r[1]))];
    }
    case 'Mainland and islands': return [Math.max(10, MAINLAND_MINIMUM + islandMinimum(spec)), 90];
    case 'Islands': return [Math.max(2.5, islandMinimum(spec)), 100];
    default: return [0, 100];
  }
}
export function boundedLandShare(value: BaseGeo | null | undefined, percent: number, spec?: IslandSpec, width?: ChannelWidth): number {
  const [min, max] = landShareRange(value, spec, width);
  return Math.max(min, Math.min(max, percent));
}
/** A land fraction (0–1) as a percentage to 0.1%, free of floating-point residue (0.575 → 57.5, not 57.49999999999999). */
export function landPercent(fraction: number): number {
  return Math.round(fraction * 1000) / 10;
}
