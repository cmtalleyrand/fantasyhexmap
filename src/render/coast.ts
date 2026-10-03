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

export type Side = 'land' | 'water';

/**
 * Which side of the coast a hex is on, taken whole. Islands hexes are sea
 * with land drawn on top; a strait is water and an isthmus or a mainland
 * coast with islands is land (their split into land and water is in
 * `surfaceMap`).
 */
export function sideOf(value: BaseGeo | null | undefined): Side | null {
  if (!value) return null;
  return value === 'Sea' || value === 'Lake' || value === 'Islands' || value === 'Strait' ? 'water' : 'land';
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
      edges.push({ from, to, land: pieceDonor(map, i, p), water: pieceDonor(map, other[0], other[1]) });
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

/** Every land/water boundary of the map, as `surfaceEdges` gives it, with lakes counted as water. */
export function coastEdges(base: ReadonlyArray<BaseGeo | null>, cols: number, rows: number, size: number): CoastEdge[] {
  return surfaceEdges(surfaceMap(base, cols, rows), size, (s) => s === 'land');
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

/** The coast along `edges` (from `surfaceEdges`), traced into chains and optionally smoothed. */
export function coastGeometryOf(edges: CoastEdge[], smooth: boolean): CoastGeometry {
  const chains = chainEdges(edges);
  const toWater: Sliver[] = [];
  const toLand: Sliver[] = [];
  const paths = chains.map((chain) => {
    if (!smooth || chain.points.length < 3) return hexPath(chain);
    const { points, edges, closed } = chain;
    const n = points.length;
    for (let k = closed ? 0 : 1; k < (closed ? n : n - 1); k++) {
      const incoming = edges[(k - 1 + edges.length) % edges.length]!;
      const a = points[(k - 1 + n) % n]!;
      const p = points[k]!;
      const b = points[(k + 1) % n]!;
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
    const out = pts.map((q, i) => {
      const r = push[i]! * eased[i]! * size;
      return { x: q.x + normals[i]!.x * r, y: q.y + normals[i]!.y * r };
    });
    smooth(out, 2).forEach((q, i) => d.push([i === 0 ? 'M' : 'L', q.x, q.y]));
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
