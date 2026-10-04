/**
 * River courses for the tapered style.
 *
 * A course runs through the points where the river crosses hex edges. Each
 * crossing slides along its edge by a seeded amount (at most a quarter of the
 * edge length), keyed by the edge itself, so every river that crosses an edge
 * crosses it at the same point and two hexes always agree on where their shared
 * river passes. A hex centre is used only where a river rises. A tributary that
 * ends inside another river's hex ends on that river's drawn line, and a
 * distributary starts on its parent's line, so confluences and forks meet
 * exactly.
 *
 * The course is a centripetal Catmull-Rom curve through those points. Passing
 * through edge crossings rather than hex centres matters: when a river turns
 * between two adjacent edges, a centre point sits behind both crossings and the
 * curve hooks back on itself, which is what made the earlier version look odd.
 *
 * Before the curve is fitted, each crossing is relaxed along its edge towards
 * the straight line between its neighbours, as a string pulled taut through the
 * channel of edges would settle. That removes the zigzag of 60 and 120 degree
 * turns the hex walk would otherwise leave. A gentle seeded meander is then laid
 * across the sampled line: its wavelength grows with the river's width and its
 * swing shrinks, so streams wander and big rivers run calm, and it is held
 * inside the river's own hexes.
 *
 *
 * The river is drawn as a filled outline. It rises as a thread that is half the
 * normal width by the time it leaves its source hex, then grows to the normal
 * width. A tributary adds a little to the river it joins, distance from the
 * source adds up to a fifth (for the longest river on the map; shorter rivers
 * add in proportion), and navigable water is a tenth wider. A mouth into the
 * sea or a lake flares, and a mouth into the sea is cut at the shore as drawn.
 *
 * A river segment may guide how near the hex centre its underlying course comes. The chosen wander style is then
 * applied to that guided course, so the manual adjustment does not replace the river's irregular character.
 */

import { canonicalEdgeId, hexCenter, hexEdgePoints, pixelToOffset, type Point } from '../../shared/hex.js';
import type { River } from '../../shared/types.js';
import type { RiverWander } from './styles.js';
import type { PathCmd } from './prims.js';
import { signed } from './seed.js';
import { PRESS, SET_IN } from './riverCity.js';

export interface RiverCourse {
  /** Dense points along the centre of the river, source to mouth. */
  centreline: Point[];
  /** Width of the river at each centreline point. */
  widths: number[];
  outline: PathCmd[];
  /** Where each icon of a city standing on this river is drawn: set into the bank, with the river bowed round it. */
  icons: Array<{ id: string; at: Point }>;
  /** The edge of the river, open at its mouth (and where it leaves a lake or a fork), to be stroked in the bank colour. */
  bank: Point[][];
}

/** How far a crossing may slide from the edge midpoint, as a fraction of the edge: the default level's. A crossing keeps at least 0.5 minus this, as a fraction of the edge, from either corner. */
const SLIDE = 0.375;

/**
 * What each level of river irregularity does: how far the wander swings (a multiple of the base swing), how
 * many passes pull the crossings taut (fewer leaves the hex walk's own corners), and how far a crossing may
 * slide along its edge (a crossing stays at least 0.5 minus `slide` of the edge from a corner: 0.125 at the
 * default level, 0.05 in wild). Irregularity changes the course relative to its route; it does not attract the course
 * to hex centres.
 */
const WANDER: Record<RiverWander, { swing: number; relax: number; slide: number }> = {
  verygentle: { swing: 0.85, relax: 6, slide: 0.3 },
  gentle: { swing: 1.3, relax: 2, slide: 0.34 },
  normal: { swing: 1.9, relax: 0, slide: 0.375 },
  irregular: { swing: 2.5, relax: 0, slide: 0.415 },
  wild: { swing: 3.2, relax: 0, slide: 0.45 },
};
const SAMPLES_PER_SPAN = 8;
/** How far along its edge a relaxed crossing may settle, as a fraction of the edge. */
/** How far ahead, in hex sizes, a tributary's last tangent looks along its host's flow. */
const JOIN_LEAN = 1.2;
/** How far upstream of the join, in hex sizes, a tributary is steered onto its host's line. */
const JOIN_RUN = 0.55;
/** How much of a tributary's last approach follows its host's flow rather than its own heading. */
const JOIN_FLOW = 0.6;
/** The largest swing of a meander, in hex sizes (from the centre line). */
const MEANDER = 0.5;
const CAP_STEPS = 6;
/** How far a river runs on into the lake it empties into, in hex sizes. */
const MOUTH_REACH = 0.12;
/** The normal width of a river, in hex sizes. */
const NORMAL_WIDTH = 0.045;
/** What a tributary adds to the river it joins, as a fraction of the normal width. */
const TRIBUTARY_WIDENS = 0.05;
/** What distance from the source adds, at most, to the longest river: a fraction of the normal width. */
const LENGTH_WIDENS = 0.2;
/** What navigable water adds, as a fraction of the normal width. */
const NAVIGABLE_WIDENS = 0.1;
/** How wide a river is as it leaves its source hex, as a fraction of the normal width. */
const SOURCE_EXIT_WIDTH = 0.5;
/** Distance from a hex centre to the middle of an edge, in hex sizes. */
const CENTRE_TO_EDGE = Math.sqrt(3) / 2;

interface Slide {
  a: Point;
  b: Point;
  /** Fraction of the way from a to b. */
  t: number;
}

/** The edge `edge` of hex (col, row) as its two ends and the seeded fraction along it where rivers cross. */
function edgeSlide(col: number, row: number, edge: number, size: number, seed: string, slide = SLIDE): Slide {
  const id = canonicalEdgeId(col, row, edge);
  const m = /^(-?\d+),(-?\d+):(\d)$/.exec(id)!;
  const [a, b] = hexEdgePoints(Number(m[1]), Number(m[2]), Number(m[3]), size);
  return { a, b, t: 0.5 + signed(seed, 'crossing', id) * slide };
}

