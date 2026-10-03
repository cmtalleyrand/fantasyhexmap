/**
 * Ice.
 *
 * Sea ice is drawn as one body of pack ice laid over the water, not as pale
 * hexes: its outline is traced round the whole frozen area, smoothed and
 * roughened (so it no longer follows the hex grid), edged with a frosted rim,
 * cracked into plates, and broken at the margin into floes drifting off into
 * open water. Glaciers keep their hex fill but get a sloping, brighter shelf
 * along the coast and calve small bergs into the sea. How broken the outline
 * is comes from each hex's irregularity.
 *
 * Everything here is pure geometry returning primitives; scene.ts decides
 * where it goes in the drawing order and what water it is clipped to.
 */

import { hexCenter, neighbourOf, pixelToOffset, inBounds, hexIndex, type Point } from '../../shared/hex.js';
import type { Elevation, Irregularity } from '../../shared/types.js';
import { coastGeometryOf, surfaceEdges, type CoastEdge, type CoastGeometry, type Roughness, type Surface, type SurfaceMap } from './coast.js';
import type { PathCmd, Prim } from './prims.js';
import { signed, unit } from './seed.js';

/** How far (in hex sizes) an ice edge strays from its smoothed line, by irregularity. */
export const ICE_AMPLITUDE: Record<Irregularity, number> = { Smooth: 0, Wavy: 0.1, Ragged: 0.18, Fractured: 0.28 };

/** The chance, per half hex of margin, that a floe has broken off there. */
const FRINGE_CHANCE: Record<Irregularity, number> = { Smooth: 0, Wavy: 0.28, Ragged: 0.55, Fractured: 0.85 };
const LEVEL: Record<Irregularity, number> = { Smooth: 0, Wavy: 1, Ragged: 2, Fractured: 3 };

export interface IceColours {
  /** The pack ice itself. */
  body: string;
  /** Plates and floes: paler than the body. */
  floe: string;
  /** The frosted band along the pack's edge. */
  rim: string;
  /** Cracks and the thin line round floes and the pack. */
  crack: string;
}

/** Blend two #rrggbb colours; `t` = 0 gives `a`. */
function mixHex(a: string, b: string, t: number): string {
  const pa = /^#([0-9a-f]{6})$/i.exec(a);
  const pb = /^#([0-9a-f]{6})$/i.exec(b);
  if (!pa || !pb) return t < 0.5 ? a : b;
  const na = parseInt(pa[1]!, 16);
  const nb = parseInt(pb[1]!, 16);
  const channel = (shift: number) => Math.round(((na >> shift) & 255) * (1 - t) + ((nb >> shift) & 255) * t);
  return `#${[16, 8, 0].map((s) => channel(s).toString(16).padStart(2, '0')).join('')}`;
}

/* ------------------------------------------------------------ polylines */

/** A path as polylines, one per subpath, with curves sampled. */
export function pathPolylines(d: PathCmd[], steps = 5): Point[][] {
  const out: Point[][] = [];
  let at: Point = { x: 0, y: 0 };
  let start: Point = at;
  for (const c of d) {
    if (c[0] === 'M') {
      at = { x: c[1], y: c[2] };
      start = at;
      out.push([at]);
    } else if (c[0] === 'L') {
      at = { x: c[1], y: c[2] };
      out[out.length - 1]?.push(at);
    } else if (c[0] === 'Q') {
      const run = out[out.length - 1];
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        run?.push({
          x: (1 - t) * (1 - t) * at.x + 2 * (1 - t) * t * c[1] + t * t * c[3],
          y: (1 - t) * (1 - t) * at.y + 2 * (1 - t) * t * c[2] + t * t * c[4],
        });
      }
      at = { x: c[3], y: c[4] };
    } else if (c[0] === 'C') {
      const run = out[out.length - 1];
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const u = 1 - t;
        run?.push({
          x: u * u * u * at.x + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * c[5],
          y: u * u * u * at.y + 3 * u * u * t * c[2] + 3 * u * t * t * c[4] + t * t * t * c[6],
        });
      }
      at = { x: c[5], y: c[6] };
    } else if (c[0] === 'Z') {
      out[out.length - 1]?.push(start);
      at = start;
    }
  }
  return out.filter((run) => run.length > 1);
}

