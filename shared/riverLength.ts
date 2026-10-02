/**
 * How long a river is, in the map's own units.
 *
 * The course is measured the way it is drawn: from the centre of the hex where
 * the river rises, through the centre of each hex it passes, to the edge it
 * leaves the land by. That is the length of the course across the grid, not of
 * every meander inside a hex - the map does not record those - so it reads as
 * a river's length on a map of this scale, a little under its length on the
 * ground.
 */

import { edgeBetween, type Offset } from './hex.js';
import type { HexDimensions, River } from './types.js';

/**
 * Centre-to-centre distance to the neighbour across `edge` of a pointy-top hex.
 * East and west neighbours sit one flat-to-flat width away; the four diagonal
 * ones half a width across and three quarters of the corner-to-corner height
 * down. For a regular hex both come to the width.
 */
export function stepLength(edge: number, dims: Pick<HexDimensions, 'width' | 'height'>): number {
  if (edge === 0 || edge === 3) return dims.width;
  return Math.hypot(dims.width / 2, (dims.height * 3) / 4);
}

/** Length of a run of adjacent hexes, centre to centre. Non-adjacent pairs are skipped. */
export function pathLength(path: readonly Offset[], dims: Pick<HexDimensions, 'width' | 'height'>): number {
  let total = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const edge = edgeBetween(path[i]!, path[i + 1]!);
    if (edge >= 0) total += stepLength(edge, dims);
  }
  return total;
}

/** The river's course from its source (or its fork, for a branch) to where it leaves the land. */
export function riverLength(river: River, dims: Pick<HexDimensions, 'width' | 'height'>): number {
  let total = pathLength(river.segments, dims);
  const last = river.segments[river.segments.length - 1];
  // Out of the last hex's centre to the coast, lake shore or map edge it crosses.
  if (last && last.exitEdge !== null) total += stepLength(last.exitEdge, dims) / 2;
  return total;
}

/** Every branch that splits off `river`, and off those branches in turn. */
export function branchesOf(river: River, rivers: readonly River[]): River[] {
  const out: River[] = [];
  const seen = new Set([river.id]);
  const queue = [river.id];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const r of rivers) {
      if (r.branchOf === parent && !seen.has(r.id)) {
        seen.add(r.id);
        out.push(r);
        queue.push(r.id);
      }
    }
  }
  return out;
}

/** A river and all of its branches together. */
export function riverSystemLength(
  river: River,
  rivers: readonly River[],
  dims: Pick<HexDimensions, 'width' | 'height'>,
): number {
  return [river, ...branchesOf(river, rivers)].reduce((sum, r) => sum + riverLength(r, dims), 0);
}

/** A length for display: whole units from 100 up, one decimal below. */
export function formatLength(value: number, unit: string): string {
  const digits = value >= 100 ? 0 : 1;
  return `${value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 })} ${unit}`;
}