const along = (s: Slide): Point => ({ x: s.a.x + (s.b.x - s.a.x) * s.t, y: s.a.y + (s.b.y - s.a.y) * s.t });

/** Where rivers cross the edge `edge` of hex (col, row): the same point from either side. */
export function edgeCrossing(col: number, row: number, edge: number, size: number, seed: string, wander: RiverWander = 'normal'): Point {
  return along(edgeSlide(col, row, edge, size, seed, WANDER[wander].slide));
}

interface Control {
  p: Point;
  /** Navigability of the span that ends at this point. */
  navigable: boolean;
  /** Hex that the span ending at this point must traverse. */
  spanHex?: string;
  /** Set where the point is a crossing that may slide along its edge. */
  slide?: Slide;
}

export interface CourseEnds {
  /** Where the river starts, if not its source hex's centre (a distributary's fork). */
  start?: Point | null;
  /** Where the river ends, if it ends inside a hex (a tributary's confluence). */
  end?: Point | null;
  /** The direction the river it joins is flowing at the confluence (unit vector): a tributary comes in along it, not across it. */
  joinTangent?: Point | null;
  /** A point in the lake the river flows out of, before its first crossing. */
  before?: Point | null;
  /** A point in the lake the river empties into, past its last crossing. */
  beyond?: Point | null;
  /**
   * Whether a point lies in standing water as drawn (a lake's body). The
   * course is cut where it leaves the water at its source and where it meets
   * it at its mouth, so it starts and ends exactly on the shore.
   */
  inWater?: ((p: Point) => boolean) | null;
  /** Rivers flowing in along the way: each widens the river below where it joins. */
  inflows?: Array<{ at: Point }>;
  /** The length of the longest river on the map, which sets how much distance from the source widens a river. */
  longest?: number;
  /**
   * Whether a point is land as drawn (the coast as traced, with its land shares
   * and roughening). A river into the sea is cut at the shore, where it flares.
   */
  onLand?: ((p: Point) => boolean) | null;
  /**
   * Cities on this river: each hex's centre and its marker's radius. A river
   * that ends at a city stops under its icon rather than running on past it as a
   * stub, and the course bows round the icon of a city on its bank.
   */
  cities?: Array<{
    at: Point;
    radius: number;
    id?: string;
    /** The icon: how far it reaches, and whether it stands across the river (the largest size) rather than on its bank. */
    icon?: { reach: number; straddle: boolean; setIn?: number; press?: number; dy?: number };
  }>;
  /** How irregular the course is (see `WANDER`); 'normal' when omitted. */
  wander?: RiverWander;
}

function controls(river: River, size: number, seed: string, ends: CourseEnds): Control[] {
  const level = WANDER[ends.wander ?? 'normal'];
  const out: Control[] = [];
  const push = (p: Point, navigable: boolean, slide?: Slide, spanHex?: string) => {
    const last = out[out.length - 1];
    if (last && Math.hypot(last.p.x - p.x, last.p.y - p.y) < size * 0.02) return;
    out.push({ p, navigable, slide, spanHex });
  };
  const cross = (col: number, row: number, edge: number, navigable: boolean, spanHex?: string) => {
    const slide = edgeSlide(col, row, edge, size, seed, level.slide);
    push(along(slide), navigable, slide, spanHex);
  };
  if (ends.before && river.segments[0]) push(ends.before, river.segments[0].navigable);
  river.segments.forEach((s, k) => {
    const key = `${s.col},${s.row}`;
    if (s.entryEdge !== null) cross(s.col, s.row, s.entryEdge, s.navigable);
    else if (k === 0) {
      if (ends.start) push(ends.start, s.navigable);
      else {
        // A spring: near, but not exactly at, the hex centre.
        const c = hexCenter(s.col, s.row, size);
        push({
          x: c.x + signed(seed, 'source', s.col, s.row, 'x') * size * 0.15,
          y: c.y + signed(seed, 'source', s.col, s.row, 'y') * size * 0.15,
        }, s.navigable);
      }
    }
    if (s.exitEdge !== null) cross(s.col, s.row, s.exitEdge, s.navigable, key);
    else if (k === river.segments.length - 1) {
      // A tributary meets its host at an acute angle, leaning downstream: a point
      // a little upstream of the join, between the way the tributary was heading
      // and the way its host flows, turns the last stretch.
      const before = out[out.length - 1]?.p;
      if (ends.end && ends.joinTangent && before) {
        const u = { x: ends.end.x - before.x, y: ends.end.y - before.y };
        const ul = Math.hypot(u.x, u.y) || 1;
        const t = ends.joinTangent;
        const dir = { x: JOIN_FLOW * t.x + (1 - JOIN_FLOW) * (u.x / ul), y: JOIN_FLOW * t.y + (1 - JOIN_FLOW) * (u.y / ul) };
        const dl = Math.hypot(dir.x, dir.y) || 1;
        push({ x: ends.end.x - (dir.x / dl) * size * JOIN_RUN, y: ends.end.y - (dir.y / dl) * size * JOIN_RUN }, s.navigable, undefined, key);
      }
      push(ends.end ?? hexCenter(s.col, s.row, size), s.navigable, undefined, key);
    }
  });
  const last = river.segments.at(-1);
  if (ends.beyond && last) push(ends.beyond, last.navigable);
  return out;
}

/**
 * Settle each sliding crossing towards the midpoint of its neighbours, along its
 * own edge, so the course through the channel of edges is as taut as the hexes
 * allow. The seeded starting positions keep a little of their character.
 */
