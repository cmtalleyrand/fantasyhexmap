/**
 * Facts derived from other layers rather than stored independently: which edges
 * of a hex touch water, which rivers run through it, and so on. Both the server
 * (after generation) and the client (after a manual edit) recompute these, so a
 * city's `coastal` flag can never drift from the base geography it describes.
 */

import { hexIndex, neighbourOf, inBounds } from './hex.js';
import { isIslandType } from './types.js';
import type {
  BaseData,
  BaseGeo,
  City,
  Elevation,
  River,
} from './types.js';

/** Open water: a river empties into it, a city beside it is on the coast. A strait is a channel of it. */
export const WATER: BaseGeo[] = ['Sea', 'Lake', 'Strait', 'Sea Ice'];

export function isWater(v: BaseGeo | undefined): boolean {
  return v === 'Sea' || v === 'Lake' || v === 'Strait' || v === 'Sea Ice';
}

export function isLandLike(v: BaseGeo | undefined): boolean {
  return v === 'Land' || v === 'Glacier' || v === 'Isthmus' || isIslandType(v);
}

/** Whole-hex water a shore runs along: everything drawn as water across a shared edge. */
function isShoreWater(v: BaseGeo | null | undefined): boolean {
  return v === 'Sea' || v === 'Lake' || v === 'Sea Ice' || v === 'Islands';
}

/**
 * Whether hex `i` is Land with a shore: an edge shared with sea, lake, sea ice or an
 * island-sea hex. Such a hex is drawn and measured at the map's coastal land share
 * (`HexDimensions.coastalLandPercent`) and takes coast settings (`HexShape`); inland
 * Land is whole. Off-map edges do not count.
 */
export function isShoreLand(base: ReadonlyArray<BaseGeo | null | undefined>, cols: number, i: number): boolean {
  if (base[i] !== 'Land') return false;
  const rows = Math.floor(base.length / cols);
  const col = i % cols;
  const row = Math.floor(i / cols);
  for (let e = 0; e < 6; e++) {
    const n = neighbourOf(col, row, e);
    if (inBounds(cols, rows, n.col, n.row) && isShoreWater(base[hexIndex(cols, n.col, n.row)])) return true;
  }
  return false;
}

/**
 * Whether a city may stand on, or a polity own, a hex of this type. Land and
 * straits always qualify (a strait city straddles its channel); Sea and Lake
 * qualify when the map opts in to underwater settlement. Sea Ice never does.
 */
export function canHoldSettlement(v: BaseGeo | undefined, allowUnderwater: boolean | undefined): boolean {
  return isLandLike(v) || v === 'Strait' || (allowUnderwater === true && (v === 'Sea' || v === 'Lake'));
}

/** Edges of (col,row) that border a Sea or Lake hex. Off-map edges do not count. */
export function waterEdgesOf(
  base: BaseData,
  cols: number,
  rows: number,
  col: number,
  row: number,
): number[] {
  const out: number[] = [];
  for (let e = 0; e < 6; e++) {
    const n = neighbourOf(col, row, e);
    if (!inBounds(cols, rows, n.col, n.row)) continue;
    if (isWater(base[hexIndex(cols, n.col, n.row)])) out.push(e);
  }
  return out;
}

export function edgesToOffMap(
  cols: number,
  rows: number,
  col: number,
  row: number,
): number[] {
  const out: number[] = [];
  for (let e = 0; e < 6; e++) {
    const n = neighbourOf(col, row, e);
    if (!inBounds(cols, rows, n.col, n.row)) out.push(e);
  }
  return out;
}

export function riversThroughHex(rivers: River[], col: number, row: number): River[] {
  return rivers.filter((r) => r.segments.some((s) => s.col === col && s.row === row));
}

/**
 * Recompute a city's derived flags from the layers as they currently stand.
 * The model proposes these; we never trust its answer over the actual map.
 */
export function recomputeCityFacts(
  city: City,
  base: BaseData,
  cols: number,
  rows: number,
  rivers: River[] | null,
): City {
  const coastalEdges = waterEdgesOf(base, cols, rows, city.col, city.row);
  const through = rivers ? riversThroughHex(rivers, city.col, city.row) : [];
  const riverId =
    through.length > 0
      ? through.find((r) => r.id === city.riverId)?.id ?? through[0]!.id
      : null;
  return {
    ...city,
    coastal: coastalEdges.length > 0,
    coastalEdges,
    onRiver: through.length > 0,
    riverId,
  };
}

/**
 * Height ranking used only for the heuristic "does this river flow uphill?"
 * check. Plateau is explicitly NOT ordinal against Hills/Mountains in the data
 * model - it is high ground with low ruggedness - so for flow purposes alone we
 * treat it as comparable to Highland and say so in the warning text.
 */
export const ELEVATION_FLOW_RANK: Record<Elevation, number> = {
  Lowland: 0,
  Rolling: 1,
  Hills: 2,
  Plateau: 3,
  Highland: 3,
  Mountains: 4,
};