/** Points every `step` along a polyline, each with the unit normal on the left of travel (the water's side). */
export function alongPolyline(poly: Point[], step: number): Array<{ p: Point; n: Point }> {
  const out: Array<{ p: Point; n: Point }> = [];
  let carried = step / 2;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const dx = (b.x - a.x) / len;
    const dy = (b.y - a.y) / len;
    let at = carried;
    for (; at <= len; at += step) {
      out.push({ p: { x: a.x + dx * at, y: a.y + dy * at }, n: { x: dy, y: -dx } });
    }
    carried = at - len;
  }
  return out;
}

/* ------------------------------------------------------------ the pack's outline */

export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The outline of every frozen area as closed paths. Edges that run off the map
 * are closed round the rim of `bounds`, so ice meeting the map edge fills right
 * out to it.
 */
function closedOutlines(edges: CoastEdge[], rough: Roughness | undefined, bounds: Bounds, reachesRim: boolean): PathCmd[] {
  const geometry = coastGeometryOf(edges, rough !== undefined, rough);
  const w = bounds.x1 - bounds.x0;
  const h = bounds.y1 - bounds.y0;
  /** Distance clockwise (on screen) round the rectangle from its top-left corner. */
  const perimeter = (p: Point): number => {
    const left = Math.abs(p.x - bounds.x0);
    const right = Math.abs(p.x - bounds.x1);
    const top = Math.abs(p.y - bounds.y0);
    const bottom = Math.abs(p.y - bounds.y1);
    const nearest = Math.min(left, right, top, bottom);
    if (nearest === top) return p.x - bounds.x0;
    if (nearest === right) return w + (p.y - bounds.y0);
    if (nearest === bottom) return w + h + (bounds.x1 - p.x);
    return 2 * w + h + (bounds.y1 - p.y);
  };
  const onRim = (t: number): Point => {
    const total = 2 * (w + h);
    const u = ((t % total) + total) % total;
    if (u <= w) return { x: bounds.x0 + u, y: bounds.y0 };
    if (u <= w + h) return { x: bounds.x1, y: bounds.y0 + (u - w) };
    if (u <= 2 * w + h) return { x: bounds.x1 - (u - w - h), y: bounds.y1 };
    return { x: bounds.x0, y: bounds.y1 - (u - 2 * w - h) };
  };
  const out: PathCmd[] = [];
  // Ice that meets the map edge all the way round has no edge running off the map to
  // close, and so no outline but the rim itself (any open water in it is a loop of its own).
  if (reachesRim && geometry.chains.every((chain) => chain.closed)) {
    out.push(['M', bounds.x0, bounds.y0], ['L', bounds.x1, bounds.y0], ['L', bounds.x1, bounds.y1], ['L', bounds.x0, bounds.y1], ['Z']);
  }
  geometry.chains.forEach((chain, c) => {
    const path = geometry.paths[c]!;
    if (chain.closed) {
      out.push(...path);
      return;
    }
    // Open: run out to the rim at both ends and round it, clockwise, from the end to the start.
    const first = chain.points[0]!;
    const last = chain.points[chain.points.length - 1]!;
    const tStart = perimeter(first);
    const tEnd = perimeter(last);
    const total = 2 * (w + h);
    const corners = [0, w, w + h, 2 * w + h];
    const span = ((tStart - tEnd) % total + total) % total;
    const between = corners
      .map((k) => ({ k, d: (((k - tEnd) % total) + total) % total }))
      .filter((q) => q.d > 0 && q.d < span)
      .sort((a, b) => a.d - b.d)
      .map((q) => onRim(q.k));
    const [m, ...rest] = path;
    if (!m) return;
    out.push(m, ...rest, ['L', onRim(tEnd).x, onRim(tEnd).y]);
    for (const p of between) out.push(['L', p.x, p.y]);
    out.push(['L', onRim(tStart).x, onRim(tStart).y], ['Z']);
  });
  return out;
}

/* ------------------------------------------------------------ floes */