function relax(ctrl: Control[], passes: number, slide: number): void {
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 1; i < ctrl.length - 1; i++) {
      const c = ctrl[i]!;
      if (!c.slide) continue;
      const { a, b } = c.slide;
      const goal = { x: (ctrl[i - 1]!.p.x + ctrl[i + 1]!.p.x) / 2, y: (ctrl[i - 1]!.p.y + ctrl[i + 1]!.p.y) / 2 };
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const want = ((goal.x - a.x) * dx + (goal.y - a.y) * dy) / (dx * dx + dy * dy);
      const target = Math.min(0.5 + slide, Math.max(0.5 - slide, want));
      c.slide.t += (target - c.slide.t) * 0.5;
      c.p = along(c.slide);
    }
  }
}

const smoothstep = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Centripetal Catmull-Rom (alpha 0.5) between p1 and p2, sampled at t in (0, 1]. */
function catmullRom(p0: Point, p1: Point, p2: Point, p3: Point, samples: number): Point[] {
  const knot = (a: Point, b: Point) => Math.max(1e-6, Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)));
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const lerp = (a: Point, b: Point, ta: number, tb: number, t: number): Point => {
    const w = (t - ta) / (tb - ta);
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
  };
  const out: Point[] = [];
  for (let k = 1; k <= samples; k++) {
    const t = t1 + ((t2 - t1) * k) / samples;
    const a1 = lerp(p0, p1, t0, t1, t);
    const a2 = lerp(p1, p2, t1, t2, t);
    const a3 = lerp(p2, p3, t2, t3, t);
    const b1 = lerp(a1, a2, t0, t2, t);
    const b2 = lerp(a2, a3, t1, t3, t);
    out.push(lerp(b1, b2, t1, t2, t));
  }
  return out;
}

/**
 * Guide the underlying course in each adjusted hex so its closest approach to the centre lies within `reach`.
 * The displacement dies away at the hex edges, leaving shared crossings fixed. This runs before seeded meander:
 * the map's wander setting therefore still determines the final line instead of this adjustment smoothing it out.
 * Spans are measured on the sampled line; a few passes settle the shoulders left by a single displacement.
 */
function holdToReach(
  line: Point[],
  river: River,
  size: number,
  ok: (p: Point) => boolean,
): void {
  const apothem = size * CENTRE_TO_EDGE;
  const arc = [0];
  for (let i = 1; i < line.length; i++) arc.push(arc[i - 1]! + Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.y - line[i - 1]!.y));
  const hexOf = (p: Point) => {
    const h = pixelToOffset(p.x, p.y, size);
    return `${h.col},${h.row}`;
  };
  for (const s of river.segments) {
    if (!s.reach || (s.reach.min === null && s.reach.max === null) || s.entryEdge === null || s.exitEdge === null) continue;
    const hi = s.reach.max === null ? Infinity : s.reach.max * apothem;
    // Should the bounds cross, the upper bound wins.
    const low = Math.min((s.reach.min ?? 0) * apothem, hi);
    const key = `${s.col},${s.row}`;
    const c = hexCenter(s.col, s.row, size);
    const dist = (p: Point) => Math.hypot(p.x - c.x, p.y - c.y);
    let preferred: Point | null = null;
    for (let pass = 0; pass < 6; pass++) {
      // The run of the line inside this hex that comes nearest the centre.
      let best = -1;
      for (let i = 1; i < line.length - 1; i++) {
        if (hexOf(line[i]!) === key && (best < 0 || dist(line[i]!) < dist(line[best]!))) best = i;
      }
      if (best < 0) break;
      const d = dist(line[best]!);
      const want = Math.min(hi, Math.max(low, d));
      if (Math.abs(want - d) < apothem * 0.004) break;
      let first = best;
      let last = best;
      while (first > 0 && hexOf(line[first - 1]!) === key) first--;
      while (last < line.length - 1 && hexOf(line[last + 1]!) === key) last++;
      const from = Math.max(0, first - 1);
      const to = Math.min(line.length - 1, last + 1);
      const p = line[best]!;
      if (!preferred) {
        // Translate the reach sideways relative to its entry-to-exit chord. A
        // radial push changes direction along the curve and can fold it; one
        // fixed normal preserves the ordering and irregularity of its samples.
        const a = line[from]!;
        const b = line[to]!;
        const chord = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const nx = -(b.y - a.y) / chord;
        const ny = (b.x - a.x) / chord;
        let side = (p.x - c.x) * nx + (p.y - c.y) * ny;
        if (Math.abs(side) < apothem * 0.02) {
          const mid = line[Math.floor((first + last) / 2)]!;
          side = (mid.x - c.x) * nx + (mid.y - c.y) * ny;
        }
        if (Math.abs(side) < apothem * 0.02) side = signed(river.id, 'reach-side', s.col, s.row);
        preferred = { x: Math.sign(side) * nx, y: Math.sign(side) * ny };
      }
      const dot = (p.x - c.x) * preferred.x + (p.y - c.y) * preferred.y;
      const sideways = -dot + Math.sqrt(Math.max(0, want * want - d * d + dot * dot));
      const shift = want > d
        ? { x: preferred.x * sideways, y: preferred.y * sideways }
        : { x: c.x + ((p.x - c.x) / d) * want - p.x, y: c.y + ((p.y - c.y) / d) * want - p.y };
      // Take the whole shift if the apex may go there, else as much of it as may.
      let f = 1;
      while (f > 0.1) {
        const q = { x: p.x + shift.x * f, y: p.y + shift.y * f };
        if (hexOf(q) === key && ok(q)) break;
        f /= 2;
      }
      if (f <= 0.1) break;
      const before = arc[best]! - arc[from]!;
      const after = arc[to]! - arc[best]!;
      for (let i = from; i <= to; i++) {
        const span = i < best ? before : after;
        const w = span > 0 ? smoothstep(1 - Math.abs(arc[i]! - arc[best]!) / span) : 1;
        line[i] = { x: line[i]!.x + shift.x * f * w, y: line[i]!.y + shift.y * f * w };
      }
    }
  }
}

