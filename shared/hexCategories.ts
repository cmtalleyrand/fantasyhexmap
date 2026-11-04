import { inBounds, neighbourOf } from './hex.js';
import type { BaseGeo, IslandSpec } from './types.js';

/** Geography categories are distinct from eligibility for settlements or land layers. */
export const HEX_CATEGORIES = {
  Sea: ['Water', 'Water'], Lake: ['Water', 'Water'], 'Sea Ice': ['Water', 'Water'],
  Islands: ['Water', 'Island'], Land: ['Land', 'Land'], Glacier: ['Land', 'Land'],
  'Mainland and islands': ['Land', 'Continent and island'],
  Isthmus: ['Land', 'Isthmus'], Strait: ['Land', 'Strait'],
} as const satisfies Record<BaseGeo, readonly [string, string]>;

export function isCategoryLand(value: BaseGeo | null | undefined): boolean {
  return !!value && HEX_CATEGORIES[value][0] === 'Land';
}
export function isCategoryWater(value: BaseGeo | null | undefined): boolean {
  return !!value && HEX_CATEGORIES[value][0] === 'Water';
}
export function adjacentHexes(base: ReadonlyArray<BaseGeo | null | undefined>, cols: number, index: number): number[] {
  const out: number[] = [];
  for (let side = 0; side < 6; side++) {
    const n = neighbourOf(index % cols, Math.floor(index / cols), side);
    if (inBounds(cols, base.length / cols, n.col, n.row)) out.push(n.row * cols + n.col);
  }
  return out;
}
/** Count groups around the six sides; missing neighbours are neither land nor water. */
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
    valid: land >= 2 && water >= 2 && water <= 4 && landGroups >= 2 && waterGroups >= 2 };
}
export function landShareRange(value: BaseGeo | null | undefined, spec?: IslandSpec): readonly [number, number] {
  switch (value) {
    case 'Isthmus': return [15, 80];
    case 'Strait': return [10, 70];
    case 'Mainland and islands': return [10, 90];
    case 'Islands': return [Math.max(2.5, (spec?.small ?? 0) * 2.5 + (spec?.large ?? 0) * 5), 100];
    default: return [0, 100];
  }
}
export function boundedLandShare(value: BaseGeo | null | undefined, percent: number, spec?: IslandSpec): number {
  const [min, max] = landShareRange(value, spec);
  return Math.max(min, Math.min(max, percent));
}
