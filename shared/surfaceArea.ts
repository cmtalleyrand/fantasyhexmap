import { holdersOf } from './polityShares.js';
import {
  CHANNEL_WIDTH_PERCENT,
  CHANNEL_WIDTH_VALUES,
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
import { neighbourOf, inBounds } from './hex.js';
import { isShoreLand } from './derive.js';

/**
 * How far (as a share of a hex, 0 to 1) the land a hex is drawn with may stray from its land share
 * and still count as meeting it: the area fits stop there, and only a larger miss is reported.
 */
export const LAND_SHARE_TOLERANCE = 0.025;

/** Dimensions saved before land shares were set per type carried one island share. */
type StoredHexDimensions = Partial<HexDimensions> & { islandLandPercent?: number };

export function normaliseHexDimensions(value?: StoredHexDimensions): HexDimensions {
  const { islandLandPercent, ...rest } = value ?? {};
  const out = { ...DEFAULT_HEX_DIMENSIONS, ...rest };
  // The old defaults (70% and 30% for an isthmus, 40% for a strait) were not chosen: those maps take the natural shape.
  if (out.isthmusPercent === 70 || out.isthmusPercent === 30 || typeof out.isthmusPercent !== 'number') delete out.isthmusPercent;
  if (out.straitPercent === 40 || typeof out.straitPercent !== 'number') delete out.straitPercent;
  if (!CHANNEL_WIDTH_VALUES.includes(out.isthmusWidth)) out.isthmusWidth = DEFAULT_HEX_DIMENSIONS.isthmusWidth;
  if (!CHANNEL_WIDTH_VALUES.includes(out.straitWidth)) out.straitWidth = DEFAULT_HEX_DIMENSIONS.straitWidth;
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
  out.seaLandPercent = Number.isFinite(out.seaLandPercent) ? Math.max(0, Math.min(100, out.seaLandPercent)) : 0;
  return out;
}

/**
 * How narrow the isthmus or strait in a hex is at its thinnest, as a share (0 to 1) of the hex's
 * flat-to-flat width: the hex's own setting, else the map's. Null for any other type.
 */
export function channelWidthFraction(
  value: BaseGeo | null | undefined,
  dimensions: HexDimensions,
  shape?: HexShape,
): number | null {
  if (value !== 'Isthmus' && value !== 'Strait') return null;
  const width = hexShapeFor(value, shape).width ?? (value === 'Isthmus' ? dimensions.isthmusWidth : dimensions.straitWidth);
  return CHANNEL_WIDTH_PERCENT[width] / 100;
}

/**
 * The land share a person has set on an isthmus or strait, from 0 to 1: the hex's own, else the map's.
 * Null when neither is set (or for any other type): the shape is then the natural one for its width.
 */
export function channelShareSet(
  value: BaseGeo | null | undefined,
  dimensions: HexDimensions,
  shape?: HexShape,
): number | null {
  if (value !== 'Isthmus' && value !== 'Strait') return null;
  const own = hexShapeFor(value, shape).land;
  const mapWide = value === 'Isthmus' ? dimensions.isthmusPercent : dimensions.straitPercent;
  const percent = own ?? mapWide;
  return percent === undefined ? null : Math.min(100, Math.max(0, percent)) / 100;
}

/**
 * The part of a hex a straight neck or channel through it, of width `fraction` of the hex's
 * flat-to-flat width, covers: the width times the flat-to-flat span over the hex's area.
 */
export function channelAreaFraction(fraction: number): number {
  return Math.min(1, (2 / Math.sqrt(3)) * fraction);
}

/**
 * How much of a hex is land, from 0 to 1. A hex a person has given a land share
 * takes that. Otherwise it is its type's share (see `HexDimensions`): Land on a
 * shore (`shore`, see `isShoreLand`), a lake, an isthmus, a strait or a glacier has one; an island hex is the sum of its
 * islands, each large island and each small one taking its own share; and a
 * mainland-and-islands hex adds the mainland's share to those. Inland Land is whole,
 * whatever is set on it.
 */
export function landFraction(
  value: BaseGeo | null | undefined,
  stored: IslandSpec | undefined,
  dimensions: HexDimensions,
  shape?: HexShape,
  shore = false,
): number {
  if (value === 'Land' && !shore) return 1;
  const set = hexShapeFor(value, shape).land;
  if (set !== undefined) return set / 100;
  const percent = (n: number) => Math.min(100, Math.max(0, n)) / 100;
  // With no share set, an isthmus or strait counts the share of a straight neck or channel of its width.
  const mapWide = value === 'Isthmus' ? dimensions.isthmusPercent : value === 'Strait' ? dimensions.straitPercent : undefined;
  if (mapWide !== undefined) return percent(mapWide);
  const width = channelWidthFraction(value, dimensions, shape);
  if (width !== null) return value === 'Isthmus' ? channelAreaFraction(width) : 1 - channelAreaFraction(width);
  switch (value) {
    case 'Land':
      return percent(dimensions.coastalLandPercent);
    case 'Glacier':
      return percent(dimensions.glacierPercent);
    case 'Sea':
      return percent(dimensions.seaLandPercent ?? 0);
    case 'Lake':
      return percent(dimensions.lakeLandPercent);
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
 * `landFraction` of hex `index` in its place on the grid: Land takes the coastal share
 * where it meets water, and Sea land shares extend existing shores (open sea contributes
 * no land area). Without `cols` neither can be known: Land is whole and Sea takes its share.
 */
export function landFractionAt(
  base: BaseData, index: number, dimensions: HexDimensions,
  specs?: Record<string, IslandSpec>, shapes?: Record<string, HexShape>, cols?: number,
): number {
  if (base[index] === 'Sea' && cols !== undefined) {
    const rows = base.length / cols;
    const shore = [0, 1, 2, 3, 4, 5].some(e => {
      const n = neighbourOf(index % cols, Math.floor(index / cols), e);
      if (!inBounds(cols, rows, n.col, n.row)) return false;
      const v = base[n.row * cols + n.col];
      return v === 'Land' || v === 'Glacier';
    });
    if (!shore) return 0;
  }
  const shore = cols !== undefined && isShoreLand(base, cols, index);
  const own = landFraction(base[index], specs?.[String(index)], dimensions, shapes?.[String(index)], shore);
  return cols === undefined ? own : withShoreSlack(base, cols, index, own, dimensions, shapes);
}

/**
 * How much of a hex either side of a shore always keeps for the other: water beside land that is
 * whole has at least this much land, and land beside water that has none at most one minus it.
 * A roughened coast wanders either side of the hex edge it follows, so a whole land hex beside
 * landless water asks for a shoreline that cannot exist; this leaves it room on both sides.
 */
export const SHORE_SLACK = 0.05;

/** Whole hexes a shore runs between: land that can be cut back, and water that can grow land. */
const SHORE_LAND: ReadonlySet<BaseGeo> = new Set(['Land', 'Glacier']);
const SHORE_WATER: ReadonlySet<BaseGeo> = new Set(['Sea', 'Lake']);

/**
 * `share`, the land share hex `index` has of its own, held to the shore slack (`SHORE_SLACK`): a Sea
 * or Lake hex beside a whole Land or Glacier hex has at least that much land, and a Land or Glacier
 * hex beside a landless Sea or Lake hex at most one minus it. Each side judges its neighbour by the
 * neighbour's own share, so the two rules never feed one another.
 */
export function withShoreSlack(
  base: ReadonlyArray<BaseGeo | null | undefined>, cols: number, index: number, share: number,
  dimensions: HexDimensions, shapes?: Record<string, HexShape>,
): number {
  const value = base[index];
  const land = value !== null && value !== undefined && SHORE_LAND.has(value);
  const water = value !== null && value !== undefined && SHORE_WATER.has(value);
  if (!land && !water) return share;
  const rows = Math.floor(base.length / cols);
  let floor = 0, ceiling = 1;
  for (let e = 0; e < 6; e++) {
    const n = neighbourOf(index % cols, Math.floor(index / cols), e);
    if (!inBounds(cols, rows, n.col, n.row)) continue;
    const j = n.row * cols + n.col, v = base[j];
    if (!v) continue;
    // The neighbour's own share: Land beside this water is on a shore by definition.
    const theirs = () => landFraction(v, undefined, dimensions, shapes?.[String(j)], v === 'Land');
    if (water && SHORE_LAND.has(v) && theirs() >= 1) floor = SHORE_SLACK;
    if (land && SHORE_WATER.has(v) && theirs() <= 0) ceiling = 1 - SHORE_SLACK;
  }
  return Math.min(ceiling, Math.max(floor, share));
}

/**
 * How much of a hex the coast draws as land, from 0 to 1: its share, except that
 * a Mainland and islands hex draws only its mainland there (its islands are drawn
 * separately, from the rest of the share), and a share set below the mainland's
 * leaves the mainland all of it. Null for a type with no share to draw, inland Land among them.
 */
export function drawnLandFraction(
  value: BaseGeo | null | undefined,
  dimensions: HexDimensions,
  shape?: HexShape,
  /** Whether a Land hex meets water (`isShoreLand`). */
  shore = false,
): number | null {
  switch (value) {
    case 'Land':
      return shore ? landFraction(value, undefined, dimensions, shape, true) : null;
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
    const fraction = landFractionAt(base, index, dimensions, specs, shapes, cols);
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
/**
 * Whether the water in hex `index`, not itself water, is lake water: every water hex it
 * meets is Lake (the water cut back from a lake's shore belongs to the lake).
 */
function lakeShoreOnly(base: BaseData, cols: number, index: number): boolean {
  if (base[index] === 'Sea' || base[index] === 'Lake') return false;
  const rows = base.length / cols;
  let lake = false;
  for (let e = 0; e < 6; e++) {
    const n = neighbourOf(index % cols, Math.floor(index / cols), e);
    if (!inBounds(cols, rows, n.col, n.row)) continue;
    const v = base[n.row * cols + n.col];
    if (v === 'Lake') lake = true;
    else if (v === 'Sea' || v === 'Sea Ice' || v === 'Islands') return false;
  }
  return lake;
}

export function baseSurfaceStatistics(
  base: BaseData,
  dimensions: HexDimensions,
  specs?: Record<string, IslandSpec>,
  shapes?: Record<string, HexShape>,
  cols?: number,
): SurfaceStatistic[] {
  const hexArea = dimensions.width * dimensions.height * 0.75;
  const stats = new Map(['Land', 'Sea', 'Lake'].map((label) => [label, { label, hexCount: 0, area: 0 }]));
  for (let index = 0; index < base.length; index++) {
    const value = base[index]!;
    const land = landFractionAt(base, index, dimensions, specs, shapes, cols);
    const water = 1 - land;
    if (land > 0) {
      const stat = stats.get('Land')!;
      stat.hexCount++;
      stat.area += hexArea * land;
    }
    if (water > 0) {
      const stat = stats.get(value === 'Lake' || (cols !== undefined && lakeShoreOnly(base, cols, index)) ? 'Lake' : 'Sea')!;
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
  cols?: number,
): SurfaceStatistic[] {
  const hexArea = dimensions.width * dimensions.height * 0.75;
  const stats = new Map(orderedValues.map((label) => [label, { label, hexCount: 0, area: 0 }]));
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (value === null || value === undefined) continue;
    const stat = stats.get(value);
    if (!stat) continue;
    stat.hexCount++;
    stat.area += hexArea * landFractionAt(base, index, dimensions, specs, shapes, cols);
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
