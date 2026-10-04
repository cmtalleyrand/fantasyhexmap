import { holdersOf } from './polityShares.js';
import {
  DEFAULT_HEX_DIMENSIONS,
  hexShapeFor,
  islandSpecFor,
  type BaseData,
  type BaseGeo,
  type HexShape,
  type IslandSpec,
  type HexDimensions,
  type PolitiesData,
} from './types.js';
import { straitSharers } from './straits.js';

/** Dimensions saved before land shares were set per type carried one island share. */
type StoredHexDimensions = Partial<HexDimensions> & { islandLandPercent?: number };

export function normaliseHexDimensions(value?: StoredHexDimensions): HexDimensions {
  const { islandLandPercent, ...rest } = value ?? {};
  const out = { ...DEFAULT_HEX_DIMENSIONS, ...rest };
  if (islandLandPercent !== undefined && rest.smallIslandPercent === undefined && rest.largeIslandPercent === undefined) {
    // The old defaults (60% coast, 40% island) take the current defaults; a share
    // someone chose becomes the same ratio of small to large islands as before.
    const untouched = islandLandPercent === 40 && rest.coastalLandPercent === 60;
    if (untouched) out.coastalLandPercent = DEFAULT_HEX_DIMENSIONS.coastalLandPercent;
    else {
      out.smallIslandPercent = Math.round(islandLandPercent / 20) * 5;
      out.largeIslandPercent = Math.round(islandLandPercent / 10) * 5;
    }
  }
  out.smallIslandPercent = Math.max(2.5, out.smallIslandPercent);
  return out;
}

/**
 * How much of a hex is land, from 0 to 1. A hex a person has given a land share
 * takes that. Otherwise it is its type's share (see `HexDimensions`): a coastal
 * hex, a lake, an isthmus, a strait or a glacier has one; an island hex is the sum of its
 * islands, each large island and each small one taking its own share; and a
 * mainland-and-islands hex adds the mainland's share to those.
 */
export function landFraction(
  value: BaseGeo | null | undefined,
  stored: IslandSpec | undefined,
  dimensions: HexDimensions,
  shape?: HexShape,
): number {
  const set = hexShapeFor(value, shape).land;
  if (set !== undefined) return set / 100;
  const percent = (n: number) => Math.min(100, Math.max(0, n)) / 100;
  switch (value) {
    case 'Land':
      return 1;
    case 'Glacier':
      return percent(dimensions.glacierPercent);
    case 'Coastal Land':
      return percent(dimensions.coastalLandPercent);
    case 'Lake':
      return percent(dimensions.lakeLandPercent);
    case 'Isthmus':
      return percent(dimensions.isthmusPercent);
    case 'Strait':
      return percent(dimensions.straitPercent);
    case 'Islands':
    case 'Mainland and islands': {
      const spec = islandSpecFor(value, stored);
      const islands = spec.large * dimensions.largeIslandPercent + spec.small * dimensions.smallIslandPercent;
      return percent((value === 'Islands' ? 0 : dimensions.mainlandPercent) + islands);
    }
    default:
      return 0;
  }
}

/**
 * How much of a hex the coast draws as land, from 0 to 1: its share, except that
 * a Mainland and islands hex draws only its mainland there (its islands are drawn
 * separately, from the rest of the share), and a share set below the mainland's
 * leaves the mainland all of it. Null for a type with no share to draw.
 */
export function drawnLandFraction(
  value: BaseGeo | null | undefined,
  dimensions: HexDimensions,
  shape?: HexShape,
): number | null {
  switch (value) {
    case 'Coastal Land':
    case 'Glacier':
    case 'Isthmus':
    case 'Strait':
      return landFraction(value, undefined, dimensions, shape);
    case 'Mainland and islands': {
      const set = hexShapeFor(value, shape).land;
      const mainland = Math.min(100, Math.max(0, dimensions.mainlandPercent));
      return (set === undefined ? mainland : Math.min(mainland, set)) / 100;
    }
    default:
      return null;
  }
}

/**
 * Returns land area by polity id. A pointy-top hex occupies 3/4 of its
 * flat-to-flat width times its corner-to-corner height. A parent's area
 * includes both land assigned directly to it and the areas of all its parts.
 */
export function politySurfaceAreas(
  base: BaseData,
  data: PolitiesData,
  dimensions: HexDimensions,
  specs?: Record<string, IslandSpec>,
  shapes?: Record<string, HexShape>,
  /** Grid width; with it, an unowned strait's area is shared between the realms on its banks. */
  cols?: number,
): Map<string, number> {
  const hexArea = dimensions.width * dimensions.height * 0.75;
  const areas = new Map(data.polities.map((polity) => [polity.id, 0]));
  for (let index = 0; index < data.owner.length; index++) {
    const owner = data.owner[index];
    const fraction = landFraction(base[index], specs?.[String(index)], dimensions, shapes?.[String(index)]);
    if (!owner) {
      // An unowned strait is shared by the realms on its banks.
      if (!cols) continue;
      for (const [id, share] of straitSharers(base, data.owner, cols, data.owner.length / cols, index)) {
        if (areas.has(id)) areas.set(id, areas.get(id)! + hexArea * fraction * share);
      }
      continue;
    }
    for (const [id, part] of holdersOf(data, index)) {
      if (areas.has(id)) areas.set(id, areas.get(id)! + hexArea * fraction * part);
    }
  }

  // Accumulate leaves into their parents once each. Starting at leaves makes
  // every child's total complete before it is added to its parent.
  const byId = new Map(data.polities.map((polity) => [polity.id, polity]));
  const childrenLeft = new Map(data.polities.map((polity) => [polity.id, 0]));
  for (const polity of data.polities) {
    if (polity.parentId && byId.has(polity.parentId)) {
      childrenLeft.set(polity.parentId, childrenLeft.get(polity.parentId)! + 1);
    }
  }
  const ready = data.polities.filter((polity) => childrenLeft.get(polity.id) === 0);
  for (let index = 0; index < ready.length; index++) {
    const polity = ready[index]!;
    if (!polity.parentId || !byId.has(polity.parentId)) continue;
    areas.set(polity.parentId, areas.get(polity.parentId)! + areas.get(polity.id)!);
    const remaining = childrenLeft.get(polity.parentId)! - 1;
    childrenLeft.set(polity.parentId, remaining);
    if (remaining === 0) ready.push(byId.get(polity.parentId)!);
  }
  return areas;
}

