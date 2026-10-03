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

import { hexCenter, hexCorners, hexEdgePoints, hexIndex, inBounds, neighbourOf, type Point } from '../../shared/hex.js';
import { isIslandType, type BaseGeo } from '../../shared/types.js';
import type { PathCmd } from './prims.js';
import { signed } from './seed.js';

export type Side = 'land' | 'water';

/**
 * Which side of the coast a hex is on, taken whole. Islands hexes are sea
 * with land drawn on top; a strait is water and an isthmus or a mainland
 * coast with islands is land (their split into land and water is in
 * `surfaceMap`).
 */
export function sideOf(value: BaseGeo | null | undefined): Side | null {
  if (!value) return null;
  return value === 'Sea' || value === 'Sea Ice' || value === 'Lake' || value === 'Islands' || value === 'Strait' ? 'water' : 'land';
}

/* ------------------------------------------------------------ split hexes */

/**
 * What a piece of the map's surface is: land, sea, or lake water.
 */
export type Surface = 'land' | 'sea' | 'lake';

/**
 * A hex drawn partly land and partly water is cut into twelve pieces: six
 * inner triangles round the centre (pieces 0-5: the centre and the inner
 * corners k and k + 1) and six rim pieces between them and the hex edges
 * (pieces 6-11: inner corners k, k + 1 and hex corners k, k + 1, against edge
 * k). The inner corners lie CORE of the way from the centre to the corners, so
 * a neck of land or a channel of water through the inner triangles is a
 * about a third of a hex wide before the coast is smoothed.
 */
export const CORE = 0.32;

export interface SplitHex {
  /** The surface of each of the twelve pieces. */
  sides: Surface[];
  /** For each piece, the hex whose colours it takes: its own land, or the land or water it faces. */
  donors: number[];
}

export interface SurfaceMap {
  cols: number;
  rows: number;
  /** Each hex's surface taken whole; for a split hex, the surface of most of it. */
  whole: Array<Surface | null>;
  split: Map<number, SplitHex>;
}

/** The corners of piece `p` of hex (col, row), in the same turning order as a hex's own corners. */
export function piecePoints(col: number, row: number, p: number, size: number): Point[] {
  const c = hexCenter(col, row, size);
  const corners = hexCorners(col, row, size);
  const inner = corners.map((q) => ({ x: c.x + (q.x - c.x) * CORE, y: c.y + (q.y - c.y) * CORE }));
  const k = p % 6;
  const k1 = (k + 1) % 6;
  return p < 6 ? [c, inner[k]!, inner[k1]!] : [inner[k]!, corners[k]!, corners[k1]!, inner[k1]!];
}

/**
 * Every hex's surface, with isthmus, strait and mainland-with-islands hexes
 * split into pieces:
 *
 * - An isthmus is land with its rims facing water turned to water, leaving a
 *   neck through the centre joining the land on either side.
 * - A strait is water with its rims facing land turned to land (banks taking
 *   the colours of the land they face), leaving a channel through the centre.
 * - A mainland coast with islands is land in the sectors facing land and
 *   water in the rest, where its islands are drawn.
 *
 * Water in a split hex is lake where the water it joins is lake. An island
 * hex in a lake (`lakeIslands`) is lake water with its islands drawn on it.
 */
export function surfaceMap(
  base: ReadonlyArray<BaseGeo | null>,
  cols: number,
  rows: number,
  lakeIslands: ReadonlySet<number> = new Set(),
): SurfaceMap {
  const wholeOf = (i: number): Surface | null => {
    const v = base[i];
    if (!v) return null;
    if (v === 'Lake' || lakeIslands.has(i)) return 'lake';
    return sideOf(v) === 'water' ? 'sea' : 'land';
  };
  const whole = base.map((_, i) => wholeOf(i));
  const split = new Map<number, SplitHex>();
  for (let i = 0; i < base.length; i++) {
    const v = base[i];
    if (v !== 'Isthmus' && v !== 'Strait' && v !== 'Mainland and islands') continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const across = [0, 1, 2, 3, 4, 5].map((e) => {
      const n = neighbourOf(col, row, e);
      if (!inBounds(cols, rows, n.col, n.row)) return { j: -1, side: null as Surface | null };
      const j = hexIndex(cols, n.col, n.row);
      return { j, side: wholeOf(j) };
    });
    const wet = across.filter((a) => a.side === 'sea' || a.side === 'lake');
    const dry = across.filter((a) => a.side === 'land');
    if (wet.length === 0 || dry.length === 0) continue;
    // Water in the hex is lake if any of the water it opens on is lake.
    const water: Surface = wet.some((a) => a.side === 'lake') ? 'lake' : 'sea';
    const waterDonor = (wet.find((a) => a.side === water) ?? wet[0]!).j;
    const sides: Surface[] = [];
    const donors: number[] = [];
    for (let p = 0; p < 12; p++) {
      const facing = across[p % 6]!;
      const facesWater = facing.side === 'sea' || facing.side === 'lake';
      let side: Surface;
      if (v === 'Isthmus') side = p >= 6 && facesWater ? facing.side! : 'land';
      else if (v === 'Strait') side = p >= 6 && facing.side === 'land' ? 'land' : p >= 6 && facesWater ? facing.side! : water;
      else side = facing.side === 'land' ? 'land' : water;
      sides.push(side);
      if (side === 'land') donors.push(v === 'Strait' ? facing.j : i);
      else donors.push(p >= 6 && facesWater ? facing.j : waterDonor);
    }
    split.set(i, { sides, donors });
  }
  return { cols, rows, whole, split };
}