export function riverCourse(river: River, size: number, seed: string, ends: CourseEnds = {}): RiverCourse | null {
  const ctrl = controls(river, size, seed, ends);
  if (ctrl.length < 2) return null;
  relax(ctrl, WANDER[ends.wander ?? 'normal'].relax, SLIDE);
  const pts = ctrl.map((c) => c.p);
  // Reflect the ends so the first and last spans have a tangent to follow.
  const n = pts.length;
  const before = { x: 2 * pts[0]!.x - pts[1]!.x, y: 2 * pts[0]!.y - pts[1]!.y };
  // A tributary arrives heading the way its host flows, so the join is a fork
  // of the water rather than a collision: the last tangent leans that way.
  const lean = ends.end && ends.joinTangent ? ends.joinTangent : null;
  const after = lean
    ? { x: pts[n - 1]!.x + lean.x * size * JOIN_LEAN, y: pts[n - 1]!.y + lean.y * size * JOIN_LEAN }
    : { x: 2 * pts[n - 1]!.x - pts[n - 2]!.x, y: 2 * pts[n - 1]!.y - pts[n - 2]!.y };
  const ext = [before, ...pts, after];

  let centreline: Point[] = [pts[0]!];
  let navigable: boolean[] = [ctrl[0]!.navigable];
  let spanHexes: Array<string | undefined> = [undefined];
  for (let i = 0; i < n - 1; i++) {
    const curve = catmullRom(ext[i]!, ext[i + 1]!, ext[i + 2]!, ext[i + 3]!, SAMPLES_PER_SPAN);
    const spanHex = ctrl[i + 1]!.spanHex;
    const belongs = (q: Point) => {
      const h = pixelToOffset(q.x, q.y, size);
      return !spanHex || `${h.col},${h.row}` === spanHex;
    };
    // Reduce the curved departure from the in-hex chord uniformly over the
    // span. Clipping samples separately would put corners into the contour.
    let curveFraction = 1;
    for (let j = 0; spanHex && j < curve.length - 1; j++) {
      const t = (j + 1) / SAMPLES_PER_SPAN;
      const straight = { x: pts[i]!.x + (pts[i + 1]!.x - pts[i]!.x) * t, y: pts[i]!.y + (pts[i + 1]!.y - pts[i]!.y) * t };
      const p = curve[j]!;
      if (belongs(p)) continue;
      let lo = 0;
      let hi = curveFraction;
      for (let k = 0; k < 8; k++) {
        const f = (lo + hi) / 2;
        const q = { x: straight.x + (p.x - straight.x) * f, y: straight.y + (p.y - straight.y) * f };
        if (belongs(q)) lo = f;
        else hi = f;
      }
      curveFraction = lo;
    }
    for (let j = 0; j < curve.length; j++) {
      let p = curve[j]!;
      if (spanHex && curveFraction < 1 && j < curve.length - 1) {
        const t = (j + 1) / SAMPLES_PER_SPAN;
        const straight = { x: pts[i]!.x + (pts[i + 1]!.x - pts[i]!.x) * t, y: pts[i]!.y + (pts[i + 1]!.y - pts[i]!.y) * t };
        p = { x: straight.x + (p.x - straight.x) * curveFraction, y: straight.y + (p.y - straight.y) * curveFraction };
      }
      centreline.push(p);
      navigable.push(ctrl[i + 1]!.navigable);
      spanHexes.push(j < curve.length - 1 ? ctrl[i + 1]!.spanHex : undefined);
    }
  }
  // The river's own hexes: its line is kept inside them.
  const hexes = new Set(river.segments.map((s) => `${s.col},${s.row}`));
  const inHexes = (p: Point): boolean => {
    const here = pixelToOffset(p.x, p.y, size);
    if (hexes.has(`${here.col},${here.row}`)) return true;
    // A point exactly on an edge may round either way.
    return [0, 1, 2, 3, 4, 5].some((k) => {
      const q = pixelToOffset(p.x + Math.cos(k) * size * 0.04, p.y + Math.sin(k) * size * 0.04, size);
      return hexes.has(`${q.col},${q.row}`);
    });
  };
  // Cut the course at the shore where it leaves its source lake and where it
  // reaches the lake it empties into.
  const wet = ends.inWater;
  if (wet) {
    const shore = (inside: Point, outside: Point): Point => {
      let a = inside;
      let b = outside;
      for (let k = 0; k < 12; k++) {
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (wet(m)) a = m;
        else b = m;
      }
      return b;
    };
    let from = 0;
    if (ends.before) while (from < centreline.length - 1 && wet(centreline[from]!)) from++;
    let to = centreline.length - 1;
    if (ends.beyond) while (to > from && wet(centreline[to]!)) to--;
    if (from > 0 || to < centreline.length - 1) {
      const head = from > 0 ? [shore(centreline[from - 1]!, centreline[from]!)] : [];
      let tail: Point[] = [];
      let tailNavigable: boolean[] = [];
      if (to < centreline.length - 1) {
        // The river runs on a little way into the lake, so its mouth is not a cut across the shore.
        const edge = shore(centreline[to + 1]!, centreline[to]!);
        tail = [edge];
        for (let k = to + 1; k < centreline.length && Math.hypot(centreline[k]!.x - edge.x, centreline[k]!.y - edge.y) < size * MOUTH_REACH; k++) {
          tail.push(centreline[k]!);
        }
        tailNavigable = tail.map(() => navigable[to]!);
      }
      centreline = [...head, ...centreline.slice(from, to + 1), ...tail];
      navigable = [
        ...(head.length ? [navigable[from]!] : []),
        ...navigable.slice(from, to + 1),
        ...tailNavigable,
      ];
      spanHexes = [
        ...(head.length ? [undefined] : []),
        ...spanHexes.slice(from, to + 1),
        ...tail.map(() => undefined),
      ];
    }
    if (centreline.length < 2) return null;
  }

  // A river into the sea ends where the coast is drawn: cut where it leaves the
  // land, or carried on until it does, so it flares at its true mouth.
  const land = ends.onLand;
  if (land && river.terminus === 'Sea' && !ends.beyond && centreline.length >= 2) {
    const dry = (p: Point) => land(p) || Boolean(wet?.(p));
    const bisect = (inside: Point, outside: Point): Point => {
      let a = inside;
      let b = outside;
      for (let k = 0; k < 12; k++) {
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        if (dry(m)) a = m;
        else b = m;
      }
      return a;
    };
    let last = centreline.length - 1;
    while (last >= 0 && !dry(centreline[last]!)) last--;
    if (last >= 1) {
      if (last < centreline.length - 1) {
        centreline = [...centreline.slice(0, last + 1), bisect(centreline[last]!, centreline[last + 1]!)];
        navigable = [...navigable.slice(0, last + 1), navigable[last]!];
        spanHexes = [...spanHexes.slice(0, last + 1), undefined];
      } else {
        // Carry on along the last heading to the shore (a coast that bulges past the hex's edge).
        const a = centreline[last - 1]!;
        const b = centreline[last]!;
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        let from = b;
        for (let k = 1; k <= 14; k++) {
          const q = { x: b.x + ((b.x - a.x) / len) * size * 0.05 * k, y: b.y + ((b.y - a.y) / len) * size * 0.05 * k };
          if (!dry(q)) {
            centreline = [...centreline, bisect(from, q)];
            navigable = [...navigable, navigable[last]!];
            spanHexes = [...spanHexes, undefined];
            break;
          }
          from = q;
        }
      }
    }
  }

  // Where each city's marker sits on the course: its nearest sample within the hex.
  const sites: Array<{ p: Point; radius: number }> = [];
  for (const city of ends.cities ?? []) {
    let best: Point | null = null;
    let d = size * 0.8;
    for (const q of centreline) {
      const dq = Math.hypot(q.x - city.at.x, q.y - city.at.y);
      if (dq <= d) {
        d = dq;
        best = q;
      }
    }
    if (best) sites.push({ p: best, radius: city.radius });
  }
  // A river that rises at, or runs out at, a city stops under its icon rather
  // than running on past it as a stub.
  const indexOf = (p: Point) => centreline.indexOf(p);
  const arc = (from: number, to: number) => {
    let sum = 0;
    for (let i = from + 1; i <= to; i++) sum += Math.hypot(centreline[i]!.x - centreline[i - 1]!.x, centreline[i]!.y - centreline[i - 1]!.y);
    return sum;
  };
  const rises = !river.branchOf && !ends.before;
  const runsOut = !ends.end && !ends.beyond && river.terminus !== 'Sea' && river.terminus !== 'Lake' && river.terminus !== 'River';
  for (const { p, radius } of sites) {
    const k = indexOf(p);
    if (k < 0) continue;
    const reach = Math.max(radius * 1.5, size * 0.3);
    if (rises && k > 0 && arc(0, k) < reach && centreline.length - k >= 4) {
      centreline = centreline.slice(k);
      navigable = navigable.slice(k);
      spanHexes = spanHexes.slice(k);
      break;
    }
  }
  for (const { p, radius } of sites) {
    const k = indexOf(p);
    if (k < 0) continue;
    const reach = Math.max(radius * 1.5, size * 0.3);
    if (runsOut && k < centreline.length - 1 && k >= 3 && arc(k, centreline.length - 1) < reach) {
      centreline = centreline.slice(0, k + 1);
      navigable = navigable.slice(0, k + 1);
      spanHexes = spanHexes.slice(0, k + 1);
      break;
    }
  }

  // Keep the unadjusted arc coordinate for seeded wander. A local guide must not shift the noise phase in every
  // downstream hex merely because its guided route is a little longer or shorter.
  const wanderCum = [0];
  for (let i = 1; i < centreline.length; i++) {
    wanderCum.push(wanderCum[i - 1]! + Math.hypot(centreline[i]!.x - centreline[i - 1]!.x, centreline[i]!.y - centreline[i - 1]!.y));
  }
  if (river.segments.some((s) => s.reach && (s.reach.min !== null || s.reach.max !== null))) {
    holdToReach(centreline, river, size, (q) => !land || land(q) || Boolean(wet?.(q)));
  }

  const cum = [0];
  for (let i = 1; i < centreline.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(centreline[i]!.x - centreline[i - 1]!.x, centreline[i]!.y - centreline[i - 1]!.y));
  }
  const total = cum[cum.length - 1]!;
  // A distributary leaves a river that is already full grown.
  const head = river.branchOf ? 8 * size : 0;
  // Below each confluence the river carries its tributary's water too, taken on over about a hex.
  const added = centreline.map(() => 0);
  for (const inflow of ends.inflows ?? []) {
    let k = 0;
    let d = Infinity;
    centreline.forEach((q, i) => {
      const dq = Math.hypot(q.x - inflow.at.x, q.y - inflow.at.y);
      if (dq < d) {
        d = dq;
        k = i;
      }
    });
    for (let i = k; i < added.length; i++) added[i]! += smoothstep((cum[i]! - cum[k]!) / size);
  }
  // Width as a multiple of the normal: a tributary adds a twentieth where it joins, distance from the source
  // up to a fifth (the longest river on the map reaches it), and navigable water a tenth.
  const longest = Math.max(ends.longest ?? 0, total + head, size);
  const target = centreline.map((_, i) =>
    1 + LENGTH_WIDENS * Math.min(1, (cum[i]! + head) / longest) + TRIBUTARY_WIDENS * added[i]! + (navigable[i] ? NAVIGABLE_WIDENS : 0),
  );
  // Ease the change into navigable water, and past a confluence, over a couple of hexes.
  const reach = Math.round(SAMPLES_PER_SPAN * 1.25);
  const base = target.map((_, i) => {
    let sum = 0;
    let weight = 0;
    for (let k = Math.max(0, i - reach); k <= Math.min(target.length - 1, i + reach); k++) {
      const w = reach + 1 - Math.abs(k - i);
      sum += target[k]! * w;
      weight += w;
    }
    return (sum / weight) * size * NORMAL_WIDTH;
  });

  // Meander: an irregular seeded wander across the line, as a real river has: no
  // one wavelength, reaches that run nearly straight between reaches that wander,
  // and small wobbles on the large ones. It is value noise along the river, in
  // three scales, under a slowly changing envelope. Its swing shrinks as the river
  // widens, and it dies away at the ends so a fork or confluence still lands on
  // its host's line.
  const noise = (octave: number, x: number): number => {
    const k = Math.floor(x);
    const u = smoothstep(x - k);
    const a = signed(seed, 'meander', river.id, octave, k);
    const b = signed(seed, 'meander', river.id, octave, k + 1);
    return a + (b - a) * u;
  };
  const offset = centreline.map((_, i) => {
    // Scaled to the widths the meander was tuned for.
    const fraction = (base[i]! / size) * 2.2;
    const amplitude = size * MEANDER * WANDER[ends.wander ?? 'normal'].swing * (1 - 0.5 * smoothstep((fraction - 0.04) / 0.13));
    const at = wanderCum[i]! / size;
    const envelope = 0.55 + 0.45 * (0.5 + 0.5 * noise(7, at / 3.4));
    let fade = smoothstep(wanderCum[i]! / (0.8 * size)) * smoothstep((wanderCum.at(-1)! - wanderCum[i]!) / (0.8 * size));
    // Irregularity winds between edge crossings; it does not relocate a crossing towards a hex corner.
    const crossingDistance = ctrl.reduce((nearest, c) => c.slide ? Math.min(nearest, Math.hypot(centreline[i]!.x - c.p.x, centreline[i]!.y - c.p.y)) : nearest, Infinity);
    fade *= smoothstep(crossingDistance / (size * 0.8));
    const wander = noise(1, at / 2.0) + 0.85 * noise(2, at / 0.85 + 5) + 0.5 * noise(3, at / 0.4 + 9) + 0.14 * noise(4, at / 0.26 + 13);
    return (amplitude * envelope * fade * wander) / 2.2;
  });
  const normals = centreline.map((_, i) => {
    const a = centreline[Math.max(0, i - 1)]!;
    const b = centreline[Math.min(centreline.length - 1, i + 1)]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return { x: -(b.y - a.y) / len, y: (b.x - a.x) / len, tx: (b.x - a.x) / len, ty: (b.y - a.y) / len };
  });
  // A swing larger than the radius of a bend would fold the line back on itself
  // (a hairpin), so the swing is limited by how tightly the line turns nearby.
  const room = centreline.map((_, i) => {
    let tightest = Infinity;
    for (let k = Math.max(1, i - 3); k <= Math.min(centreline.length - 2, i + 3); k++) {
      const a = centreline[k - 1]!;
      const b = centreline[k]!;
      const c = centreline[k + 1]!;
      let turn = Math.abs(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x));
      if (turn > Math.PI) turn = 2 * Math.PI - turn;
      const run = (Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(c.x - b.x, c.y - b.y)) / 2 || 1;
      if (turn > 1e-3) tightest = Math.min(tightest, (0.35 * run) / turn);
    }
    return tightest;
  });
  // Pull back any swing that would carry the river out of its own hexes.
  const keep = centreline.map((p, i) => {
    const reach = Math.abs(offset[i]!);
    const limit = reach > room[i]! ? room[i]! / reach : 1;
    for (let f = limit; f > 0.2 * limit; f /= 2) {
      const q = { x: p.x + normals[i]!.x * offset[i]! * f, y: p.y + normals[i]!.y * offset[i]! * f };
      const h = pixelToOffset(q.x, q.y, size);
      const inSpan = !spanHexes[i] || `${h.col},${h.row}` === spanHexes[i];
      if (inSpan && inHexes(q) && (!land || land(q) || wet?.(q))) return f;
    }
    return 0;
  });
  const eased = keep.map((f, i) => {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - 3); k <= Math.min(keep.length - 1, i + 3); k++) {
      sum += keep[k]!;
      count++;
    }
    return Math.min(f, sum / count);
  });
  const line = centreline.map((p, i) => ({ x: p.x + normals[i]!.x * offset[i]! * eased[i]!, y: p.y + normals[i]!.y * offset[i]! * eased[i]! }));

  // A river that rises at a city comes out from under its icon at full width.
  const atCity = sites.some(({ p, radius }) => Math.hypot(centreline[0]!.x - p.x, centreline[0]!.y - p.y) < radius * 1.2);
  const widths = base.map((w0, i) => {
    let w = w0;
    // A spring starts as a thread that is half the normal width where it leaves its hex, and
    // reaches the normal width over the next; a distributary and a lake outflow do not.
    if (!river.branchOf && !ends.before && !atCity) {
      const d = cum[i]! / size;
      w *= d < CENTRE_TO_EDGE
        ? 0.08 + (SOURCE_EXIT_WIDTH - 0.08) * smoothstep(d / CENTRE_TO_EDGE)
        : SOURCE_EXIT_WIDTH + (1 - SOURCE_EXIT_WIDTH) * smoothstep(d - CENTRE_TO_EDGE);
    }
    // Flare over the last half hex where the river meets standing water.
    if (river.terminus === 'Sea' || river.terminus === 'Lake') {
      const fromMouth = (total - cum[i]!) / size;
      if (fromMouth < 0.7) w *= 1 + 0.6 * (1 - fromMouth / 0.7) ** 2;
    }
    return w;
  });

  // The river and the icons of the cities on its bank shape each other. An icon is set into the bank (how far
  // depends on the city's stance, `riverStance`), and the river bows out round it, keeping clear of all but a
  // fraction of its reach, so the course curves with the icon's rim; the icon itself is drawn whole. The icon of a
  // city that straddles the river stands on the line, and the river is left as it is.
  const icons: Array<{ id: string; at: Point }> = [];
  for (const city of ends.cities ?? []) {
    if (!city.icon || !city.id) continue;
    let k = -1;
    let nearest = size * 0.8;
    line.forEach((q, i) => {
      const dq = Math.hypot(q.x - city.at.x, q.y - city.at.y);
      if (dq <= nearest) {
        nearest = dq;
        k = i;
      }
    });
    if (k < 1 || k > line.length - 2) continue;
    if (city.icon.straddle) {
      // Stood so the middle of the icon, not its site, is on the river.
      icons.push({ id: city.id, at: { x: line[k]!.x, y: line[k]!.y + (city.icon.dy ?? 0) } });
      continue;
    }
    const a = line[k - 1]!;
    const b = line[k + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const setIn = widths[k]! / 2 + city.icon.reach * (city.icon.setIn ?? SET_IN);
    // The bank that is land, else one the city's id picks.
    const parity = [...city.id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 0) % 2 === 0 ? 1 : -1;
    const sides = [parity, -parity];
    const side = sides.find((sd) => !ends.onLand || ends.onLand({ x: line[k]!.x + nx * sd * setIn, y: line[k]!.y + ny * sd * setIn })) ?? parity;
    const m = { x: line[k]!.x + nx * side * setIn, y: line[k]!.y + ny * side * setIn };
    icons.push({ id: city.id, at: m });
    const clear = (i: number) => city.icon!.reach * (1 - (city.icon!.press ?? PRESS)) + widths[i]! / 2;
    const push = (i: number) => {
      const p = line[i]!;
      const d = Math.hypot(p.x - m.x, p.y - m.y);
      const need = clear(i);
      if (d >= need) return false;
      const u = d < 1e-6 ? { x: -nx * side, y: -ny * side } : { x: (p.x - m.x) / d, y: (p.y - m.y) / d };
      line[i] = { x: m.x + u.x * need, y: m.y + u.y * need };
      return true;
    };
    const moved: number[] = [];
    for (let i = 1; i < line.length - 1; i++) if (push(i)) moved.push(i);
    if (moved.length === 0) continue;
    // Ease the bow into the course either side, then keep it clear of the icon again.
    const lo = Math.max(1, moved[0]! - 16);
    const hi = Math.min(line.length - 2, moved[moved.length - 1]! + 16);
    for (let pass = 0; pass < 10; pass++) {
      for (let i = lo; i <= hi; i++) line[i] = { x: (line[i - 1]!.x + 2 * line[i]!.x + line[i + 1]!.x) / 4, y: (line[i - 1]!.y + 2 * line[i]!.y + line[i + 1]!.y) / 4 };
      for (let i = lo; i <= hi; i++) push(i);
    }
  }

  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)]!;
    const b = line[Math.min(line.length - 1, i + 1)]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const h = widths[i]! / 2;
    const p = line[i]!;
    left.push({ x: p.x + nx * h, y: p.y + ny * h });
    right.push({ x: p.x - nx * h, y: p.y - ny * h });
  }
  // Round caps: a half circle round the first and last point.
  const last = line.length - 1;
  const capAt = (i: number, sign: 1 | -1): Point[] => {
    const a = line[Math.max(0, i - 1)]!;
    const b = line[Math.min(last, i + 1)]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const tx = (b.x - a.x) / len;
    const ty = (b.y - a.y) / len;
    const h = widths[i]! / 2;
    const out: Point[] = [];
    for (let k = 1; k < CAP_STEPS; k++) {
      const phi = (Math.PI * k) / CAP_STEPS;
      // From the left side round the front (sign 1) or back (-1) to the right side.
      out.push({
        x: line[i]!.x + h * (-ty * Math.cos(phi) + sign * tx * Math.sin(phi)),
        y: line[i]!.y + h * (tx * Math.cos(phi) + sign * ty * Math.sin(phi)),
      });
    }
    return out;
  };
  // A river into the sea is cut square at the shore rather than rounded off into the water.
  const endCap = land && river.terminus === 'Sea' && !ends.beyond ? [] : capAt(last, 1);
  const startCap = capAt(0, -1);
  const outline: PathCmd[] = [];
  left.forEach((p, i) => outline.push([i === 0 ? 'M' : 'L', p.x, p.y]));
  for (const p of endCap) outline.push(['L', p.x, p.y]);
  for (let i = right.length - 1; i >= 0; i--) outline.push(['L', right[i]!.x, right[i]!.y]);
  for (const p of [...startCap].reverse()) outline.push(['L', p.x, p.y]);
  outline.push(['Z']);
  // The bank runs up the left side, round the spring, and down the right,
  // and is left open at the mouth so it does not close the river off from the water.
  // A river that comes out of a lake is open at its start too.
  const bank = river.branchOf || ends.before ? [left, right] : [[...left].reverse().concat(startCap, right)];
  return { centreline: line, widths, outline, bank, icons };
}

