/**
 * A city on a river and its river shape each other.
 *
 * An icon is always drawn whole, on top of the water: it is never cut, squashed
 * or parted. How it sits with its river is a style choice (`CityRiver`):
 * beside the river, which bows round it; over the bank, with the river passing
 * behind; beside the river with a bridge across to the far bank; or on an islet
 * the river splits round. The first two only need the river bowed (or not) and
 * the icon placed (`RIVER_STANCE`, used by `rivers.ts`); the other two draw a
 * little scenery under the icon (`riverCityScenery`).
 *
 * `pressIcon` (an older treatment that slid every point of the icon in the water
 * onto the bank, so its silhouette followed the bank line) is kept for its tests;
 * it distorted small icons into slivers and is no longer used to draw them.
 */

import type { Point } from '../../shared/hex.js';
import type { PathCmd, Prim } from './prims.js';

export interface Reach {
  /** The river's drawn centreline, and its width at each point. */
  line: Point[];
  widths: number[];
}

/** The point of `reach` nearest `p`, with its distance, its half width and which side of the river `p` is on. */
export function nearest(reach: Reach, p: Point): { q: Point; d: number; half: number; side: 1 | -1; n: Point } {
  const { line, widths } = reach;
  let best = { q: line[0]!, d: Infinity, half: (widths[0] ?? 0) / 2, side: 1 as 1 | -1, n: { x: 0, y: 1 } };
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1e-9;
    const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    const q = { x: a.x + dx * u, y: a.y + dy * u };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.d) {
      const len = Math.sqrt(len2);
      const n = { x: -dy / len, y: dx / len };
      best = { q, d, half: ((widths[i] ?? 0) + ((widths[i + 1] ?? widths[i] ?? 0) - (widths[i] ?? 0)) * u) / 2, side: (p.x - q.x) * n.x + (p.y - q.y) * n.y >= 0 ? 1 : -1, n };
    }
  }
  return best;
}

/**
 * `p` squashed against the river's bank: shifted across the river's own direction until it stands `gap` clear
 * of the water, keeping its place along the river, so an icon's edge takes the bank's line without folding.
 * `side` is the bank the icon stands on; without it each point goes to the bank it is nearer (so an icon on the
 * river is parted). A point already on land is unchanged.
 */
export function pressPoint(reach: Reach, p: Point, gap: number, side?: 1 | -1): Point {
  const near = nearest(reach, p);
  const s = side ?? near.side;
  const clear = near.half + gap;
  const across = ((p.x - near.q.x) * near.n.x + (p.y - near.q.y) * near.n.y) * s;
  if (across >= clear) return p;
  return { x: p.x + near.n.x * s * (clear - across), y: p.y + near.n.y * s * (clear - across) };
}

const CIRCLE_STEPS = 36;

/** Points of a path's subpaths, with each segment cut into steps no longer than `step`. */
function flatten(d: PathCmd[], step: number): Array<{ points: Point[]; closed: boolean }> {
  const out: Array<{ points: Point[]; closed: boolean }> = [];
  let cur: { points: Point[]; closed: boolean } | null = null;
  for (const cmd of d) {
    if (cmd[0] === 'M') {
      cur = { points: [{ x: cmd[1] as number, y: cmd[2] as number }], closed: false };
      out.push(cur);
    } else if (cmd[0] === 'L' && cur) {
      const from = cur.points[cur.points.length - 1]!;
      const to = { x: cmd[1] as number, y: cmd[2] as number };
      const n = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / step));
      for (let k = 1; k <= n; k++) cur.points.push({ x: from.x + ((to.x - from.x) * k) / n, y: from.y + ((to.y - from.y) * k) / n });
    } else if (cmd[0] === 'Z' && cur) {
      cur.closed = true;
    }
  }
  return out;
}

