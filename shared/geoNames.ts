/**
 * Names of geographical areas: seas, lakes, land features and islands.
 *
 * A name is a set of hexes, kept as flat indices (`row * cols + col`). Which
 * hexes a name may hold depends on its kind and on the base geography as it
 * stands now, so eligibility is a function of the base layer, never stored:
 * when the geography changes, a name's ineligible hexes are simply ignored
 * (see `liveHexes`), as for mountain ranges.
 */

import { hexIndex, neighbourOf, inBounds } from './hex.js';
import type { BaseGeo, GeoName, GeoNameKind, MapState, WaterName } from './types.js';

export const GEO_NAME_KINDS: GeoNameKind[] = ['sea', 'lake', 'land', 'island'];

export const GEO_KIND_LABEL: Record<GeoNameKind, { singular: string; plural: string; accepts: string }> = {
  sea: {
    singular: 'Sea',
    plural: 'Seas',
    accepts: 'Sea, Strait and island hexes (open water with islands in it). Coastal land is excluded.',
  },
  lake: { singular: 'Lake', plural: 'Lakes', accepts: 'Lake hexes.' },
  land: {
    singular: 'Land feature',
    plural: 'Land features',
    accepts: 'Land hexes: Land, Coastal Land, Isthmus, Mainland and islands, and Ice. Not water and not island-sea hexes.',
  },
  island: {
    singular: 'Island',
    plural: 'Islands',
    accepts:
      'Island hexes, and the land hexes of any landmass that water surrounds on every side and that does not reach the map edge.',
  },
};

/** Dry land of every kind, including the land half of a split hex. Island-sea hexes are not land. */
export function isLandHex(v: BaseGeo | null | undefined): boolean {
  return v === 'Land' || v === 'Coastal Land' || v === 'Isthmus' || v === 'Mainland and islands' || v === 'Ice';
}

/**
 * The hexes of every landmass cut off from the rest of the map by water: a
 * connected group of land hexes with no hex on the map's border (past the
 * border, the land may go on). Island-sea hexes count as water here.
 */
export function islandLandHexes(base: ReadonlyArray<BaseGeo | null>, cols: number, rows: number): Set<number> {
  const out = new Set<number>();
  const seen = new Set<number>();
  for (let start = 0; start < base.length; start++) {
    if (seen.has(start) || !isLandHex(base[start])) continue;
    const group: number[] = [];
    let touchesEdge = false;
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const i = stack.pop()!;
      group.push(i);
      const col = i % cols;
      const row = Math.floor(i / cols);
      for (let e = 0; e < 6; e++) {
        const n = neighbourOf(col, row, e);
        if (!inBounds(cols, rows, n.col, n.row)) {
          touchesEdge = true;
          continue;
        }
        const j = hexIndex(cols, n.col, n.row);
        if (seen.has(j) || !isLandHex(base[j])) continue;
        seen.add(j);
        stack.push(j);
      }
    }
    if (!touchesEdge) for (const i of group) out.add(i);
  }
  return out;
}

/** A test for whether a hex may hold a name of `kind` on this base geography. */
export function geoEligibility(
  kind: GeoNameKind,
  base: ReadonlyArray<BaseGeo | null>,
  cols: number,
  rows: number,
): (index: number) => boolean {
  switch (kind) {
    case 'sea':
      return (i) => base[i] === 'Sea' || base[i] === 'Strait' || base[i] === 'Islands';
    case 'lake':
      return (i) => base[i] === 'Lake';
    case 'land':
      return (i) => isLandHex(base[i]);
    case 'island': {
      const land = islandLandHexes(base, cols, rows);
      return (i) => base[i] === 'Islands' || land.has(i);
    }
  }
}

/** The hexes of a name that are still eligible under the current geography. */
export function liveHexes(name: GeoName, eligible: (index: number) => boolean): number[] {
  return name.hexes.filter(eligible);
}

/**
 * Every geographical name of a map, with the older `waterNames` list read as
 * seas (or lakes, when all its hexes are lakes). Older saves hold names only
 * there.
 */
export function geoNamesOf(map: Pick<MapState, 'geoNames' | 'waterNames' | 'layers'>): GeoName[] {
  const base = map.layers.base.data;
  const legacy = (map.waterNames ?? []).map((w: WaterName): GeoName => ({
    id: w.id,
    name: w.name,
    hexes: w.hexes,
    kind: base && w.hexes.length > 0 && w.hexes.every((i) => base[i] === 'Lake') ? 'lake' : 'sea',
  }));
  return [...(map.geoNames ?? []), ...legacy];
}

/** The map with its older `waterNames` folded into `geoNames`; the same map when there are none. */
export function withMigratedGeoNames<T extends MapState>(map: T): T {
  if (!map.waterNames) return map;
  const { waterNames: _legacy, ...rest } = map;
  return { ...rest, geoNames: geoNamesOf(map) } as T;
}