/** One floe: a slab of ice with a handful of seeded corners, flatter than it is long. */
function floe(c: Point, radius: number, seed: string, key: Array<string | number>, fill: string, edge: string, line: number): Prim {
  const sides = 5 + Math.floor(unit(seed, 'floe', ...key, 'v') * 3);
  const turn = signed(seed, 'floe', ...key, 't') * Math.PI;
  const points: Point[] = [];
  for (let v = 0; v < sides; v++) {
    const a = turn + (v / sides) * Math.PI * 2;
    const r = radius * (0.7 + 0.3 * unit(seed, 'floe', ...key, 'p', v));
    points.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r * 0.78 });
  }
  return { kind: 'polygon', points, fill, stroke: edge, strokeWidth: line };
}

/**
 * Floes drifting off an ice edge: along each polyline, every half hex, a
 * floe may have broken away, further out and larger the more irregular the edge.
 * `levelAt` is the irregularity of the ice there, or null where this stretch of
 * line is not ice (a coast, or a bare shore).
 */
export function floeFringe(
  lines: Point[][],
  size: number,
  seed: string,
  levelAt: (p: Point) => Irregularity | null,
  colours: Pick<IceColours, 'floe' | 'crack'>,
): Prim[] {
  const prims: Prim[] = [];
  const line = Math.max(0.5, size * 0.025);
  for (const poly of lines) {
    for (const { p, n } of alongPolyline(poly, size * 0.5)) {
      const level = levelAt(p);
      if (!level) continue;
      // Stable under zoom and under edits elsewhere: keyed by position in hex sizes.
      const key = [Math.round((p.x / size) * 50), Math.round((p.y / size) * 50)];
      if (unit(seed, 'fringe', ...key, 'c') >= FRINGE_CHANCE[level]) continue;
      const out = size * (0.04 + 0.3 * unit(seed, 'fringe', ...key, 'o')) * (0.8 + 0.25 * LEVEL[level]);
      const radius = size * (0.045 + 0.1 * unit(seed, 'fringe', ...key, 'r')) * (1.15 - out / (size * 2));
      prims.push(floe({ x: p.x + n.x * out, y: p.y + n.y * out }, radius, seed, key, colours.floe, colours.crack, line));
    }
  }
  return prims;
}

/* ------------------------------------------------------------ plates */