/**
 * `prims` (an icon's circles, paths and polygons) pressed against the river:
 * every point that would lie in the water is slid onto the bank, so the icon's
 * edge follows the bank line. Circles become polygons so they can bend; `step`
 * is how finely edges are cut to follow a curve. `centre` is the icon's centre: an icon standing on
 * the bank is squashed against it, one standing on the river is parted.
 */
export function pressIcon(prims: Prim[], reach: Reach, gap: number, step: number, centre?: Point): Prim[] {
  // The bank the icon stands on, from its centre; an icon centred on the river is parted instead.
  const bank = centre ? nearest(reach, centre) : null;
  const side = bank && ((centre!.x - bank.q.x) * bank.n.x + (centre!.y - bank.q.y) * bank.n.y !== 0 && bank.d > bank.half * 0.5) ? bank.side : undefined;
  const press = (pts: Point[]) => pts.map((p) => pressPoint(reach, p, gap, side));
  const toPath = (subs: Array<{ points: Point[]; closed: boolean }>): PathCmd[] =>
    subs.flatMap(({ points, closed }) => [
      ...points.map((p, k) => [k === 0 ? 'M' : 'L', p.x, p.y] as PathCmd),
      ...(closed ? ([['Z']] as PathCmd[]) : []),
    ]);
  return prims.map((prim): Prim => {
    switch (prim.kind) {
      case 'circle': {
        if (prim.fill === undefined && prim.stroke === undefined) return prim;
        const pts = Array.from({ length: CIRCLE_STEPS }, (_, k) => ({ x: prim.c.x + Math.cos((k * 2 * Math.PI) / CIRCLE_STEPS) * prim.r, y: prim.c.y + Math.sin((k * 2 * Math.PI) / CIRCLE_STEPS) * prim.r }));
        return { kind: 'polygon', points: press(pts), fill: prim.fill, stroke: prim.stroke, strokeWidth: prim.strokeWidth };
      }
      case 'path':
        return { ...prim, d: toPath(flatten(prim.d, step).map((s) => ({ ...s, points: press(s.points) }))) };
      case 'polygon':
        return { ...prim, points: press(prim.points) };
      case 'polyline':
        return { ...prim, points: press(prim.points) };
      default:
        return prim;
    }
  });
}

/** How far into the bank an icon is set, as a fraction of its reach (the river then bows round it and presses it). */
export const SET_IN = 0.4;
/** How much of its reach an icon yields to the river that bows round it. */
export const PRESS = 0.12;

/** How a city's icon sits with the river it stands on. */
export type CityRiver = 'beside' | 'overlay' | 'bridge' | 'islet';

export interface RiverStance {
  /** Whether the icon stands on the river's own line (the river is left as it is) rather than on a bank. */
  straddle: boolean;
  /** How far the icon is set into the bank, as a fraction of its reach (1: its edge touches the bank, no more). */
  setIn: number;
  /** How much of its reach the icon yields to the river that bows round it (1: the river does not bow at all). */
  press: number;
}

export const RIVER_STANCE: Record<CityRiver, RiverStance> = {
  beside: { straddle: false, setIn: 1, press: 0 },
  overlay: { straddle: false, setIn: 0.35, press: 1 },
  bridge: { straddle: false, setIn: 1, press: 0 },
  islet: { straddle: true, setIn: 0, press: 0 },
};

/** The part of `reach` within `half` of the river along its length of `p`: each point with its unit normal and signed distance along. */
function slice(reach: Reach, p: Point, half: number): Array<{ p: Point; n: Point; s: number; w: number }> {
  const { line, widths } = reach;
  let k = 0;
  let d = Infinity;
  line.forEach((q, i) => {
    const dq = Math.hypot(q.x - p.x, q.y - p.y);
    if (dq < d) {
      d = dq;
      k = i;
    }
  });
  const out: Array<{ p: Point; n: Point; s: number; w: number }> = [];
  const at = (i: number, s: number) => {
    // The direction over a few samples either side, so the edges drawn from it do not jitter with the line.
    const a = line[Math.max(0, i - 4)]!;
    const b = line[Math.min(line.length - 1, i + 4)]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    out.push({ p: line[i]!, n: { x: -(b.y - a.y) / len, y: (b.x - a.x) / len }, s, w: widths[i] ?? widths[0] ?? 0 });
  };
  at(k, 0);
  for (const dir of [-1, 1]) {
    let s = 0;
    for (let i = k + dir; i >= 0 && i < line.length; i += dir) {
      s += Math.hypot(line[i]!.x - line[i - dir]!.x, line[i]!.y - line[i - dir]!.y);
      if (s > half) break;
      at(i, s * dir);
    }
  }
  return out.sort((a, b) => a.s - b.s);
}

