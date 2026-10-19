/**
 * River measurements in the map's own units.
 *
 * The grid estimate runs from the centre of the hex where
 * the river rises, through the centre of each hex it passes, to the edge it
 * leaves the land by. That is the length of the course across the grid, not of
 * every meander inside a hex. Finished maps instead use measureRiverCourse
 * with the renderer's centreline so their measurements include those bends.
 */

import { edgeBetween, type Offset, type Point } from './hex.js';
import type { HexDimensions, River } from './types.js';

export interface RiverMeasurement {
  length: number;
  /** Drawn course length divided by the straight source-to-mouth distance. */
  sinuosity: number;
}

/** Measure the renderer's sampled centreline, scaling each axis to the map's units. */
export function measureRiverCourse(
  line: readonly Point[],
  dims: Pick<HexDimensions, 'width' | 'height'>,
  size: number,
): RiverMeasurement {
  const sx = dims.width / (Math.sqrt(3) * size);
  const sy = dims.height / (2 * size);
  const distance = (a: Point, b: Point) => Math.hypot((b.x - a.x) * sx, (b.y - a.y) * sy);
  let length = 0;
  for (let i = 1; i < line.length; i++) length += distance(line[i - 1]!, line[i]!);
  const straight = line.length > 1 ? distance(line[0]!, line.at(-1)!) : 0;
  return { length, sinuosity: straight > 0 ? Math.max(1, length / straight) : 1 };
}

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

/** Grid estimate when a drawn course is not available (for example, a hidden layer). */
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
  measurements?: Readonly<Record<string, RiverMeasurement>>,
): number {
  return [river, ...branchesOf(river, rivers)].reduce((sum, r) => sum + (measurements?.[r.id]?.length ?? riverLength(r, dims)), 0);
}

/** Round and format a length for display using a positive increment. */
export function formatLength(value: number, unit: string, rounding = 10): string {
  const rounded = Math.round(value / rounding) * rounding;
  return `${rounded.toLocaleString(undefined, { maximumFractionDigits: 10 })} ${unit}`;
}