/** The surface of piece `p` (0-11) of hex `i`. */
export function pieceSurface(map: SurfaceMap, i: number, p: number): Surface | null {
  return map.split.get(i)?.sides[p] ?? map.whole[i] ?? null;
}

/** The hex whose colours piece `p` of hex `i` takes. */
export function pieceDonor(map: SurfaceMap, i: number, p: number): number {
  return map.split.get(i)?.donors[p] ?? i;
}

/**
 * Every boundary between pieces in `inside` and pieces not in it, oriented
 * with the inside on the right (the way a hex's own edges run), so they chain
 * into loops. `land` and `water` on each edge are the donor hexes of the
 * inside and outside pieces. With `only`, just the boundaries of those hexes.
 */
export function surfaceEdges(
  map: SurfaceMap,
  size: number,
  inside: (s: Surface) => boolean,
  only?: ReadonlySet<number>,
): CoastEdge[] {
  const { cols, rows } = map;
  const edges: CoastEdge[] = [];
  const isIn = (i: number, p: number) => {
    const side = pieceSurface(map, i, p);
    return side !== null && inside(side);
  };
  const hexes = only ? [...only] : Array.from({ length: cols * rows }, (_, i) => i);
  for (const i of hexes) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    /** The rim piece across hex edge e, as [hex, piece], or null off the map. */
    const outward = (e: number): [number, number] | null => {
      const n = neighbourOf(col, row, e);
      if (!inBounds(cols, rows, n.col, n.row)) return null;
      return [hexIndex(cols, n.col, n.row), 6 + ((e + 3) % 6)];
    };
    const emit = (from: Point, to: Point, p: number, other: [number, number] | null) => {
      if (!other || isIn(other[0], other[1])) return;
      edges.push({ from, to, land: pieceDonor(map, i, p), water: pieceDonor(map, other[0], other[1]), hex: i, across: other[0] });
    };
    if (!map.split.has(i)) {
      if (!isIn(i, 6)) continue;
      for (let e = 0; e < 6; e++) {
        const [a, b] = hexEdgePoints(col, row, e, size);
        emit(a, b, 6 + e, outward(e));
      }
      continue;
    }
    for (let p = 0; p < 12; p++) {
      if (!isIn(i, p)) continue;
      const k = p % 6;
      const pts = piecePoints(col, row, p, size);
      if (p < 6) {
        // Centre -> inner k, inner k -> inner k+1, inner k+1 -> centre.
        emit(pts[0]!, pts[1]!, p, [i, (k + 5) % 6]);
        emit(pts[1]!, pts[2]!, p, [i, 6 + k]);
        emit(pts[2]!, pts[0]!, p, [i, (k + 1) % 6]);
      } else {
        // Inner k -> corner k, corner k -> corner k+1 (the hex edge), corner k+1 -> inner k+1, inner k+1 -> inner k.
        emit(pts[0]!, pts[1]!, p, [i, 6 + ((k + 5) % 6)]);
        emit(pts[1]!, pts[2]!, p, outward(k));
        emit(pts[2]!, pts[3]!, p, [i, 6 + ((k + 1) % 6)]);
        emit(pts[3]!, pts[0]!, p, [i, k]);
      }
    }
  }
  return edges;
}

export interface CoastEdge {
  from: Point;
  to: Point;
  land: number;
  water: number;
  /** The hex the inside piece belongs to (`land` is the hex whose colours it takes, which can differ). */
  hex?: number;
  /** The hex across the edge. */
  across?: number;
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
  /** Water strips left between a hex's own edge and its inset coast (a hex with less than all of itself as land). */
  strips: Sliver[];
  /** One path per chain, along hex edges or smoothed. */
  paths: PathCmd[][];
  /** Corners of land the smoothed coast cuts off: they become water. */
  toWater: Sliver[];
  /** Notches of water the smoothed coast fills in: they become land. */
  toLand: Sliver[];
  /**
   * Where the drawn coast passes each hex corner it turns at (by `coastKey`): on a smoothed
   * or roughened coast that is off the corner itself. Absent for a coast drawn on the hex edges.
   */
  anchors: Map<string, Point>;
}

const key = (p: Point) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;

/** The key `CoastGeometry.anchors` uses for a hex corner. */
export const coastKey = key;

/** Every land/water boundary of the map, as `surfaceEdges` gives it, with lakes counted as water. */
export function coastEdges(base: ReadonlyArray<BaseGeo | null>, cols: number, rows: number, size: number): CoastEdge[] {
  return surfaceEdges(surfaceMap(base, cols, rows), size, (s) => s === 'land');
}

/** Interior points per hex edge and the sideways reach (in hex sizes) for each border irregularity. */
const BORDER_IRREGULARITY = {
  straight: { points: 0, reach: 0 },
  wobbly: { points: 2, reach: 0.06 },
  ragged: { points: 3, reach: 0.12 },
  wild: { points: 5, reach: 0.19 },
} as const;

/**
 * The points a border takes from `a` to `b`, ending at `b`. The wandering is
 * fixed by the edge's own ends, not by the direction it is walked or the realm
 * walking it, so both neighbours draw the same line along a shared edge.
 */
