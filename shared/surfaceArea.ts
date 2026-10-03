import {
  DEFAULT_HEX_DIMENSIONS,
  islandSpecFor,
  type BaseData,
  type BaseGeo,
  type IslandSpec,
  type HexDimensions,
  type PolitiesData,
} from './types.js';

export function normaliseHexDimensions(value?: Partial<HexDimensions>): HexDimensions {
  return { ...DEFAULT_HEX_DIMENSIONS, ...value };
}

/**
 * Returns land area by polity id. A pointy-top hex occupies 3/4 of its
 * flat-to-flat width times its corner-to-corner height.
 */
/**
 * How much of a hex is land. An island hex counts its islands: a large one
 * fills most of the share an island hex is given, a small one a fifth of it;
 * a mainland-and-islands hex is half mainland, an isthmus a little over half.
 */
export function landFraction(value: BaseGeo | null | undefined, stored: IslandSpec | undefined, dimensions: HexDimensions): number {
  const island = dimensions.islandLandPercent / 100;
  switch (value) {
    case 'Land':
      return 1;
    case 'Coastal Land':
      return dimensions.coastalLandPercent / 100;
    case 'Isthmus':
      return 0.6;
    case 'Islands':
    case 'Mainland and islands': {
      // One large island is most of the hex (as the old Large Island), a
      // second adds less as both shrink to fit; each small one is a share of
      // a single islet (the old Island counted the whole island share).
      const spec = islandSpecFor(value, stored);
      const large = spec.large === 0 ? 0 : spec.large === 1 ? Math.max(0.75, island) : Math.max(0.85, island);
      const islands = Math.min(1, large + spec.small * island * (spec.small === 1 ? 1 : 0.5));
      return value === 'Islands' ? islands : Math.min(1, 0.5 + islands * 0.5);
    }
    default:
      return 0;
  }
}

export function politySurfaceAreas(
  base: BaseData,
  data: PolitiesData,
  dimensions: HexDimensions,
  specs?: Record<string, IslandSpec>,
): Map<string, number> {
  const hexArea = dimensions.width * dimensions.height * 0.75;
  const areas = new Map(data.polities.map((polity) => [polity.id, 0]));
  for (let index = 0; index < data.owner.length; index++) {
    const owner = data.owner[index];
    if (!owner || !areas.has(owner)) continue;
    const fraction = landFraction(base[index], specs?.[String(index)], dimensions);
    areas.set(owner, areas.get(owner)! + hexArea * fraction);
  }
  return areas;
}

/** Round and format an area for display using a positive increment. */
export function formatArea(value: number, unit: string, rounding = 100): string {
  const rounded = Math.round(value / rounding) * rounding;
  return `${rounded.toLocaleString(undefined, { maximumFractionDigits: 10 })} ${unit}²`;
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
