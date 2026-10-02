/**
 * Coastlines.
 *
 * The coast is traced from the data: every hex edge with land on one side and
 * water on the other is a coast edge, oriented the same way around every land
 * hex, so the edges join end to start into chains. A chain is closed when it
 * goes all the way round (an island, a lake) and open when it runs off the map.
 * A vertex where three hexes meet is never ambiguous on a hex grid (there is
 * always exactly one coast edge in and one out), so the chaining needs no
 * tie-breaking.
 *
 * Smoothing replaces each chain with the quadratic B-spline through its edge
 * midpoints. That curve still passes through the midpoint of every coast edge
 * and never strays more than an eighth of a hex (size / 8) from the hex corner
 * it rounds, so no hex changes side. The hex fills are corrected to match: at
 * every vertex the curve cuts across, the small "sliver" between the corner and
 * the curve is repainted with the colour of the side it now belongs to.
 */

import { hexCorners, hexEdgePoints, hexIndex, inBounds, neighbourOf, type Point } from '../../shared/hex.js';
import { isIslandType, type BaseGeo } from '../../shared/types.js';
import type { PathCmd } from './prims.js';

export type Side = 'land' | 'water';

/** Which side of the coast a hex is on. Island hexes of every kind are sea with land drawn on top. */
export function sideOf(value: BaseGeo | null | undefined): Side | null {
  if (!value) return null;
  return value === 'Sea' || value === 'Lake' || isIslandType(value) ? 'water' : 'land';
}

interface CoastEdge {
  from: Point;
  to: Point;
  land: number;
  water: number;
}

export interface CoastChain {
  /** Hex corners along the chain; for a closed chain the first corner is not repeated. */
  points: Point[];
  /** edges[k] runs from points[k] to points[k + 1] (wrapping when closed). */
  edges: CoastEdge[];
  closed: boolean;
}

export interface Sliver {
  d: PathCmd[];
  /** The hex whose fill the sliver takes. */
  donor: number;
}

export interface CoastGeometry {
  chains: CoastChain[];
  /** One path per chain, along hex edges or smoothed. */
  paths: PathCmd[][];
  /** Corners of land the smoothed coast cuts off: they become water. */
  toWater: Sliver[];
  /** Notches of water the smoothed coast fills in: they become land. */
  toLand: Sliver[];
}

const key = (p: Point) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;

export function coastEdges(base: ReadonlyArray<BaseGeo | null>, cols: number, rows: number, size: number): CoastEdge[] {
  const edges: CoastEdge[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = hexIndex(cols, col, row);
      if (sideOf(base[i]) !== 'land') continue;
      for (let e = 0; e < 6; e++) {
        const n = neighbourOf(col, row, e);
        if (!inBounds(cols, rows, n.col, n.row)) continue;
        const j = hexIndex(cols, n.col, n.row);
        if (sideOf(base[j]) !== 'water') continue;
        const [from, to] = hexEdgePoints(col, row, e, size);
        edges.push({ from, to, land: i, water: j });
      }
    }
  }
  return edges;
}

export function chainEdges(edges: CoastEdge[]): CoastChain[] {
  // Coast edges never share a start point, but other boundary sets (realm
  // frontiers meeting at a three-way junction) can, so starts map to lists.
  const byStart = new Map<string, number[]>();
  const ends = new Set<string>();
  edges.forEach((edge, i) => {
    const k = key(edge.from);
    byStart.set(k, [...(byStart.get(k) ?? []), i]);
    ends.add(key(edge.to));
  });
  const used = new Uint8Array(edges.length);
  const chains: CoastChain[] = [];
  const next = (at: Point): number | undefined => byStart.get(key(at))?.find((j) => !used[j]);
  const follow = (start: number): CoastEdge[] => {
    const run: CoastEdge[] = [];
    let i: number | undefined = start;
    while (i !== undefined && !used[i]) {
      used[i] = 1;
      run.push(edges[i]!);
      i = next(edges[i]!.to);
    }
    return run;
  };
  const push = (run: CoastEdge[]) => {
    // A run is a loop only if it really comes back to where it began.
    const closed = run.length > 2 && key(run[run.length - 1]!.to) === key(run[0]!.from);
    chains.push(
      closed
        ? { points: run.map((e) => e.from), edges: run, closed: true }
        : { points: [run[0]!.from, ...run.map((e) => e.to)], edges: run, closed: false },
    );
  };
  // Open chains first: they start where no edge ends (at the map edge, or a junction).
  edges.forEach((edge, i) => {
    if (used[i] || ends.has(key(edge.from))) return;
    push(follow(i));
  });
  edges.forEach((_, i) => {
    if (!used[i]) push(follow(i));
  });
  return chains;
}