/**
 * What is drawn under a city's icon, over the river: nothing for the modes that only place the icon; for a bridge,
 * a deck across the river in front of the icon; for an islet, the river parted round an island under the icon.
 * `c` is the icon's site, `reachR` how far the icon reaches, `bankW` the width of the bank line.
 */
export function riverCityScenery(
  mode: CityRiver,
  c: Point,
  reachR: number,
  reach: Reach,
  colours: { ink: string; paper: string; river: string; bank: string },
  bankW: number,
): Prim[] {
  if (mode === 'bridge') {
    const near = nearest(reach, c);
    const t = { x: near.n.y, y: -near.n.x };
    // From the icon's bank across to a little way past the far one, a paper deck outlined in ink, as a map draws a bridge.
    const out = near.half + reachR * 0.6;
    const back = near.side * (near.half + reachR * 0.3);
    const half = Math.max(1.2, reachR * 0.2);
    const corner = (across: number, along: number): Point => ({ x: near.q.x + near.n.x * across + t.x * along, y: near.q.y + near.n.y * across + t.y * along });
    return [{
      kind: 'polygon',
      points: [corner(back, -half), corner(-near.side * out, -half), corner(-near.side * out, half), corner(back, half)],
      fill: colours.paper,
      stroke: colours.ink,
      strokeWidth: Math.max(0.7, reachR * 0.08),
    }];
  }
  if (mode !== 'islet') return [];
  // The water swells into a lens, along the river's own line, round an island of paper under the icon.
  const lens = 1.8 * reachR;
  const isle = 1.25 * reachR;
  const bank = slice(reach, c, lens);
  if (bank.length < 3) return [];
  const swell = (s: number, l: number) => Math.max(0, 1 - (s / l) ** 2) ** 0.6;
  const channel = (w: number) => Math.max(w * 0.6, reachR * 0.2);
  const side = (sign: 1 | -1, width: (b: (typeof bank)[number]) => number): Point[] => bank.map((b) => ({ x: b.p.x + b.n.x * sign * width(b), y: b.p.y + b.n.y * sign * width(b) }));
  const water = (b: (typeof bank)[number]) => b.w / 2 + (reachR * 0.85 + channel(b.w) - b.w / 2) * swell(b.s, lens);
  const left = side(1, water);
  const right = side(-1, water);
  const isleOf = bank.filter((b) => Math.abs(b.s) < isle);
  const land = (b: (typeof bank)[number]) => reachR * 0.85 * swell(b.s, isle);
  const isleLeft = isleOf.map((b) => ({ x: b.p.x + b.n.x * land(b), y: b.p.y + b.n.y * land(b) }));
  const isleRight = isleOf.map((b) => ({ x: b.p.x - b.n.x * land(b), y: b.p.y - b.n.y * land(b) }));
  return [
    { kind: 'polyline', points: left, stroke: colours.bank, strokeWidth: bankW, round: true },
    { kind: 'polyline', points: right, stroke: colours.bank, strokeWidth: bankW, round: true },
    { kind: 'polygon', points: [...left, ...right.reverse()], fill: colours.river },
    { kind: 'polygon', points: [...isleLeft, ...isleRight.reverse()], fill: colours.paper, stroke: colours.bank, strokeWidth: bankW },
  ];
}
