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
import type { Irregularity } from '../../shared/types.js';
import { coastGeometryOf, surfaceEdges, type CoastEdge, type Roughness, type Surface, type SurfaceMap } from './coast.js';
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
function closedOutlines(edges: CoastEdge[], rough: Roughness | undefined, bounds: Bounds): PathCmd[] {
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
  );
  if (body.length === 0) return [];

  const line = Math.max(0.5, size * 0.025);
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

  // Plates and cracks, kept to the pack so they never run out across open water or land.
  const inner: Prim[] = [];
  for (const i of iceHexes) {
    const c = hexCenter(i % cols, Math.floor(i / cols), size);
    // Plates of ice: broad, overlapping slabs in slightly different tints, so the
    // pack reads as pieces rather than a flat fill.
    const plates = textured ? 3 + Math.floor(unit(seed, 'plate', i, 'n') * 2) : 2;
    for (let k = 0; k < plates; k++) {
      const angle = (k / plates) * Math.PI * 2 + signed(seed, 'plate', i, k, 'a') * 0.7;
      const reach = size * (0.05 + 0.5 * unit(seed, 'plate', i, k, 'r'));
      inner.push(
        floe(
          { x: c.x + Math.cos(angle) * reach, y: c.y + Math.sin(angle) * reach * 0.9 },
          size * (0.3 + 0.22 * unit(seed, 'plate', i, k, 's')),
          seed,
          ['plate', i, k],
          mixHex(colours.body, colours.floe, 0.25 + 0.5 * unit(seed, 'plate', i, k, 'tint')),
          mixHex(colours.body, colours.crack, 0.45),
          line * 0.8,
        ),
      );
    }
    if (!textured) continue;
    // Leads: a couple of jagged cracks through the hex, long enough to cross into the next.
    const cracks = unit(seed, 'crack', i, 'n') < 0.6 ? 1 : 0;
    for (let k = 0; k < cracks; k++) {
      const turn = signed(seed, 'crack', i, k, 'a') * Math.PI;
      const half = size * (0.35 + 0.35 * unit(seed, 'crack', i, k, 'l'));
      const origin = { x: c.x + signed(seed, 'crack', i, k, 'x') * size * 0.4, y: c.y + signed(seed, 'crack', i, k, 'y') * size * 0.35 };
      const points: Point[] = [];
      const steps = 4;
      for (let s = 0; s <= steps; s++) {
        const along = (s / steps - 0.5) * 2 * half;
        const kink = s === 0 || s === steps ? 0 : signed(seed, 'crack', i, k, 'k', s) * size * 0.1;
        points.push({
          x: origin.x + Math.cos(turn) * along - Math.sin(turn) * kink,
          y: origin.y + Math.sin(turn) * along + Math.cos(turn) * kink,
        });
      }
      inner.push({ kind: 'polyline', points, stroke: colours.crack, strokeWidth: Math.max(0.6, size * 0.035), round: true });
    }
  }
  prims.push({ kind: 'group', clip: body, prims: inner });

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
  const runs: Point[][] = [];
  for (const poly of coastLines) {
    let run: Point[] = [];
    for (const p of poly) {
      if (isGlacierShore(p)) run.push(p);
      else if (run.length > 1) {
        runs.push(run);
        run = [];
      } else run = [];
    }
    if (run.length > 1) runs.push(run);
  }
  if (runs.length === 0) return [];
  const toPath = (r: Point[]): PathCmd[] => r.map((p, i) => [i === 0 ? 'M' : 'L', p.x, p.y] as PathCmd);
  const d = runs.flatMap(toPath);
  return [
    { kind: 'path', d, stroke: colours.slope, strokeWidth: size * 0.46, round: true },
    { kind: 'path', d, stroke: colours.edge, strokeWidth: Math.max(0.8, size * 0.07), round: true },
  ];
}