/** Round and format an area for display using a positive increment. */
export function formatArea(value: number, unit: string, rounding = 100): string {
  const rounded = Math.round(value / rounding) * rounding;
  return `${rounded.toLocaleString(undefined, { maximumFractionDigits: 10 })} ${unit}²`;
}

export interface SurfaceStatistic {
  label: string;
  /** Number of hexes containing any of this surface or carrying this layer value. */
  hexCount: number;
  area: number;
}

/**
 * Split the complete grid into land, salt water, and lake-water surface. Shore
 * hexes can contribute to two rows, so hex counts describe containing hexes;
 * areas, unlike those counts, partition the grid exactly.
 */
export function baseSurfaceStatistics(
  base: BaseData,
  dimensions: HexDimensions,
  specs?: Record<string, IslandSpec>,
  shapes?: Record<string, HexShape>,
): SurfaceStatistic[] {
  const hexArea = dimensions.width * dimensions.height * 0.75;
  const stats = new Map(['Land', 'Sea', 'Lake'].map((label) => [label, { label, hexCount: 0, area: 0 }]));
  for (let index = 0; index < base.length; index++) {
    const value = base[index]!;
    const land = landFraction(value, specs?.[String(index)], dimensions, shapes?.[String(index)]);
    const water = 1 - land;
    if (land > 0) {
      const stat = stats.get('Land')!;
      stat.hexCount++;
      stat.area += hexArea * land;
    }
    if (water > 0) {
      const stat = stats.get(value === 'Lake' ? 'Lake' : 'Sea')!;
      stat.hexCount++;
      stat.area += hexArea * water;
    }
  }
  return [...stats.values()];
}

/**
 * Count each non-null value in a land-only layer and weight its area by the
 * actual land share of the corresponding base hex.
 */
export function landLayerSurfaceStatistics(
  values: readonly (string | null)[],
  orderedValues: readonly string[],
  base: BaseData,
  dimensions: HexDimensions,
  specs?: Record<string, IslandSpec>,
  shapes?: Record<string, HexShape>,
): SurfaceStatistic[] {
  const hexArea = dimensions.width * dimensions.height * 0.75;
  const stats = new Map(orderedValues.map((label) => [label, { label, hexCount: 0, area: 0 }]));
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === null || value === undefined) continue;
    const stat = stats.get(value);
    if (!stat) continue;
    stat.hexCount++;
    stat.area += hexArea * landFraction(base[index], specs?.[String(index)], dimensions, shapes?.[String(index)]);
  }
  return [...stats.values()].filter((stat) => stat.hexCount > 0);
}

/** Which single measurement of a regular pointy-top hex the user supplies. */
export type HexMeasure = 'width' | 'corners' | 'side' | 'area';

const SQRT3 = Math.sqrt(3);

export interface HexMeasures {
  /** Flat to flat. */
  width: number;
  /** Corner to corner. */
  corners: number;
  /** Length of one edge (equals the centre-to-corner radius). */
  side: number;
  /** Full area of the hex, before coast/island land shares. */
  area: number;
}

/** Every measurement of a regular hex, derived from its flat-to-flat width. */
export function measuresFromWidth(width: number): HexMeasures {
  return {
    width,
    corners: (2 * width) / SQRT3,
    side: width / SQRT3,
    area: (SQRT3 / 2) * width * width,
  };
}

/** Flat-to-flat width of the regular hex with the given measurement. */
export function widthFromMeasure(measure: HexMeasure, value: number): number {
  switch (measure) {
    case 'width':
      return value;
    case 'corners':
      return (value * SQRT3) / 2;
    case 'side':
      return value * SQRT3;
    case 'area':
      return Math.sqrt((2 * value) / SQRT3);
  }
}

/** Width and height of the regular hex described by one measurement. */
export function regularHexSize(
  measure: HexMeasure,
  value: number,
): Pick<HexDimensions, 'width' | 'height'> {
  const width = widthFromMeasure(measure, value);
  return { width, height: measuresFromWidth(width).corners };
}

/** True when height is the regular-hex height for this width (within rounding). */
export function isRegularHex(dimensions: Pick<HexDimensions, 'width' | 'height'>): boolean {
  const expected = measuresFromWidth(dimensions.width).corners;
  return Math.abs(dimensions.height - expected) <= expected * 0.002;
}
