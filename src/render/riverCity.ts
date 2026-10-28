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
 */

import type { Point } from '../../shared/hex.js';
import { polygonPath, type CitySymbol, type PathCmd, type Prim } from './prims.js';

export interface Reach {
  /** The river's drawn centreline, and its width at each point. */
  line: Point[];
  widths: number[];
}

/** How far into the bank an icon is set, as a fraction of its reach (the river then bows round it and presses it). */
export const SET_IN = 0.4;
/** How much of its reach an icon yields to the river that bows round it. */
export const PRESS = 0.12;

/**
 * How a city's icon sits with the river it stands on: beside it (the river bows round the whole icon), over the
 * bank (the river runs unbowed behind the icon), or, for the two larger icons, standing on the river with its
 * course shown through the icon: as a faint outline (`outline`) or as a translucent band of water (`wash`). The
 * smaller icons stand beside the river in those two modes.
 */
export type CityRiver = 'beside' | 'overlay' | 'outline' | 'wash';

export interface RiverStance {
  /** Whether the icon stands on the river's own line (the river is left as it is) rather than on a bank. */
  straddle: boolean;
  /** How far the icon is set into the bank, as a fraction of its reach (1: its edge touches the bank, no more). */
  setIn: number;
  /** How much of its reach the icon yields to the river that bows round it (1: the river does not bow at all). */
  press: number;
}

const BESIDE: RiverStance = { straddle: false, setIn: 1, press: 0 };
const ON_RIVER: RiverStance = { straddle: true, setIn: 0, press: 0 };

/** Whether an icon of this size is large enough to show the river through it. */
export const showsRiver = (symbol: CitySymbol): boolean => symbol === 'city' || symbol === 'metropolis';

export function riverStance(mode: CityRiver, symbol: CitySymbol): RiverStance {
  if (mode === 'overlay') return { straddle: false, setIn: 0.35, press: 1 };
  if ((mode === 'outline' || mode === 'wash') && showsRiver(symbol)) return ON_RIVER;
  return BESIDE;
}

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

/** The outline of everything an icon fills, as one path (circles as polygons), to clip the river to it. */
function silhouette(prims: Prim[]): PathCmd[] {
  const out: PathCmd[] = [];
  for (const prim of prims) {
    if (prim.kind === 'path' && prim.fill !== undefined) out.push(...prim.d);
    else if (prim.kind === 'polygon' && prim.fill !== undefined) out.push(...polygonPath(prim.points));
    else if (prim.kind === 'circle' && prim.fill !== undefined) {
      out.push(...polygonPath(Array.from({ length: 24 }, (_, k) => ({ x: prim.c.x + Math.cos((k * Math.PI) / 12) * prim.r, y: prim.c.y + Math.sin((k * Math.PI) / 12) * prim.r }))));
    }
  }
  return out;
}

/**
 * The river's course through a larger icon, drawn over it and clipped to its silhouette, so the icon stays whole:
 * `outline` draws the river's two banks as faint lines, `wash` a translucent band of water, both in `tone` (a
 * water colour that shows against the icon). `icon` is the icon's primitives, `c` its site and `reachR` how far it
 * reaches. Nothing for the other modes or for a smaller icon.
 */
export function riverThroughIcon(
  mode: CityRiver,
  icon: Prim[],
  c: Point,
  reachR: number,
  reach: Reach,
  tone: { river: string },
  bankW: number,
): Prim[] {
  if (mode !== 'outline' && mode !== 'wash') return [];
  const clip = silhouette(icon);
  const bank = slice(reach, c, reachR * 1.8);
  if (clip.length === 0 || bank.length < 2) return [];
  const edge = (sign: 1 | -1): Point[] => bank.map((b) => ({ x: b.p.x + b.n.x * sign * (b.w / 2), y: b.p.y + b.n.y * sign * (b.w / 2) }));
  const left = edge(1);
  const right = edge(-1);
  if (mode === 'wash') {
    return [{ kind: 'group', clip, opacity: 0.8, prims: [{ kind: 'polygon', points: [...left, ...right.reverse()], fill: tone.river }] }];
  }
  return [{
    kind: 'group',
    clip,
    opacity: 0.85,
    prims: [left, right].map((points): Prim => ({ kind: 'polyline', points, stroke: tone.river, strokeWidth: Math.max(0.8, bankW), round: true })),
  }];
}