export function raggedEdge(a: Point, b: Point, level: keyof typeof BORDER_IRREGULARITY, seed: string, size: number): Point[] {
  const { points, reach } = BORDER_IRREGULARITY[level];
  if (points === 0) return [b];
  const forward = key(a) <= key(b);
  const [p, q] = forward ? [a, b] : [b, a];
  const id = `${key(p)}|${key(q)}`;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const len = Math.hypot(dx, dy) || 1;
  const out: Point[] = [];
  for (let k = 1; k <= points; k++) {
    const t = (k + signed(seed, 'border-t', id, k) * 0.25) / (points + 1);
    const off = signed(seed, 'border', id, k) * reach * size;
    out.push({ x: p.x + dx * t - (dy / len) * off, y: p.y + dy * t + (dx / len) * off });
  }
  if (!forward) out.reverse();
  out.push(b);
  return out;
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
  return coastGeometryOf(coastEdges(base, cols, rows, size), smooth);
}

/**
 * How a smoothed coast is roughened. `amplitude` is how far (in units of the
 * hex size) the coast along an edge may stray to either side of its smoothed
 * line; `noise(x, y, k)` is a stable value in [0, 1) for a position (given in
 * hex sizes, so it does not change as the map is zoomed) and a purpose k.
 */
export interface Roughness {
  amplitude: (edge: CoastEdge) => number;
  /**
   * A steady push (in hex sizes) of the line away from its inside, towards the
   * outside, round each corner it turns at: negative pulls it inward. Like the
   * roughening it dies away to nothing at every edge midpoint.
   */
  lean?: (edge: CoastEdge) => number;
  noise: (x: number, y: number, k: number) => number;
  size: number;
}

/** Samples along each quadratic piece of a roughened coast. */
const ROUGH_STEPS = 8;

/**
 * One piece of a smoothed coast - the quadratic through control corner `p`
 * from the midpoint before it to the midpoint after - with the roughening laid
 * on. The displacement is a few seeded harmonics that vanish at both ends, so
 * neighbouring pieces join without a step and the coast still passes through
 * the midpoint of every edge (where rivers and cities meet it).
 */
function roughPiece(a: Point, p: Point, b: Point, amplitude: number, lean: number, rough: Roughness): Point[] {
  const m0 = mid(a, p);
  const m1 = mid(p, b);
  const at = (t: number): Point => ({
    x: (1 - t) * (1 - t) * m0.x + 2 * (1 - t) * t * p.x + t * t * m1.x,
    y: (1 - t) * (1 - t) * m0.y + 2 * (1 - t) * t * p.y + t * t * m1.y,
  });
  const { size, noise } = rough;
  const nx = (k: number) => noise(p.x / size, p.y / size, k) * 2 - 1;
  // Harmonic weights fall off with frequency; amplitude is split across them.
  const weights = [nx(1), nx(2) * 0.6, nx(3) * 0.35, nx(4) * 0.18];
  const total = weights.reduce((sum, w) => sum + Math.abs(w), 0) || 1;
  const out: Point[] = [m0];
  for (let j = 1; j < ROUGH_STEPS; j++) {
    const t = j / ROUGH_STEPS;
    const here = at(t);
    // The normal to the curve; the displacement is symmetric, so which side it points to does not matter.
    const dx = 2 * (1 - t) * (p.x - m0.x) + 2 * t * (m1.x - p.x);
    const dy = 2 * (1 - t) * (p.y - m0.y) + 2 * t * (m1.y - p.y);
    const len = Math.hypot(dx, dy) || 1;
    let d = 0;
    for (let h = 0; h < weights.length; h++) d += weights[h]! * Math.sin(Math.PI * (h + 1) * t);
    d = (d / total) * amplitude * size * 1.6 - lean * size * Math.sin(Math.PI * t);
    out.push({ x: here.x - (dy / len) * d, y: here.y + (dx / len) * d });
  }
  out.push(m1);
  return out;
}

/**
 * The lobes between a roughened piece and the corner polyline it replaces:
 * those on the water's side of the polyline (land gained) and on the land's
 * side (land lost). The curve may cross the polyline, so each stretch on one
 * side becomes a polygon of its own.
 */
