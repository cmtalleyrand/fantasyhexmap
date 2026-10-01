import {
  DEFAULT_HEX_DIMENSIONS,
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
        : base[index] === 'Island'
          ? dimensions.islandLandPercent / 100
          : base[index] === 'Land'
            ? 1
            : 0;
    areas.set(owner, areas.get(owner)! + hexArea * fraction);
  }
  return areas;
}
