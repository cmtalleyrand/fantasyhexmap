/**
 * A city on a river and its river shape each other.
 *
 * The river bows round the icon (see `rivers.ts`), and the icon is pressed
 * against the river: any part of it that would lie in the water is slid onto
 * the bank, so its silhouette follows the river's own bank line, whatever
 * curve that has. An icon standing on the river (a metropolis) is parted along
 * it, its halves pressed to either bank.
 */

import type { Point } from '../../shared/hex.js';
import type { PathCmd, Prim } from './prims.js';

export interface Reach {
  /** The river's drawn centreline, and its width at each point. */
  line: Point[];
  widths: number[];
}

/** The point of `reach` nearest `p`, with its distance, its half width and which side of the river `p` is on. */
function nearest(reach: Reach, p: Point): { q: Point; d: number; half: number; side: 1 | -1; n: Point } {
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