function roughLobes(a: Point, p: Point, b: Point, samples: Point[]): Array<{ d: PathCmd[]; towardWater: boolean; leg: 0 | 1 }> {
  const m0 = mid(a, p);
  const m1 = mid(p, b);
  const side = (q: Point): number => {
    const s1 = distanceToSegment(q, m0, p);
    const s2 = distanceToSegment(q, p, m1);
    const [from, to] = s1.dist <= s2.dist ? [m0, p] : [p, m1];
    const ex = to.x - from.x;
    const ey = to.y - from.y;
    const len = Math.hypot(ex, ey) || 1;
    // Positive: the right of travel, towards the land.
    return (ex * (q.y - from.y) - ey * (q.x - from.x)) / len;
  };
  const sides = samples.map((q, j) => (j === 0 || j === samples.length - 1 ? 0 : side(q)));
  const lobes: Array<{ d: PathCmd[]; towardWater: boolean; leg: 0 | 1 }> = [];
  const half = samples.length >> 1;
  const leg = (q: Point): 0 | 1 => (distanceToSegment(q, m0, p).dist <= distanceToSegment(q, p, m1).dist ? 0 : 1);
  const polygon = (ring: Point[]): PathCmd[] => [...ring.map((q, i) => [i === 0 ? 'M' : 'L', q.x, q.y] as PathCmd), ['Z'] as PathCmd];
  let j = 1;
  while (j < samples.length - 1) {
    if (Math.abs(sides[j]!) < 1e-6) { j++; continue; }
    const sign = Math.sign(sides[j]!);
    let k = j;
    while (k + 1 < samples.length - 1 && Math.sign(sides[k + 1]!) === sign) k++;
    // Where the curve crosses the polyline either side of the run.
    const cross = (u: number, v: number): Point => {
      const su = sides[u]!;
      const sv = sides[v]!;
      const f = su === sv ? 0 : su / (su - sv);
      return { x: samples[u]!.x + (samples[v]!.x - samples[u]!.x) * f, y: samples[u]!.y + (samples[v]!.y - samples[u]!.y) * f };
    };
    const before = cross(j - 1, j);
    const after = cross(k, k + 1);
    const towardWater = sign < 0;
    if (j <= half && k >= half) {
      // A lobe over the corner belongs to the two sides of it, cut where the
      // coast passes the corner, which is where a border between them ends.
      lobes.push({ d: polygon([before, ...samples.slice(j, half + 1), p]), towardWater, leg: 0 });
      lobes.push({ d: polygon([p, ...samples.slice(half, k + 1), after]), towardWater, leg: 1 });
    } else {
      // Closed along the corner, not across it, when its ends are on different legs.
      const ring: Point[] = [before, ...samples.slice(j, k + 1), after];
      if (leg(before) !== leg(after)) ring.push(p);
      lobes.push({ d: polygon(ring), towardWater, leg: (j + k) / 2 <= half ? 0 : 1 });
    }
    j = k + 1;
  }
  return lobes;
}

function distanceToSegment(q: Point, a: Point, b: Point): { dist: number } {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len2 = ex * ex + ey * ey || 1;
  const t = Math.max(0, Math.min(1, ((q.x - a.x) * ex + (q.y - a.y) * ey) / len2));
  return { dist: Math.hypot(q.x - (a.x + ex * t), q.y - (a.y + ey * t)) };
}