const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

function hexPath(chain: CoastChain): PathCmd[] {
  const d: PathCmd[] = chain.points.map((p, i) => [i === 0 ? 'M' : 'L', p.x, p.y] as PathCmd);
  if (chain.closed) d.push(['Z']);
  return d;
}

/** Quadratic B-spline through the edge midpoints, with the corners as control points. */
export function smoothPath(points: Point[], closed: boolean): PathCmd[] {
  const n = points.length;
  if (n < 2) return [];
  if (closed) {
    const start = mid(points[n - 1]!, points[0]!);
    const d: PathCmd[] = [['M', start.x, start.y]];
    for (let k = 0; k < n; k++) {
      const p = points[k]!;
      const m = mid(p, points[(k + 1) % n]!);
      d.push(['Q', p.x, p.y, m.x, m.y]);
    }
    d.push(['Z']);
    return d;
  }
  const first = points[0]!;
  const d: PathCmd[] = [['M', first.x, first.y]];
  const m0 = mid(first, points[1]!);
  d.push(['L', m0.x, m0.y]);
  for (let k = 1; k < n - 1; k++) {
    const p = points[k]!;
    const m = mid(p, points[k + 1]!);
    d.push(['Q', p.x, p.y, m.x, m.y]);
  }
  const last = points[n - 1]!;
  d.push(['L', last.x, last.y]);
  return d;
}

/** The region between corner `p` and the curve that rounds it. */
function sliverPath(a: Point, p: Point, b: Point): PathCmd[] {
  const m1 = mid(a, p);
  const m2 = mid(p, b);
  return [['M', m1.x, m1.y], ['L', p.x, p.y], ['L', m2.x, m2.y], ['Q', p.x, p.y, m1.x, m1.y], ['Z']];
}

export function coastGeometry(
  base: ReadonlyArray<BaseGeo | null>,
  cols: number,
  rows: number,
  size: number,
  smooth: boolean,
): CoastGeometry {
  const chains = chainEdges(coastEdges(base, cols, rows, size));
  const toWater: Sliver[] = [];
  const toLand: Sliver[] = [];
  const paths = chains.map((chain) => {
    if (!smooth || chain.points.length < 3) return hexPath(chain);
    const { points, edges, closed } = chain;
    const n = points.length;
    for (let k = closed ? 0 : 1; k < (closed ? n : n - 1); k++) {
      const incoming = edges[(k - 1 + edges.length) % edges.length]!;
      const outgoing = edges[k % edges.length]!;
      const d = sliverPath(points[(k - 1 + n) % n]!, points[k]!, points[(k + 1) % n]!);
      // Two coast edges of the same land hex meet at a corner that sticks out
      // into the water; edges of two different land hexes meet in a notch.
      if (incoming.land === outgoing.land) toWater.push({ d, donor: incoming.water });
      else toLand.push({ d, donor: incoming.land });
    }
    return smoothPath(points, closed);
  });
  return { chains, paths, toWater, toLand };
}

/** Path commands for the outline of every hex in `indices`, as one compound path. */
export function hexesPath(indices: Iterable<number>, cols: number, size: number): PathCmd[] {
  const d: PathCmd[] = [];
  for (const i of indices) {
    hexCorners(i % cols, Math.floor(i / cols), size).forEach((p, k) => d.push([k === 0 ? 'M' : 'L', p.x, p.y]));
    d.push(['Z']);
  }
  return d;
}

/** A circle as path commands (four cubic arcs), for strokes that must join other coast paths. */
export function circlePath(c: Point, r: number): PathCmd[] {
  const k = 0.5523 * r;
  return [
    ['M', c.x + r, c.y],
    ['C', c.x + r, c.y + k, c.x + k, c.y + r, c.x, c.y + r],
    ['C', c.x - k, c.y + r, c.x - r, c.y + k, c.x - r, c.y],
    ['C', c.x - r, c.y - k, c.x - k, c.y - r, c.x, c.y - r],
    ['C', c.x + k, c.y - r, c.x + r, c.y - k, c.x + r, c.y],
    ['Z'],
  ];
}

/**
 * An irregular islet roughly the size of the classic island dot: a ring of
 * seeded radii, smoothed. Elongated a little along a seeded axis so a chain of
 * islets does not read as a row of identical pebbles.
 */