/**
 * Whether a point is land, judged by the coast as drawn. The coast lines are
 * oriented with the land on their right (as `drawnLand` relies on), so near a
 * line the side a point falls on says whether it is land, however the coast
 * has been reshaped, smoothed or roughened. Away from every line (further than
 * `reach`) the answer is `elsewhere`'s, which knows only the hexes.
 */
export function landBySide(lines: Point[][], reach: number, elsewhere: (p: Point) => boolean): (p: Point) => boolean {
  const cell = reach;
  const grid = new Map<string, Array<[Point, Point]>>();
  const add = (cx: number, cy: number, seg: [Point, Point]) => {
    const key = `${cx},${cy}`;
    const list = grid.get(key);
    if (list) list.push(seg);
    else grid.set(key, [seg]);
  };
  for (const line of lines) {
    for (let k = 0; k + 1 < line.length; k++) {
      const a = line[k]!;
      const b = line[k + 1]!;
      // File the segment under every cell its box touches, so a query looks in one.
      const x0 = Math.floor((Math.min(a.x, b.x) - reach) / cell);
      const x1 = Math.floor((Math.max(a.x, b.x) + reach) / cell);
      const y0 = Math.floor((Math.min(a.y, b.y) - reach) / cell);
      const y1 = Math.floor((Math.max(a.y, b.y) + reach) / cell);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) add(cx, cy, [a, b]);
    }
  }
  return (p) => {
    let best = reach;
    let side = 0;
    for (const [a, b] of grid.get(`${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`) ?? []) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy || 1e-9;
      const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      const d = Math.hypot(p.x - (a.x + dx * u), p.y - (a.y + dy * u));
      if (d < best) {
        best = d;
        side = dx * (p.y - a.y) - dy * (p.x - a.x);
      }
    }
    return side !== 0 ? side > 0 : elsewhere(p);
  };
}