/** Area of a simple polygon, positive whichever way it winds. */
function polygonArea(points: Point[]): number {
  let sum = 0;
  for (let k = 0; k < points.length; k++) {
    const a = points[k]!;
    const b = points[(k + 1) % points.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * `polygon` cut to the side of the line through `from` and `to` that is to the
 * right of travel (a coast's land side), moved `depth` further right; with
 * `outer`, to the other side of that moved line instead.
 */
function clipToInset(polygon: Point[], from: Point, to: Point, depth: number, outer = false): Point[] {
  const ex = to.x - from.x;
  const ey = to.y - from.y;
  const len = Math.hypot(ex, ey) || 1;
  const nx = -ey / len;
  const ny = ex / len;
  const dist = (q: Point) => ((q.x - from.x) * nx + (q.y - from.y) * ny - depth) * (outer ? -1 : 1);
  const out: Point[] = [];
  polygon.forEach((a, k) => {
    const b = polygon[(k + 1) % polygon.length]!;
    const da = dist(a);
    const db = dist(b);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const f = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    }
  });
  return out;
}

/**
 * How far in from its water-facing edges a hex's coast must be drawn for
 * `land` (0 to 1) of the hex to be land. `corners` are the hex's, and `wet`
 * its edges against the sea (land on the right of travel). Every wet edge moves
 * in by the same depth; where two meet at a corner they cut it off together, so
 * the share is measured on the cut hex rather than guessed from the edge lengths.
 */
export function landInsetDepth(corners: Point[], wet: CoastEdge[], land: number): number {
  const full = polygonArea(corners);
  const share = Math.max(0, Math.min(1, land));
  if (wet.length === 0 || share >= 1) return 0;
  const landAt = (depth: number): number => {
    let shape = corners;
    for (const e of wet) {
      shape = clipToInset(shape, e.from, e.to, depth);
      if (shape.length < 3) return 0;
    }
    return polygonArea(shape) / full;
  };
  // No edge can go in further than the hex is wide.
  let low = 0;
  let high = Math.hypot(corners[0]!.x - corners[3]!.x, corners[0]!.y - corners[3]!.y);
  for (let k = 0; k < 24; k++) {
    const mid = (low + high) / 2;
    if (landAt(mid) > share) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** How a hex that is only partly land is drawn: how far in each of its coast edges moves, and the hex's own outline. */
export interface CoastInset {
  depth: (edge: CoastEdge) => number;
  hex: (edge: CoastEdge) => Point[];
}

const turn = (u: Point, degrees: number): Point => {
  const a = (degrees * Math.PI) / 180;
  return { x: u.x * Math.cos(a) - u.y * Math.sin(a), y: u.x * Math.sin(a) + u.y * Math.cos(a) };
};

/**
 * A chain with each edge moved in towards its land by `inset.depth(edge)`.
 * Where two edges of one hex meet, their moved lines meet at a corner. Where an
 * inset edge meets another hex's coast, the moved line instead runs out to the
 * border the two land hexes share, and the coast steps along that border to
 * where the other hex's own coast (moved or not) begins, so the land left is
 * exactly the hex cut by its moved edges. The water each moved edge leaves in
 * its hex is returned as a strip, for the donor of the water across.
 */
function insetChain(chain: CoastChain, inset: CoastInset, strips: Sliver[], taken: Map<number, Array<{ edge: CoastEdge; depth: number }>>): CoastChain {
  const { points, edges, closed } = chain;
  const depth = edges.map(inset.depth);
  if (depth.every((d) => d <= 0)) return chain;
  const n = edges.length;
  const dir = edges.map((e) => {
    const len = Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y) || 1;
    return { x: (e.to.x - e.from.x) / len, y: (e.to.y - e.from.y) / len, len };
  });
  /** How far along a hex border from a corner a line moved in by `d` meets it: d over the sine of the angle between them. */
  const reach = (d: number, k: number) => (d > 0 ? Math.min(dir[k]!.len, d / Math.sin(Math.PI / 3)) : 0);
  const at = (p: Point, w: Point, t: number): Point => ({ x: p.x + w.x * t, y: p.y + w.y * t });

  const outPoints: Point[] = [];
  const outEdges: CoastEdge[] = [];
  const vertices = points.length;
  // Per vertex: the point or points that replace it, and the connecting edge between two.
  const made = points.map((p, k) => {
    const a = closed ? (k - 1 + n) % n : k - 1;
    const b = closed ? k % n : k;
    const hasA = a >= 0 && a < n;
    const hasB = b >= 0 && b < n;
    if (!hasA && !hasB) return { pts: [p], link: undefined as CoastEdge | undefined };
    if (!hasA) return { pts: [at(p, turn(dir[b]!, 120), reach(depth[b]!, b))], link: undefined };
    if (!hasB) return { pts: [at(p, turn(dir[a]!, 60), reach(depth[a]!, a))], link: undefined };
    const ea = edges[a]!;
    const eb = edges[b]!;
    const da = depth[a]!;
    const db = depth[b]!;
    if (da <= 0 && db <= 0) return { pts: [p], link: undefined };
    if (ea.hex === eb.hex) {
      // Two edges of one hex: the corner where their moved lines meet.
      const n1 = { x: -dir[a]!.y, y: dir[a]!.x };
      const n2 = { x: -dir[b]!.y, y: dir[b]!.x };
      const det = n1.x * n2.y - n1.y * n2.x;
      if (Math.abs(det) < 1e-3) return { pts: [at(p, n1, da)], link: undefined };
      const vx = (da * n2.y - db * n1.y) / det;
      const vy = (n1.x * db - n2.x * da) / det;
      return { pts: [{ x: p.x + vx, y: p.y + vy }], link: undefined };
    }
    // Two land hexes against the same water: the border between them leaves the corner at 60 degrees to the way in.
    const w = turn(dir[a]!, 60);
    const ta = reach(da, a);
    const tb = reach(db, b);
    const qa = at(p, w, ta);
    if (Math.abs(ta - tb) < 1e-6) return { pts: [qa], link: undefined };
    const qb = at(p, w, tb);
    // Along the border outwards the first hex's land is on the right; back towards the corner, the second's.
    const forward = ta < tb;
    return {
      pts: [qa, qb],
      link: {
        from: qa,
        to: qb,
        land: forward ? ea.land : eb.land,
        water: forward ? eb.water : ea.water,
        hex: forward ? ea.hex : eb.hex,
        across: forward ? eb.hex : ea.hex,
      } as CoastEdge,
    };
  });
  const start = new Array<number>(vertices);
  made.forEach((m, k) => {
    start[k] = outPoints.length;
    outPoints.push(...m.pts);
  });
  const last = (k: number) => outPoints[start[k]! + made[k]!.pts.length - 1]!;
  for (let k = 0; k < vertices; k++) {
    const m = made[k]!;
    if (m.link) outEdges.push(m.link);
    if (k < n) {
      const e = edges[k]!;
      const nextVertex = (k + 1) % vertices;
      outEdges.push({ ...e, from: last(k), to: outPoints[start[nextVertex]!]! });
    }
  }
  edges.forEach((e, k) => {
    if (depth[k]! <= 0) return;
    // Where two of a hex's moved edges meet, their strips would cover the corner
    // twice, and the water would then cancel out wherever strips are laid
    // together as one even-odd shape: each strip keeps only what the hex's
    // earlier strips have not taken.
    const before = e.hex === undefined ? [] : taken.get(e.hex) ?? [];
    let piece = inset.hex(e);
    for (const earlier of before) piece = clipToInset(piece, earlier.edge.from, earlier.edge.to, earlier.depth);
    piece = clipToInset(piece, e.from, e.to, depth[k]!, true);
    if (e.hex !== undefined) taken.set(e.hex, [...before, { edge: e, depth: depth[k]! }]);
    if (piece.length < 3) return;
    strips.push({ d: [...piece.map((q, i) => [i === 0 ? 'M' : 'L', q.x, q.y] as PathCmd), ['Z'] as PathCmd], donor: e.water });
  });
  return { points: outPoints, edges: outEdges, closed };
}

/**
 * The coast along `edges` (from `surfaceEdges`), traced into chains and optionally smoothed and roughened.
 * With `inset`, the edges of a hex that is only partly land are drawn that far in from the hex's own edge.
 */
export function coastGeometryOf(
  edges: CoastEdge[],
  smooth: boolean,
  rough?: Roughness,
  inset?: CoastInset,
): CoastGeometry {
  const strips: Sliver[] = [];
  const taken = new Map<number, Array<{ edge: CoastEdge; depth: number }>>();
  const chains = chainEdges(edges).map((chain) => (inset ? insetChain(chain, inset, strips, taken) : chain));
  const toWater: Sliver[] = [...strips];
  const toLand: Sliver[] = [];
  const anchors = new Map<string, Point>();
  const paths = chains.map((chain) => {
    if (!smooth || chain.points.length < 3) return hexPath(chain);
    const { points, edges, closed } = chain;
    const n = points.length;
    // Per corner: the plain curve (and its slivers), or the roughened one.
    const piece: Array<Point[] | null> = points.map(() => null);
    for (let k = closed ? 0 : 1; k < (closed ? n : n - 1); k++) {
      const incoming = edges[(k - 1 + edges.length) % edges.length]!;
      const outgoing = edges[k % edges.length]!;
      const a = points[(k - 1 + n) % n]!;
      const p = points[k]!;
      const b = points[(k + 1) % n]!;
      const amplitude = rough ? Math.max(rough.amplitude(incoming), rough.amplitude(outgoing)) : 0;
      // The curve's middle is the stretch of the coast nearest the corner.
      const m0 = mid(a, p);
      const m1 = mid(p, b);
      anchors.set(key(p), { x: (m0.x + 2 * p.x + m1.x) / 4, y: (m0.y + 2 * p.y + m1.y) / 4 });
      const lean = rough?.lean ? (rough.lean(incoming) + rough.lean(outgoing)) / 2 : 0;
      if (rough && (amplitude > 0 || lean !== 0)) {
        const samples = roughPiece(a, p, b, amplitude, lean, rough);
        piece[k] = samples;
        anchors.set(key(p), samples[ROUGH_STEPS >> 1]!);
        for (const lobe of roughLobes(a, p, b, samples)) {
          const edge = lobe.leg === 0 ? incoming : outgoing;
          if (lobe.towardWater) toLand.push({ d: lobe.d, donor: edge.land });
          else toWater.push({ d: lobe.d, donor: edge.water });
        }
        continue;
      }
      const d = sliverPath(a, p, b);
      // With land on the right, a right turn rounds a corner of land that
      // sticks out into the water, and a left turn fills a notch of water.
      // Straight on (pieces of a split hex meeting in line) needs neither.
      const turn = (p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x);
      const scale = Math.hypot(p.x - a.x, p.y - a.y) * Math.hypot(b.x - p.x, b.y - p.y) || 1;
      if (Math.abs(turn) / scale < 1e-6) continue;
      if (turn > 0) toWater.push({ d, donor: incoming.water });
      else toLand.push({ d, donor: incoming.land });
    }
    return piece.some(Boolean) ? roughPath(points, closed, piece) : smoothPath(points, closed);
  });
  return { chains, strips, paths, toWater, toLand, anchors };
}

/** A smoothed chain in which some corners carry a sampled, roughened curve. */
function roughPath(points: Point[], closed: boolean, piece: Array<Point[] | null>): PathCmd[] {
  const n = points.length;
  const first = closed ? mid(points[n - 1]!, points[0]!) : points[0]!;
  const d: PathCmd[] = [['M', first.x, first.y]];
  if (!closed) {
    const m0 = mid(points[0]!, points[1]!);
    d.push(['L', m0.x, m0.y]);
  }
  for (let k = closed ? 0 : 1; k < (closed ? n : n - 1); k++) {
    const samples = piece[k];
    if (samples) {
      for (let j = 1; j < samples.length; j++) d.push(['L', samples[j]!.x, samples[j]!.y]);
    } else {
      const p = points[k]!;
      const m = mid(p, points[(k + 1) % n]!);
      d.push(['Q', p.x, p.y, m.x, m.y]);
    }
  }
  if (closed) d.push(['Z']);
  else {
    const last = points[n - 1]!;
    d.push(['L', last.x, last.y]);
  }
  return d;
}

/**
 * The land as the coast is drawn, as one shape to fill even-odd: each coast chain
 * closed up. A chain that runs off the map is closed round the edge of the
 * (`margin`-enlarged) page the way its land lies, to the right of travel, so
 * the page's edge is clockwise from where it leaves to where it returns.
 */
export function drawnLand(geometry: CoastGeometry, width: number, height: number, margin: number): PathCmd[] {
  const x0 = -margin;
  const y0 = -margin;
  const x1 = width + margin;
  const y1 = height + margin;
  const w = x1 - x0;
  const h = y1 - y0;
  const perimeter = 2 * (w + h);
  const nearest = (p: Point): { at: Point; t: number } => {
    const gaps = [p.y - y0, x1 - p.x, y1 - p.y, p.x - x0];
    const side = gaps.indexOf(Math.min(...gaps));
    const x = Math.max(x0, Math.min(x1, p.x));
    const y = Math.max(y0, Math.min(y1, p.y));
    if (side === 0) return { at: { x, y: y0 }, t: x - x0 };
    if (side === 1) return { at: { x: x1, y }, t: w + (y - y0) };
    if (side === 2) return { at: { x, y: y1 }, t: w + h + (x1 - x) };
    return { at: { x: x0, y }, t: 2 * w + h + (y1 - y) };
  };
  const corners = [{ x: x1, y: y0, t: w }, { x: x1, y: y1, t: w + h }, { x: x0, y: y1, t: 2 * w + h }, { x: x0, y: y0, t: perimeter }];
  const out: PathCmd[] = [];
  geometry.chains.forEach((chain, c) => {
    const path = geometry.paths[c];
    if (!path || path.length === 0) return;
    out.push(...path);
    if (chain.closed) return;
    const first = path[0]!;
    const last = path[path.length - 1]!;
    const from = nearest({ x: last.at(-2) as number, y: last.at(-1) as number });
    const to = nearest({ x: first[1] as number, y: first[2] as number });
    out.push(['L', from.at.x, from.at.y]);
    const reach = (to.t - from.t + perimeter) % perimeter;
    for (const corner of corners) {
      if ((corner.t - from.t + perimeter) % perimeter < reach && corner.t !== from.t) out.push(['L', corner.x, corner.y]);
    }
    out.push(['L', to.at.x, to.at.y], ['Z']);
  });
  return out;
}

/**
 * `d` with every closed outline wound the same way round. A clip made of several
 * outlines keeps their union only if they wind alike: where two wind opposite
 * ways, whatever they share cancels out and drops from the clip.
 */
export function alike(d: PathCmd[]): PathCmd[] {
  const outlines: PathCmd[][] = [];
  for (const c of d) {
    if (c[0] === 'M') outlines.push([c]);
    else outlines[outlines.length - 1]?.push(c);
  }
  return outlines.flatMap((outline) => {
    const points: Point[] = [];
    let at: Point = { x: 0, y: 0 };
    for (const c of outline) {
      if (c[0] === 'Z') continue;
      if (c[0] === 'Q') {
        for (let t = 1; t <= 4; t++) {
          const u = t / 4;
          points.push({ x: (1 - u) * (1 - u) * at.x + 2 * (1 - u) * u * c[1] + u * u * c[3], y: (1 - u) * (1 - u) * at.y + 2 * (1 - u) * u * c[2] + u * u * c[4] });
        }
      } else points.push({ x: c.at(-2) as number, y: c.at(-1) as number });
      at = points[points.length - 1]!;
    }
    let area = 0;
    points.forEach((a, k) => {
      const b = points[(k + 1) % points.length]!;
      area += a.x * b.y - b.x * a.y;
    });
    if (area >= 0) return outline;
    // Walk the outline backwards: each segment ends where the one before it ended.
    const stops: Point[] = [];
    const segments = outline.filter((c) => c[0] !== 'Z');
    for (const c of segments) stops.push({ x: c.at(-2) as number, y: c.at(-1) as number });
    const reversed: PathCmd[] = [['M', stops[stops.length - 1]!.x, stops[stops.length - 1]!.y]];
    for (let k = segments.length - 1; k >= 1; k--) {
      const c = segments[k]!;
      const to = stops[k - 1]!;
      reversed.push(c[0] === 'Q' ? ['Q', c[1], c[2], to.x, to.y] : ['L', to.x, to.y]);
    }
    if (outline.some((c) => c[0] === 'Z')) reversed.push(['Z']);
    return reversed;
  });
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

/**
 * The drawn body of a lake: its hex outline, smoothed well beyond the coast's
 * eighth-of-a-hex bound, then pushed out into the surrounding land by a
 * seeded amount that varies slowly round the shore. A lake therefore reaches
 * a little into its neighbouring hexes and never reads as a stamped hexagon
 * or a row of circles. Holes (land inside the lake) come out as inner loops
 * wound the other way, so a nonzero fill leaves them as land.
 */
export function lakeBodyPath(
  edges: CoastEdge[],
  size: number,
  rand: (k: number) => number,
  /**
   * How much of the usual outward reach is allowed at a point on the shore
   * (1 = all of it). The caller uses it to keep a narrow strip of land between
   * two arms of water from being swallowed.
   */
  reach: (p: Point) => number = () => 1,
  /**
   * How irregular the shore is at a point, as the coast's amplitude (in hex sizes; 0 leaves it
   * smooth), with `noise` a stable value in [0, 1) for a position in hex sizes and a purpose k.
   */
  rough?: { amplitude: (p: Point) => number; noise: (x: number, y: number, k: number) => number },
): PathCmd[] {
  const d: PathCmd[] = [];
  chainEdges(edges).forEach((chain, c) => {
    const corners = chain.points;
    const n = corners.length;
    if (n < 3) return;
    // Sample the quadratic B-spline through the edge midpoints.
    let pts: Point[] = [];
    for (let k = 0; k < n; k++) {
      const a = mid(corners[(k - 1 + n) % n]!, corners[k]!);
      const ctrl = corners[k]!;
      const b = mid(corners[k]!, corners[(k + 1) % n]!);
      for (let s = 0; s < 6; s++) {
        const t = s / 6;
        pts.push({
          x: (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * ctrl.x + t * t * b.x,
          y: (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * ctrl.y + t * t * b.y,
        });
      }
    }
    const smooth = (list: Point[], passes: number): Point[] => {
      let out = list;
      for (let p = 0; p < passes; p++) {
        out = out.map((q, i) => {
          const prev = out[(i - 1 + out.length) % out.length]!;
          const next = out[(i + 1) % out.length]!;
          return { x: 0.25 * prev.x + 0.5 * q.x + 0.25 * next.x, y: 0.25 * prev.y + 0.5 * q.y + 0.25 * next.y };
        });
      }
      return out;
    };
    pts = smooth(pts, 6);
    // How far each point moves out: a few slow seeded swells round the shore,
    // so even a one-hex lake has bays and points, and a long shore varies
    // every few hexes rather than at every sample.
    const perimeter = pts.reduce((sum, q, i) => sum + Math.hypot(q.x - pts[(i + 1) % pts.length]!.x, q.y - pts[(i + 1) % pts.length]!.y), 0);
    const waves = [1, 2, 3].map((h) => ({ h, phase: rand(c * 1000 + 10 + h) * Math.PI * 2, amp: [0.07, 0.05, 0.035][h - 1]! }));
    const local = Math.max(1, Math.round(perimeter / (size * 3)));
    const localPhase = rand(c * 1000 + 20) * Math.PI * 2;
    const push = pts.map((_, i) => {
      const f = (i / pts.length) * Math.PI * 2;
      return 0.17
        + waves.reduce((sum, w) => sum + w.amp * Math.cos(w.h * f + w.phase), 0)
        + 0.04 * Math.cos(local * f + localPhase);
    });
    const normals = pts.map((_, i) => {
      const prev = pts[(i - 1 + pts.length) % pts.length]!;
      const next = pts[(i + 1) % pts.length]!;
      const dx = next.x - prev.x;
      const dy = next.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      // The lake lies to the right of the direction of travel; land to the left.
      return { x: dy / len, y: -dx / len };
    });
    // The allowed reach, judged where the shore would land, then eased round
    // the shore so a held-back stretch narrows smoothly rather than in a step.
    const allowed = pts.map((q, i) => reach({ x: q.x + normals[i]!.x * 0.2 * size, y: q.y + normals[i]!.y * 0.2 * size }));
    const span = 5;
    const eased = allowed.map((_, i) => {
      let lowest = 1;
      let sum = 0;
      for (let k = -span; k <= span; k++) {
        const v = allowed[(i + k + allowed.length) % allowed.length]!;
        lowest = Math.min(lowest, v);
        sum += v;
      }
      return (lowest + sum / (2 * span + 1)) / 2;
    });
    const out = smooth(
      pts.map((q, i) => {
        const r = push[i]! * eased[i]! * size;
        return { x: q.x + normals[i]!.x * r, y: q.y + normals[i]!.y * r };
      }),
      2,
    );
    // Irregularity: seeded ripples round the shore, laid on after the smoothing so they survive
    // it. Scaled by the amplitude beside each stretch (eased so it changes gradually between
    // hexes) and held back where the reach is, so a narrow strip of land is not cut through.
    if (rough) {
      const amps = pts.map((q, i) => rough.amplitude({ x: q.x + normals[i]!.x * 0.2 * size, y: q.y + normals[i]!.y * 0.2 * size }));
      if (amps.some((a) => a > 0)) {
        const smoothed = amps.map((_, i) => {
          let sum = 0;
          for (let k = -span; k <= span; k++) sum += amps[(i + k + amps.length) % amps.length]!;
          return sum / (2 * span + 1);
        });
        const bands = [2.2, 1.2, 0.7].map((wavelength, h) => ({
          cycles: Math.max(1, Math.round(perimeter / (wavelength * size))),
          phase: rand(c * 1000 + 30 + h) * Math.PI * 2,
          weight: [1, 0.7, 0.45][h]!,
        }));
        const norm = Math.sqrt(bands.reduce((sum, b) => sum + b.weight * b.weight, 0));
        out.forEach((q, i) => {
          const f = (i / pts.length) * Math.PI * 2;
          const shape = bands.reduce((sum, b) => sum + b.weight * Math.cos(b.cycles * f + b.phase), 0) / norm;
          const r = shape * smoothed[i]! * 2 * eased[i]! * size;
          out[i] = { x: q.x + normals[i]!.x * r, y: q.y + normals[i]!.y * r };
        });
      }
    }
    out.forEach((q, i) => d.push([i === 0 ? 'M' : 'L', q.x, q.y]));
    d.push(['Z']);
  });
  return d;
}

/**
 * Every lake, as connected groups of hexes. An island hex whose water
 * neighbours are all lake belongs to its lake: it is drawn on lake water,
 * not sea.
 */
export function lakeIslandsOf(
  base: ReadonlyArray<BaseGeo | null>,
  cols: number,
  rows: number,
): Set<number> {
  const lakeIslands = new Set<number>();
  for (let i = 0; i < base.length; i++) {
    if (base[i] !== 'Islands') continue;
    let lake = 0;
    let other = 0;
    for (let e = 0; e < 6; e++) {
      const n = neighbourOf(i % cols, Math.floor(i / cols), e);
      if (!inBounds(cols, rows, n.col, n.row)) continue;
      const v = base[hexIndex(cols, n.col, n.row)];
      if (v === 'Lake') lake++;
      else if (v === 'Sea' || (isIslandType(v) && v !== undefined)) other++;
    }
    if (lake > 0 && other === 0) lakeIslands.add(i);
  }
  return lakeIslands;
}

/**
 * Every lake, as connected groups of the hexes holding its water: lake hexes,
 * island hexes in it (see `lakeIslandsOf`), and split hexes with lake water.
 */
export function lakeComponents(
  base: ReadonlyArray<BaseGeo | null>,
  cols: number,
  rows: number,
  surface: SurfaceMap = surfaceMap(base, cols, rows, lakeIslandsOf(base, cols, rows)),
): { lakes: number[][]; lakeIslands: Set<number> } {
  const lakeIslands = lakeIslandsOf(base, cols, rows);
  const member = (i: number) =>
    surface.whole[i] === 'lake' || Boolean(surface.split.get(i)?.sides.includes('lake'));
  const seen = new Uint8Array(base.length);
  const lakes: number[][] = [];
  for (let i = 0; i < base.length; i++) {
    if (seen[i] || !member(i)) continue;
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
        if (!seen[j] && member(j)) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    lakes.push(component.sort((a, b) => a - b));
  }
  return { lakes, lakeIslands };
}
