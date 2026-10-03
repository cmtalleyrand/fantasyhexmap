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
 * The river is drawn as a filled outline whose width grows with distance from
 * the source, steps up (smoothly) where it becomes navigable, and flares at a
 * mouth into sea or lake.
 */

import { canonicalEdgeId, hexCenter, hexEdgePoints, type Point } from '../../shared/hex.js';
import type { River } from '../../shared/types.js';
import type { PathCmd } from './prims.js';
import { signed } from './seed.js';

export interface RiverCourse {
  /** Dense points along the centre of the river, source to mouth. */
  centreline: Point[];
  /** Width of the river at each centreline point. */
  widths: number[];
  outline: PathCmd[];
}

/** How far a crossing may slide from the edge midpoint, as a fraction of the edge. */
const SLIDE = 0.25;
const SAMPLES_PER_SPAN = 8;

/** Where rivers cross the edge `edge` of hex (col, row): the same point from either side. */
export function edgeCrossing(col: number, row: number, edge: number, size: number, seed: string): Point {
  const id = canonicalEdgeId(col, row, edge);
  const m = /^(-?\d+),(-?\d+):(\d)$/.exec(id)!;
  const [a, b] = hexEdgePoints(Number(m[1]), Number(m[2]), Number(m[3]), size);
  const t = 0.5 + signed(seed, 'crossing', id) * SLIDE;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

interface Control {
  p: Point;
  /** Navigability of the span that ends at this point. */
  navigable: boolean;
}

export interface CourseEnds {
  /** Where the river starts, if not its source hex's centre (a distributary's fork). */
  start?: Point | null;
  /** Where the river ends, if it ends inside a hex (a tributary's confluence). */
  end?: Point | null;
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
  /** Rivers flowing in along the way: the length upstream of each, added to the width below where it joins. */
  inflows?: Array<{ at: Point; run: number }>;
}

function controls(river: River, size: number, seed: string, ends: CourseEnds): Control[] {
  const out: Control[] = [];
  const push = (p: Point, navigable: boolean) => {
    const last = out[out.length - 1];
    if (last && Math.hypot(last.p.x - p.x, last.p.y - p.y) < size * 0.02) return;
    out.push({ p, navigable });
  };
  if (ends.before && river.segments[0]) push(ends.before, river.segments[0].navigable);
  river.segments.forEach((s, k) => {
    if (s.entryEdge !== null) push(edgeCrossing(s.col, s.row, s.entryEdge, size, seed), s.navigable);
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
    if (s.exitEdge !== null) push(edgeCrossing(s.col, s.row, s.exitEdge, size, seed), s.navigable);
    else if (k === river.segments.length - 1) {
      push(ends.end ?? hexCenter(s.col, s.row, size), s.navigable);
    }
  });
  const last = river.segments.at(-1);
  if (ends.beyond && last) push(ends.beyond, last.navigable);
  return out;
}

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

export function riverCourse(river: River, size: number, seed: string, ends: CourseEnds = {}): RiverCourse | null {
  const ctrl = controls(river, size, seed, ends);
  if (ctrl.length < 2) return null;
  const pts = ctrl.map((c) => c.p);
  // Reflect the ends so the first and last spans have a tangent to follow.
  const n = pts.length;
  const before = { x: 2 * pts[0]!.x - pts[1]!.x, y: 2 * pts[0]!.y - pts[1]!.y };
  const after = { x: 2 * pts[n - 1]!.x - pts[n - 2]!.x, y: 2 * pts[n - 1]!.y - pts[n - 2]!.y };
  const ext = [before, ...pts, after];

  let centreline: Point[] = [pts[0]!];
  let navigable: boolean[] = [ctrl[0]!.navigable];
  for (let i = 0; i < n - 1; i++) {
    for (const p of catmullRom(ext[i]!, ext[i + 1]!, ext[i + 2]!, ext[i + 3]!, SAMPLES_PER_SPAN)) {
      centreline.push(p);
      navigable.push(ctrl[i + 1]!.navigable);
    }
  }
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
      const tail = to < centreline.length - 1 ? [shore(centreline[to + 1]!, centreline[to]!)] : [];
      centreline = [...head, ...centreline.slice(from, to + 1), ...tail];
      navigable = [
        ...(head.length ? [navigable[from]!] : []),
        ...navigable.slice(from, to + 1),
        ...(tail.length ? [navigable[to]!] : []),
      ];
    }
    if (centreline.length < 2) return null;
  }

  const cum = [0];
  for (let i = 1; i < centreline.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(centreline[i]!.x - centreline[i - 1]!.x, centreline[i]!.y - centreline[i - 1]!.y));
  }
  const total = cum[cum.length - 1]!;
  // A distributary leaves a river that is already full grown.
  const head = river.branchOf ? 8 * size : 0;
  // Below each confluence the river carries its tributary's water too.
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
    for (let i = k; i < added.length; i++) added[i]! += inflow.run;
  }
  const target = centreline.map((_, i) => {
    const run = (cum[i]! + head + added[i]!) / size;
    const narrow = Math.min(0.15, 0.04 + 0.011 * run);
    return navigable[i] ? Math.min(0.3, Math.max(narrow, 0.19 + 0.004 * run)) : narrow;
  });
  // Ease the step into navigable water over about half a hex.
  const window = Math.round(SAMPLES_PER_SPAN * 0.75);
  const widths = target.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - window); k <= Math.min(target.length - 1, i + window); k++) {
      sum += target[k]!;
      count++;
    }
    let w = (sum / count) * size;
    // Flare over the last half hex where the river meets standing water.
    if (river.terminus === 'Sea' || river.terminus === 'Lake') {
      const fromMouth = (total - cum[i]!) / size;
      if (fromMouth < 0.6) w *= 1 + 0.9 * (1 - fromMouth / 0.6) ** 2;
    }
    return w;
  });

  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < centreline.length; i++) {
    const a = centreline[Math.max(0, i - 1)]!;
    const b = centreline[Math.min(centreline.length - 1, i + 1)]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const h = widths[i]! / 2;
    const p = centreline[i]!;
    left.push({ x: p.x + nx * h, y: p.y + ny * h });
    right.push({ x: p.x - nx * h, y: p.y - ny * h });
  }
  const outline: PathCmd[] = [];
  left.forEach((p, i) => outline.push([i === 0 ? 'M' : 'L', p.x, p.y]));
  for (let i = right.length - 1; i >= 0; i--) outline.push(['L', right[i]!.x, right[i]!.y]);
  outline.push(['Z']);
  return { centreline, widths, outline };
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
 */
export function riverCourses(
  rivers: River[],
  size: number,
  seed: string,
  lakeEnds: (river: River) => Pick<CourseEnds, 'before' | 'beyond' | 'inWater'> = () => ({}),
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
  /** Length of a river and everything flowing into it, roughly, from its hex count. */
  const upstream = (r: River, seen = new Set<string>()): number => {
    if (seen.has(r.id)) return 0;
    seen.add(r.id);
    const own = r.segments.length * Math.sqrt(3) * size;
    return own + (tributaries.get(r.id) ?? []).reduce((sum, t) => sum + upstream(t, seen), 0);
  };
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
      inflows: (tributaries.get(r.id) ?? []).map((t) => {
        const end = t.segments.at(-1)!;
        return { at: hexCenter(end.col, end.row, size), run: upstream(t) };
      }),
    };
    if (first && first.entryEdge === null && r.branchOf) {
      const parent = out.get(r.branchOf);
      if (parent) ends.start = nearest(parent.centreline, hexCenter(first.col, first.row, size));
    }
    const host = hostOf(r);
    if (last && host) {
      const course = out.get(host);
      if (course) ends.end = nearest(course.centreline, hexCenter(last.col, last.row, size));
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
