/**
 * River courses for the tapered style.
 *
 * A river's course is a centripetal Catmull-Rom spline through the midpoint of
 * every edge it crosses and a point near each hex centre. The edge midpoints
 * are fixed, so a river still crosses exactly the edges the data says it does
 * and a tributary still meets its trunk on the shared edge. Only the centre
 * point moves, by a seeded amount of at most a fifth of a hex, which is what
 * makes a straight run of hexes meander. The river is then drawn as a filled
 * outline whose width grows with distance from the source, steps up (smoothly)
 * where the river becomes navigable, and flares at a mouth into sea or lake.
 */

import { hexCenter, hexEdgeMidpoint, type Point } from '../../shared/hex.js';
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

const JITTER = 0.2;
const SAMPLES_PER_SPAN = 6;

interface Control {
  p: Point;
  navigable: boolean;
}

function controls(river: River, size: number, seed: string): Control[] {
  const out: Control[] = [];
  const push = (p: Point, navigable: boolean) => {
    const last = out[out.length - 1];
    if (last && Math.abs(last.p.x - p.x) < 1e-6 && Math.abs(last.p.y - p.y) < 1e-6) {
      last.navigable ||= navigable;
      return;
    }
    out.push({ p, navigable });
  };
  for (const s of river.segments) {
    if (s.entryEdge !== null) push(hexEdgeMidpoint(s.col, s.row, s.entryEdge, size), s.navigable);
    const c = hexCenter(s.col, s.row, size);
    // Keyed by the hex, not the river, so rivers sharing a hex share its bend.
    const dx = signed(seed, 'river', s.col, s.row, 'x') * JITTER * size;
    const dy = signed(seed, 'river', s.col, s.row, 'y') * JITTER * size;
    push({ x: c.x + dx, y: c.y + dy }, s.navigable);
    if (s.exitEdge !== null) push(hexEdgeMidpoint(s.col, s.row, s.exitEdge, size), s.navigable);
  }
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

export function riverCourse(river: River, size: number, seed: string): RiverCourse | null {
  const ctrl = controls(river, size, seed);
  if (ctrl.length < 2) return null;
  const pts = ctrl.map((c) => c.p);
  // Reflect the ends so the first and last spans have a tangent to follow.
  const before = { x: 2 * pts[0]!.x - pts[1]!.x, y: 2 * pts[0]!.y - pts[1]!.y };
  const n = pts.length;
  const after = { x: 2 * pts[n - 1]!.x - pts[n - 2]!.x, y: 2 * pts[n - 1]!.y - pts[n - 2]!.y };
  const ext = [before, ...pts, after];

  const centreline: Point[] = [pts[0]!];
  const navigable: boolean[] = [ctrl[0]!.navigable];
  for (let i = 0; i < n - 1; i++) {
    const samples = catmullRom(ext[i]!, ext[i + 1]!, ext[i + 2]!, ext[i + 3]!, SAMPLES_PER_SPAN);
    // A span is navigable only if both its ends are, so the river widens at the
    // first fully navigable stretch rather than half a hex early.
    const nav = ctrl[i]!.navigable && ctrl[i + 1]!.navigable;
    for (const p of samples) {
      centreline.push(p);
      navigable.push(nav);
    }
  }

  const cum = [0];
  for (let i = 1; i < centreline.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(centreline[i]!.x - centreline[i - 1]!.x, centreline[i]!.y - centreline[i - 1]!.y));
  }
  const total = cum[cum.length - 1]!;
  // A distributary leaves a river that is already full grown.
  const head = river.branchOf ? 8 * size : 0;
  const target = centreline.map((_, i) => {
    const run = (cum[i]! + head) / size;
    const narrow = Math.min(0.15, 0.04 + 0.011 * run);
    return navigable[i] ? Math.min(0.3, Math.max(narrow, 0.19 + 0.004 * run)) : narrow;
  });
  // Ease the step into navigable water over about half a hex.
  const window = Math.max(1, Math.round(SAMPLES_PER_SPAN));
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