/** `polygon` cut to the side of the bisector between `s` and `q` that is nearer `s` (Voronoi, one neighbour at a time). */
function nearerTo(polygon: Point[], s: Point, q: Point): Point[] {
  const nx = q.x - s.x;
  const ny = q.y - s.y;
  const c = (q.x * q.x + q.y * q.y - s.x * s.x - s.y * s.y) / 2;
  const dist = (p: Point) => c - (nx * p.x + ny * p.y);
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

interface PlateInput {
  size: number;
  seed: string;
  /** Centres of the hexes the plates must cover. */
  centres: Point[];
  body: string;
  light: string;
  crack: string;
  textured: boolean;
  /** Whether a point is where the pack meets open water, and so is broken up. */
  atMargin: (p: Point) => boolean;
}

/**
 * The surface of a pack as plates: a jittered scatter of points whose Voronoi
 * cells are the slabs, each a slightly different tint, the leads between them
 * drawn as cracks. Cells keyed by their place on a fixed grid, in hex sizes,
 * so the plates do not shift when the map is edited elsewhere or zoomed.
 * Where the pack meets open water the plates pull apart: smaller, with wider leads.
 */
function icePlates(input: PlateInput): Prim[] {
  const { size, seed, centres, body, light, crack, textured, atMargin } = input;
  const spacing = size * (textured ? 1.15 : 1.8);
  const seedAt = (gx: number, gy: number): Point => ({
    x: (gx + 0.12 + 0.76 * unit(seed, 'plate', gx, gy, 'x')) * spacing,
    y: (gy + 0.12 + 0.76 * unit(seed, 'plate', gx, gy, 'y')) * spacing,
  });
  const wanted = new Map<string, [number, number]>();
  for (const c of centres) {
    const reach = size * 1.5;
    for (let gx = Math.floor((c.x - reach) / spacing); gx <= Math.floor((c.x + reach) / spacing); gx++) {
      for (let gy = Math.floor((c.y - reach) / spacing); gy <= Math.floor((c.y + reach) / spacing); gy++) {
        const at = seedAt(gx, gy);
        if (Math.hypot(at.x - c.x, at.y - c.y) <= size * 1.5) wanted.set(`${gx},${gy}`, [gx, gy]);
      }
    }
  }
  const line = Math.max(0.5, size * 0.022);
  const prims: Prim[] = [];
  for (const [gx, gy] of wanted.values()) {
    const s = seedAt(gx, gy);
    const half = spacing * 1.7;
    let cell: Point[] = [
      { x: s.x - half, y: s.y - half },
      { x: s.x + half, y: s.y - half },
      { x: s.x + half, y: s.y + half },
      { x: s.x - half, y: s.y + half },
    ];
    for (let dx = -2; dx <= 2 && cell.length > 2; dx++) {
      for (let dy = -2; dy <= 2 && cell.length > 2; dy++) {
        if (dx === 0 && dy === 0) continue;
        cell = nearerTo(cell, s, seedAt(gx + dx, gy + dy));
      }
    }
    if (cell.length < 3) continue;
    const margin = textured && atMargin(s);
    const shrink = margin ? 0.86 : 0.975;
    const tint = unit(seed, 'plate', gx, gy, 'tint');
    const calm = textured ? 1 : 0.35;
    const fill = tint < 0.3 ? mixHex(body, crack, (0.06 + 0.1 * tint) * calm) : mixHex(body, light, (0.08 + 0.3 * tint * (margin ? 0.6 : 1)) * calm);
    prims.push({
      kind: 'polygon',
      points: cell.map((p) => ({ x: s.x + (p.x - s.x) * shrink, y: s.y + (p.y - s.y) * shrink })),
      fill,
      ...(textured ? { stroke: mixHex(body, crack, margin ? 0.8 : 0.4), strokeWidth: margin ? line * 1.7 : line } : {}),
    });
  }
  return prims;
}

/* ------------------------------------------------------------ sea ice */

export interface SeaIceInput {
  cols: number;
  rows: number;
  size: number;
  seed: string;
  /** Sea Ice hexes drawn whole (not split), and the irregularity of each. */
  iceHexes: number[];
  levelOf: (hex: number) => Irregularity;
  /** Whether a hex is dry land (so ice meets it rather than the open sea). */
  isLand: (hex: number) => boolean;
  bounds: Bounds;
  colours: IceColours;
  /** Textured ice: cracks, plates and drifting floes. Flat ice is the body, its rim and a few plates. */
  textured: boolean;
  /** Smoothed and roughened outline; false keeps to the hex edges, as a hex-edged coast does. */
  organic: boolean;
  noise: (x: number, y: number, k: number) => number;
}

/**
 * The pack ice as primitives, to be drawn inside a clip of the open sea (it
 * lies over the sea's bands and under islands and the coast).
 */
export function seaIcePrims(input: SeaIceInput): Prim[] {
  const { cols, rows, size, seed, iceHexes, levelOf, isLand, bounds, colours, textured, organic, noise } = input;
  const ice = new Set(iceHexes);
  // The frozen area, with the dry land it lies against counted as part of it:
  // the pack runs right up to the shore, and only its open-water edge is an edge.
  const inside = new Set(ice);
  for (const i of ice) {
    for (let e = 0; e < 6; e++) {
      const n = neighbourOf(i % cols, Math.floor(i / cols), e);
      if (!inBounds(cols, rows, n.col, n.row)) continue;
      const j = hexIndex(cols, n.col, n.row);
      if (isLand(j)) inside.add(j);
    }
  }
  const whole: Array<Surface | null> = Array.from({ length: cols * rows }, (_, i) => (inside.has(i) ? 'land' : 'sea'));
  const surface: SurfaceMap = { cols, rows, whole, split: new Map() };
  const edges = surfaceEdges(surface, size, (s) => s === 'land', inside);
  const reachesRim = [...inside].some((i) => [0, 1, 2, 3, 4, 5].some((e) => {
    const n = neighbourOf(i % cols, Math.floor(i / cols), e);
    return !inBounds(cols, rows, n.col, n.row);
  }));
  const body = closedOutlines(
    edges,
    organic
      ? {
          size,
          noise,
          // Only the edges of ice itself are roughened; the shore keeps its own line.
          amplitude: (edge) => (edge.hex !== undefined && ice.has(edge.hex) ? ICE_AMPLITUDE[levelOf(edge.hex)] : 0),
        }
      : undefined,
    bounds,
    reachesRim,
  );
  if (body.length === 0) return [];

  const prims: Prim[] = [{ kind: 'path', d: body, fill: colours.body }];

  // The frosted rim: a wide pale stroke on the outline, kept to the inside of the pack.
  prims.push({
    kind: 'group',
    clip: body,
    prims: [
      { kind: 'path', d: body, stroke: colours.rim, strokeWidth: size * 0.5, round: true },
      { kind: 'path', d: body, stroke: colours.crack, strokeWidth: Math.max(0.8, size * 0.07), round: true },
    ],
  });

  // Plates, kept to the pack so they never run out across open water or land.
  const open = (j: number) => !ice.has(j) && !isLand(j);
  /** Whether the hex under a point is pack ice with open water beside it: where the pack is broken up. */
  const atMargin = (p: Point): boolean => {
    const here = pixelToOffset(p.x, p.y, size);
    for (let e = 0; e < 6; e++) {
      const n = neighbourOf(here.col, here.row, e);
      if (inBounds(cols, rows, n.col, n.row) && open(hexIndex(cols, n.col, n.row))) return true;
    }
    return false;
  };
  prims.push({
    kind: 'group',
    clip: body,
    prims: icePlates({
      size,
      seed,
      centres: iceHexes.map((i) => hexCenter(i % cols, Math.floor(i / cols), size)),
      body: colours.body,
      light: colours.floe,
      crack: colours.crack,
      textured,
      atMargin,
    }),
  });

  // The margin breaks up into floes: only along edges that are ice's own.
  if (textured && organic) {
    const near = nearHexes(cols, rows, size, (i) => (ice.has(i) ? levelOf(i) : null), 1.2);
    prims.push(...floeFringe(pathPolylines(body), size, seed, near, colours));
  }
  return prims;
}

/**
 * A lookup from a point to the highest irregularity among the `pick`ed hexes whose
 * centre lies within `reach` hex sizes of it, or null when there are none.
 */
export function nearHexes(
  cols: number,
  rows: number,
  size: number,
  pick: (hex: number) => Irregularity | null,
  reach: number,
): (p: Point) => Irregularity | null {
  return (p) => {
    const here = pixelToOffset(p.x, p.y, size);
    let best: Irregularity | null = null;
    const consider = (col: number, row: number) => {
      if (!inBounds(cols, rows, col, row)) return;
      const level = pick(hexIndex(cols, col, row));
      if (!level) return;
      const c = hexCenter(col, row, size);
      if (Math.hypot(c.x - p.x, c.y - p.y) > reach * size) return;
      if (best === null || LEVEL[level] > LEVEL[best]) best = level;
    };
    consider(here.col, here.row);
    for (let e = 0; e < 6; e++) {
      const n = neighbourOf(here.col, here.row, e);
      consider(n.col, n.row);
    }
    return best;
  };
}

/* ------------------------------------------------------------ glaciers */

/**
 * The sloping shelf of a glacier along its coast: two bands along the coast
 * lines where glacier land meets the sea - a soft shaded one for the slope, a
 * bright thin one for the cliff top - to be drawn clipped to the glacier's own
 * land so none of it spills onto the water.
 */
export function glacierShelf(
  coastLines: Point[][],
  size: number,
  isGlacierShore: (p: Point) => boolean,
  colours: { slope: string; edge: string },
): Prim[] {
  const d = runsWhere(coastLines, isGlacierShore);
  if (d.length === 0) return [];
  return [
    { kind: 'path', d, stroke: colours.slope, strokeWidth: size * 0.46, round: true },
    { kind: 'path', d, stroke: colours.edge, strokeWidth: Math.max(0.8, size * 0.07), round: true },
  ];
}

/**
 * Where a glacier's shore meets pack ice there is no coast to ink, only ice
 * against ice: a pale seam laid over the coastline where it runs between them.
 */
export function iceSeam(coastLines: Point[][], size: number, between: (p: Point) => boolean, colour: string, inkWidth: number): Prim[] {
  const d = runsWhere(coastLines, between);
  return d.length === 0 ? [] : [{ kind: 'path', d, stroke: colour, strokeWidth: inkWidth * 1.8 + size * 0.03, round: true }];
}

/**
 * The stretches of `lines` whose points satisfy `keep`, as path commands. A line's
 * own first and last points ride along with a stretch that reaches them: a coast that
 * runs off the map ends in a stub (the part carried out to the page's edge) that must
 * not be left uncovered.
 */
function runsWhere(lines: Point[][], keep: (p: Point) => boolean): PathCmd[] {
  const runs: Point[][] = [];
  for (const poly of lines) {
    let run: Point[] = [];
    poly.forEach((p, k) => {
      const ends = k === 0 || k === poly.length - 1;
      const wanted = keep(p) || (k === 0 && poly.length > 1 && keep(poly[1]!)) || (k === poly.length - 1 && k > 0 && keep(poly[k - 1]!));
      if (wanted && (!ends || keep(p) || run.length > 0 || k === 0)) run.push(p);
      else if (run.length > 1) {
        runs.push(run);
        run = [];
      } else run = [];
    });
    if (run.length > 1) runs.push(run);
  }
  return runs.flatMap((r) => r.map((p, i) => [i === 0 ? 'M' : 'L', p.x, p.y] as PathCmd));
}

/* ------------------------------------------------------------ glaciers and the ground under them */

/** How high each elevation stands, lowest first. */
export const ELEVATION_RANK: Record<Elevation, number> = { Lowland: 0, Rolling: 1, Hills: 2, Plateau: 3, Highland: 4, Mountains: 5 };

export interface GlacierEdgeInput {
  cols: number;
  rows: number;
  size: number;
  glacier: ReadonlySet<number>;
  /** Water of every kind (sea, lake, sea ice): the glacier's coast is the sea's to draw, not the ice margin's. */
  isWater: (hex: number) => boolean;
  levelOf: (hex: number) => Irregularity;
  /** The height rank of a hex's ground, or null where elevation is not known (or not shown). */
  rankOf: (hex: number) => number | null;
  noise: (x: number, y: number, k: number) => number;
}

/**
 * Where a glacier ends on dry land, as a line of its own: traced between glacier
 * hexes and the land hexes beside them (the glacier's coast with water is left
 * to the coast), smoothed, and roughened by the irregularity of the ice hex.
 * Height decides its character. Ice climbs onto ground higher than its own and
 * ends in a ragged, broken edge there; against lower ground it holds back in
 * smooth, rounded lobes: a snow line, in a hex map.
 *
 * The geometry's slivers say what to repaint: `toLand` is ice gained over the
 * neighbouring land, `toWater` land regained from the ice (their donors are the hexes
 * whose colours fill them, as for a coast).
 */
export function glacierEdges(input: GlacierEdgeInput): CoastGeometry {
  const { cols, rows, size, glacier, isWater, levelOf, rankOf, noise } = input;
  // The glacier, with the water beside it counted as part of it, so that only its edge
  // against other land is an edge.
  const inside = new Set(glacier);
  for (const i of glacier) {
    for (let e = 0; e < 6; e++) {
      const n = neighbourOf(i % cols, Math.floor(i / cols), e);
      if (!inBounds(cols, rows, n.col, n.row)) continue;
      const j = hexIndex(cols, n.col, n.row);
      if (isWater(j)) inside.add(j);
    }
  }
  const whole: Array<Surface | null> = Array.from({ length: cols * rows }, (_, i) => (inside.has(i) ? 'land' : 'sea'));
  const edges = surfaceEdges({ cols, rows, whole, split: new Map() }, size, (s) => s === 'land', glacier as Set<number>);
  /** How much higher the ground across an edge is than the ice's own, in elevation steps. */
  const rise = (edge: CoastEdge): number => {
    const here = edge.hex === undefined ? null : rankOf(edge.hex);
    const there = edge.across === undefined ? null : rankOf(edge.across);
    return here === null || there === null ? 0 : there - here;
  };
  return coastGeometryOf(edges, true, {
    size,
    noise,
    amplitude: (edge) => {
      const r = rise(edge);
      return ICE_AMPLITUDE[levelOf(edge.hex ?? 0)] * (r > 0 ? 1 + 0.22 * r : Math.max(0.55, 1 + 0.12 * r));
    },
    lean: (edge) => {
      const r = rise(edge);
      return Math.max(-0.1, Math.min(0.24, r > 0 ? 0.06 * r : 0.04 * r));
    },
  });
}

/** The ice at the margin as primitives: a frosted band on the ice's side, and a fine line along the margin itself. */
export function glacierMarginPrims(paths: PathCmd[], size: number, colours: { frost: string; line: string }): Prim[] {
  if (paths.length === 0) return [];
  return [
    { kind: 'path', d: paths, stroke: colours.frost, strokeWidth: size * 0.34, round: true },
    { kind: 'path', d: paths, stroke: colours.line, strokeWidth: Math.max(0.7, size * 0.032), round: true },
  ];
}

/**
 * The ice's surface shaded by the ground it lies on, as soft overlapping
 * discs, not hex by hex: low ice is dull, ice over high ground is bright. Each
 * hex lays a stack of discs one inside the other, so tones melt into one another
 * across the hex edges.
 */
export function glacierShading(
  hexes: Array<{ c: Point; rank: number }>,
  size: number,
  colours: { dull: string; bright: string },
  withAlpha: (colour: string, alpha: number) => string,
): Prim[] {
  const prims: Prim[] = [];
  const SOFTNESS = [1.3, 1.12, 0.96, 0.82, 0.68, 0.54, 0.4];
  // The sheet's own colour is the middle: dull below it, bright above.
  const DULL = [0.4, 0.25, 0.1, 0, 0, 0];
  const BRIGHT = [0, 0, 0, 0.3, 0.55, 0.8];
  for (const { c, rank } of hexes) {
    const r = Math.max(0, Math.min(5, rank));
    for (const [colour, amount] of [[colours.dull, DULL[r]!], [colours.bright, BRIGHT[r]!]] as const) {
      if (amount <= 0) continue;
      // A stack of discs, each a little smaller than the last, whose tones sum to `amount` at the centre.
      const each = 1 - Math.pow(1 - amount, 1 / SOFTNESS.length);
      for (const reach of SOFTNESS) {
        prims.push({ kind: 'circle', c, r: size * reach, fill: withAlpha(colour, each) });
      }
    }
  }
  return prims;
}

/**
 * Lines of flow: ice moves downhill, so from a hex on rising ground a few
 * long strokes run towards its lowest neighbour, closing in as they go.
 */
export function glacierFlow(
  flows: Array<{ i: number; c: Point; to: Point }>,
  size: number,
  seed: string,
  colour: string,
): Prim[] {
  const prims: Prim[] = [];
  const width = Math.max(0.6, size * 0.028);
  for (const { i, c, to } of flows) {
    const len = Math.hypot(to.x - c.x, to.y - c.y) || 1;
    const u = { x: (to.x - c.x) / len, y: (to.y - c.y) / len };
    const v = { x: -u.y, y: u.x };
    const strokes = 2 + Math.floor(unit(seed, 'flow', i, 'n') * 2);
    for (let k = 0; k < strokes; k++) {
      const lane = (k - (strokes - 1) / 2) * size * 0.26 + signed(seed, 'flow', i, k, 'l') * size * 0.05;
      const back = size * (0.3 + 0.25 * unit(seed, 'flow', i, k, 'b'));
      const ahead = size * (0.75 + 0.35 * unit(seed, 'flow', i, k, 'a'));
      const bend = signed(seed, 'flow', i, k, 'w') * size * 0.1;
      const at = (along: number, across: number): Point => ({ x: c.x + u.x * along + v.x * across, y: c.y + u.y * along + v.y * across });
      const from = at(-back, lane);
      const mid = at((ahead - back) / 2, lane * 0.8 + bend);
      const end = at(ahead, lane * 0.45);
      prims.push({ kind: 'path', d: [['M', from.x, from.y], ['Q', mid.x, mid.y, end.x, end.y]], stroke: colour, strokeWidth: width, round: true });
    }
  }
  return prims;
}
