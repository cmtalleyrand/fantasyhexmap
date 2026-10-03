import {
  DEFAULT_HEX_DIMENSIONS,
  isIslandType,
  type BaseData,
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
export function politySurfaceAreas(
  base: BaseData,
  data: PolitiesData,
  dimensions: HexDimensions,
): Map<string, number> {
  const hexArea = dimensions.width * dimensions.height * 0.75;
  const areas = new Map(data.polities.map((polity) => [polity.id, 0]));
  for (let index = 0; index < data.owner.length; index++) {
    const owner = data.owner[index];
    if (!owner || !areas.has(owner)) continue;
    const fraction =
      base[index] === 'Coastal Land'
        ? dimensions.coastalLandPercent / 100
        : base[index] === 'Large Island'
          ? // One island filling most of its hex.
            Math.max(0.75, dimensions.islandLandPercent / 100)
          : isIslandType(base[index])
          ? dimensions.islandLandPercent / 100
          : base[index] === 'Land'
            ? 1
            : 0;
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