/** The point of `line` nearest `p`. */
function nearest(line: Point[], p: Point): Point {
  let best = line[0]!;
  let d = Infinity;
  for (const q of line) {
    const dq = Math.hypot(q.x - p.x, q.y - p.y);
    if (dq < d) {
      d = dq;
      best = q;
    }
  }
  return best;
}

/**
 * Courses for a whole river network. A tributary (one with `joins`, or one
 * that ends in another river's hex) is laid out after its river, so it can end
 * on that river's drawn line, and that river widens below the confluence by
 * the tributary's water. A river that cannot find its host ends at the hex
 * centre, as a river that runs nowhere does. `lakeEnds` supplies points in the
 * lakes a river flows out of or into, and the test for being in their water.
 * `cities` lists the cities standing on rivers.
 */
export function riverCourses(
  rivers: River[],
  size: number,
  seed: string,
  lakeEnds: (river: River) => Pick<CourseEnds, 'before' | 'beyond' | 'inWater' | 'onLand'> = () => ({}),
  cities: Array<{ riverId: string; at: Point; radius: number; id?: string; icon?: { reach: number; straddle: boolean; setIn?: number; press?: number; dy?: number } }> = [],
  wander: RiverWander = 'normal',
): Map<string, RiverCourse> {
  const out = new Map<string, RiverCourse>();
  const key = (col: number, row: number) => `${col},${row}`;
  // Which rivers flow on through each hex (rather than ending in it).
  const through = new Map<string, string[]>();
  for (const r of rivers) {
    for (const s of r.segments) {
      if (s.exitEdge === null) continue;
      const k = key(s.col, s.row);
      through.set(k, [...(through.get(k) ?? []), r.id]);
    }
  }
  const byId = new Map(rivers.map((r) => [r.id, r]));
  /** The river `r` flows into, if any: the one it names, or one running through its last hex. */
  const hostOf = (r: River): string | null => {
    const last = r.segments.at(-1);
    if (!last || last.exitEdge !== null) return null;
    if (r.joins && byId.has(r.joins) && r.joins !== r.id) return r.joins;
    return (through.get(key(last.col, last.row)) ?? []).find((id) => id !== r.id) ?? null;
  };
  const tributaries = new Map<string, River[]>();
  for (const r of rivers) {
    const host = hostOf(r);
    if (host) tributaries.set(host, [...(tributaries.get(host) ?? []), r]);
  }
  // The longest river's own length (not its tributaries'): it sets how much distance from the source widens a river.
  const longest = Math.max(0, ...rivers.map((r) => r.segments.length * Math.sqrt(3) * size));
  const pending = new Set(rivers.map((r) => r.id));
  const needs = (r: River): string[] => {
    const deps: string[] = [];
    const host = hostOf(r);
    if (host) deps.push(host);
    if (r.branchOf && byId.has(r.branchOf)) deps.push(r.branchOf);
    return deps;
  };
  const lay = (r: River) => {
    pending.delete(r.id);
    const first = r.segments[0];
    const last = r.segments.at(-1);
    const ends: CourseEnds = {
      ...lakeEnds(r),
      cities: cities.filter((c) => c.riverId === r.id),
      wander,
      longest,
      inflows: (tributaries.get(r.id) ?? []).map((t) => {
        const end = t.segments.at(-1)!;
        return { at: hexCenter(end.col, end.row, size) };
      }),
    };
    if (first && first.entryEdge === null && r.branchOf) {
      const parent = out.get(r.branchOf);
      if (parent) ends.start = nearest(parent.centreline, hexCenter(first.col, first.row, size));
    }
    const host = hostOf(r);
    if (last && host) {
      const course = out.get(host);
      if (course) {
        ends.end = nearest(course.centreline, hexCenter(last.col, last.row, size));
        const at = course.centreline.indexOf(ends.end);
        const a = course.centreline[Math.max(0, at - 2)]!;
        const b = course.centreline[Math.min(course.centreline.length - 1, at + 2)]!;
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (len > 0) ends.joinTangent = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      }
    }
    const course = riverCourse(r, size, seed, ends);
    if (course) out.set(r.id, course);
  };
  // Lay out every river whose hosts are ready; when a cycle leaves none ready,
  // lay out the next one regardless.
  while (pending.size > 0) {
    const ready = [...pending].map((id) => byId.get(id)!).filter((r) => needs(r).every((d) => !pending.has(d) || d === r.id));
    for (const r of ready.length > 0 ? ready : [byId.get(pending.values().next().value!)!]) lay(r);
  }
  return out;
}
