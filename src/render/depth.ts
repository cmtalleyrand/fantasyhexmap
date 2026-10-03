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

/** Hex steps from `from` to every hex it reaches through `depth`'s hexes. */
function hopsFrom(from: number, depth: ReadonlyMap<number, number>, cols: number, rows: number): Map<number, number> {
  const hops = new Map<number, number>([[from, 0]]);
  let frontier = [from];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const i of frontier) {
      for (let e = 0; e < 6; e++) {
        const n = neighbourOf(i % cols, Math.floor(i / cols), e);
        if (!inBounds(cols, rows, n.col, n.row)) continue;
        const j = hexIndex(cols, n.col, n.row);
        if (!depth.has(j) || hops.has(j)) continue;
        hops.set(j, hops.get(i)! + 1);
        next.push(j);
      }
    }
    frontier = next;
  }
  return hops;
}

function farthest(hops: ReadonlyMap<number, number>): number {
  let best = -1;
  let far = -1;
  for (const [i, h] of hops) {
    if (h > best || (h === best && i < far)) {
      best = h;
      far = i;
    }
  }
  return far;
}

/**
 * A path through the middle of a region, end to end: between its two most
 * distant hexes, keeping to the deepest ground it can. This is what a name
 * follows when it is too long to lie straight in a winding body of water.
 * Returns hex indices in order, or none for an empty region.
 */
export function ridgePath(depth: ReadonlyMap<number, number>, cols: number, rows: number): number[] {
  if (depth.size === 0) return [];
  let seed = -1;
  for (const [i, d] of depth) if (seed < 0 || d > depth.get(seed)! || (d === depth.get(seed) && i < seed)) seed = i;
  const a = farthest(hopsFrom(seed, depth, cols, rows));
  const b = farthest(hopsFrom(a, depth, cols, rows));
  const cap = Math.min(12, Math.max(...depth.values()));
  const stepCost = (j: number) => 1 + 4 * (1 - Math.min(depth.get(j)!, cap) / cap);

  // Dijkstra from a to b: cheap to cross deep water, dear to hug the shore.
  const cost = new Map<number, number>([[a, 0]]);
  const via = new Map<number, number>();
  const heap: Array<[number, number]> = [[0, a]];
  const push = (item: [number, number]) => {
    heap.push(item);
    let k = heap.length - 1;
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (heap[parent]![0] <= heap[k]![0]) break;
      [heap[parent], heap[k]] = [heap[k]!, heap[parent]!];
      k = parent;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const r = l + 1;
        let m = k;
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k]!, heap[m]!];
        k = m;
      }
    }
    return top;
  };
  while (heap.length > 0) {
    const [c, i] = pop();
    if (c > (cost.get(i) ?? Infinity)) continue;
    if (i === b) break;
    for (let e = 0; e < 6; e++) {
      const n = neighbourOf(i % cols, Math.floor(i / cols), e);
      if (!inBounds(cols, rows, n.col, n.row)) continue;
      const j = hexIndex(cols, n.col, n.row);
      if (!depth.has(j)) continue;
      const next = c + stepCost(j);
      if (next < (cost.get(j) ?? Infinity)) {
        cost.set(j, next);
        via.set(j, i);
        push([next, j]);
      }
    }
  }
  const path = [b];
  while (path[path.length - 1] !== a) {
    const prev = via.get(path[path.length - 1]!);
    if (prev === undefined) return [a];
    path.push(prev);
  }
  return path.reverse();
}
