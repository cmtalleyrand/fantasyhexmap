/**
 * How deep each hex of a region lies inside it, for placing names: a name
 * wants the middle of what it names, and "middle" is the hexes furthest from
 * anything else, not the mean of the hexes (which for a ring is its hole).
 */

import { hexIndex, inBounds, neighbourOf } from '../../shared/hex.js';

/** Depth given to a region with no hex beside anything else: deep everywhere. */
export const NO_SHORE = 99;

/**
 * Hex distance of each hex of a region from the nearest hex outside it: 1 for
 * a hex beside the outside, rising inward. `hexes` are the region's hexes and
 * `inside` says whether a hex belongs to it. The map's edge does not count as
 * outside, since the region may go on past it.
 */
export function depthWithin(
  hexes: Iterable<number>,
  inside: (index: number) => boolean,
  cols: number,
  rows: number,
): Map<number, number> {
  const depth = new Map<number, number>();
  let frontier: number[] = [];
  const members: number[] = [];
  for (const i of hexes) {
    if (!inside(i)) continue;
    members.push(i);
    const col = i % cols;
    const row = Math.floor(i / cols);
    const shore = [0, 1, 2, 3, 4, 5].some((e) => {
      const n = neighbourOf(col, row, e);
      return inBounds(cols, rows, n.col, n.row) && !inside(hexIndex(cols, n.col, n.row));
    });
    if (shore) {
      depth.set(i, 1);
      frontier.push(i);
    }
  }
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const i of frontier) {
      for (let e = 0; e < 6; e++) {
        const n = neighbourOf(i % cols, Math.floor(i / cols), e);
        if (!inBounds(cols, rows, n.col, n.row)) continue;
        const j = hexIndex(cols, n.col, n.row);
        if (!inside(j) || depth.has(j)) continue;
        depth.set(j, depth.get(i)! + 1);
        next.push(j);
      }
    }
    frontier = next;
  }
  for (const i of members) if (!depth.has(i)) depth.set(i, NO_SHORE);
  return depth;
}
