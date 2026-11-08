import { adjacentHexes, isCategoryLand, isCategoryWater, landShareRange, passageNeighbours } from './hexCategories.js';
import { landFractionAt, normaliseHexDimensions } from './surfaceArea.js';
import { isIslandType, islandSpecFor, type MapState } from './types.js';

/** Validate geography independently of land-layer and settlement eligibility. */
export function validateHexDefinitions(map: MapState): string[] {
  const base = map.layers.base.data;
  if (!base) return [];
  const dims = normaliseHexDimensions(map.hexDimensions);
  const share = (i: number) => landFractionAt(base, i, dims, map.islandSpecs, map.hexShapes, map.cols) * 100;
  const notes: string[] = [];
  for (let i = 0; i < base.length; i++) {
    const value = base[i], adjacent = adjacentHexes(base, map.cols, i);
    const land = adjacent.filter(j => isCategoryLand(base[j]));
    const water = adjacent.filter(j => isCategoryWater(base[j]));
    const problems: string[] = [];
    if ((value === 'Strait' || value === 'Isthmus') && !passageNeighbours(base, map.cols, i).valid)
      problems.push('requires exactly two separate land groups and two separate water groups (2–4 water neighbours)');
    if (value === 'Mainland and islands' && (!land.length || !water.length))
      problems.push('requires a land and a water neighbour');
    if (value === 'Islands' && land.some(j => share(j) >= 100))
      problems.push('cannot adjoin 100% land; use Mainland and islands');
    const stored = map.hexShapes?.[i];
    if (stored && stored.type === value && stored.land !== undefined) {
      const [min, max] = landShareRange(value, isIslandType(value) ? islandSpecFor(value, map.islandSpecs?.[i]) : undefined);
      if (stored.land < min || stored.land > max) problems.push(`land share must be ${min}–${max}%`);
      if ((value === 'Sea' || value === 'Lake' || value === 'Sea Ice') && !land.length && stored.land !== 0)
        problems.push('water without adjacent land must have 0% land');
    }
    if (problems.length) notes.push(`Hex definition (${i % map.cols},${Math.floor(i / map.cols)}): ${value} ${problems.join('; ')}.`);
  }
  return notes;
}