export function isletPath(c: Point, size: number, rand: (k: number) => number): PathCmd[] {
  const count = 9;
  const stretch = 1 + 0.35 * rand(100);
  const axis = rand(101) * Math.PI;
  const points: Point[] = [];
  for (let k = 0; k < count; k++) {
    const angle = (k / count) * Math.PI * 2 + (rand(k) - 0.5) * 0.4;
    const r = size * 0.34 * (0.7 + 0.5 * rand(k + 50));
    const x = Math.cos(angle) * r * stretch;
    const y = Math.sin(angle) * r / stretch;
    points.push({
      x: c.x + x * Math.cos(axis) - y * Math.sin(axis),
      y: c.y + x * Math.sin(axis) + y * Math.cos(axis),
    });
  }
  return smoothPath(points, true);
}

/**
 * Lakes of one or two hexes. Traced from the hex edges they come out as a
 * rounded hexagon or a lozenge, which reads as a drawn symbol rather than a
 * lake, so they are drawn instead as an irregular body sized to fill most of
 * their hexes. Returns each such lake's hexes.
 */
export function smallLakes(
  base: ReadonlyArray<BaseGeo | null>,
  cols: number,
  rows: number,
  maxHexes = 2,
): number[][] {
  const seen = new Uint8Array(base.length);
  const out: number[][] = [];
  for (let i = 0; i < base.length; i++) {
    if (seen[i] || base[i] !== 'Lake') continue;
    const component: number[] = [];
    const stack = [i];
    seen[i] = 1;
    while (stack.length > 0) {
      const h = stack.pop()!;
      component.push(h);
      for (let e = 0; e < 6; e++) {
        const n = neighbourOf(h % cols, Math.floor(h / cols), e);
        if (!inBounds(cols, rows, n.col, n.row)) continue;
        const j = hexIndex(cols, n.col, n.row);
        if (!seen[j] && base[j] === 'Lake') {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    if (component.length <= maxHexes) out.push(component.sort((a, b) => a - b));
  }
  return out;
}

/**
 * An irregular closed body: an ellipse of half-axes rx, ry turned by `axis`,
 * with each of its control points pushed in or out by up to `wobble` of its
 * radius, then smoothed.
 */
export function blobPath(
  c: Point,
  rx: number,
  ry: number,
  axis: number,
  rand: (k: number) => number,
  count = 10,
  wobble = 0.14,
): PathCmd[] {
  const points: Point[] = [];
  for (let k = 0; k < count; k++) {
    const angle = (k / count) * Math.PI * 2 + (rand(k) - 0.5) * 0.35;
    const scale = 1 + (rand(k + 50) - 0.5) * 2 * wobble;
    const x = Math.cos(angle) * rx * scale;
    const y = Math.sin(angle) * ry * scale;
    points.push({
      x: c.x + x * Math.cos(axis) - y * Math.sin(axis),
      y: c.y + x * Math.sin(axis) + y * Math.cos(axis),
    });
  }
  return smoothPath(points, true);
}

/**
 * The edge a Coastal Island lies against when the map does not say: the one
 * pointing most nearly at the nearest land hex (searched out to four hexes),
 * or edge 0 when there is no land that close.
 */
export function coastalIslandSide(
  base: ReadonlyArray<BaseGeo | null>,
  cols: number,
  rows: number,
  i: number,
  size = 1,
): number {
  const col = i % cols;
  const row = Math.floor(i / cols);
  const seen = new Set([i]);
  let frontier = [i];
  for (let ring = 0; ring < 4 && frontier.length > 0; ring++) {
    const next: number[] = [];
    const land: number[] = [];
    for (const h of frontier) {
      for (let e = 0; e < 6; e++) {
        const n = neighbourOf(h % cols, Math.floor(h / cols), e);
        if (!inBounds(cols, rows, n.col, n.row)) continue;
        const j = hexIndex(cols, n.col, n.row);
        if (seen.has(j)) continue;
        seen.add(j);
        if (sideOf(base[j]) === 'land') land.push(j);
        next.push(j);
      }
    }
    if (land.length > 0) {
      const here = hexCorners(col, row, size);
      const cx = here.reduce((s, p) => s + p.x, 0) / 6;
      const cy = here.reduce((s, p) => s + p.y, 0) / 6;
      let dx = 0;
      let dy = 0;
      for (const j of land) {
        const c = hexCorners(j % cols, Math.floor(j / cols), size);
        dx += c.reduce((s, p) => s + p.x, 0) / 6 - cx;
        dy += c.reduce((s, p) => s + p.y, 0) / 6 - cy;
      }
      // Edge e's midpoint lies at angle 60e degrees from the centre.
      const angle = Math.atan2(dy, dx);
      return ((Math.round(angle / (Math.PI / 3)) % 6) + 6) % 6;
    }
    frontier = next;
  }
  return 0;
}
