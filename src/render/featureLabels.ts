/**
 * Name placement for rivers and mountain ranges.
 *
 * Both are laid out as a single rotated line of text. A river's name runs
 * along the straightest stretch of its course that is long enough to carry it;
 * a range's name sits on the range's own hexes, turned to follow its long axis.
 */

import { hexCenter, hexEdgeMidpoint, type Point } from '../../shared/hex.js';
import type { Elevation, MountainRange, River } from '../../shared/types.js';
import { fantasyTextEm } from './fonts.js';

export interface FeatureLabel {
  text: string;
  at: Point;
  size: number;
  rotation: number;
}

/** Keep text upright: rotate by a half turn if it would read upside down. */
function upright(angle: number): number {
  let a = angle;
  while (a > Math.PI / 2) a -= Math.PI;
  while (a <= -Math.PI / 2) a += Math.PI;
  return a;
}

/** The river's course as a polyline through hex centres and edge midpoints. */
function riverPath(river: River, size: number): Point[] {
  const pts: Point[] = [];
  const push = (p: Point) => {
    const last = pts[pts.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) pts.push(p);
  };
  for (const s of river.segments) {
    if (s.entryEdge !== null) push(hexEdgeMidpoint(s.col, s.row, s.entryEdge, size));
    push(hexCenter(s.col, s.row, size));
    if (s.exitEdge !== null) push(hexEdgeMidpoint(s.col, s.row, s.exitEdge, size));
  }
  return pts;
}

/** Point at distance `d` along the polyline, plus the cumulative lengths. */
function pointAt(pts: Point[], cum: number[], d: number): Point {
  let i = 1;
  while (i < pts.length - 1 && cum[i]! < d) i++;
  const span = cum[i]! - cum[i - 1]!;
  const t = span === 0 ? 0 : (d - cum[i - 1]!) / span;
  return {
    x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * t,
    y: pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * t,
  };
}

export function placeRiverLabels(rivers: River[], size: number): FeatureLabel[] {
  const out: FeatureLabel[] = [];
  const idealFont = Math.max(8, size * 0.34);
  const minFont = Math.max(6, size * 0.2);
  for (const river of rivers) {
    const text = river.name.trim();
    if (!text) continue;
    const pts = riverPath(river, size);
    if (pts.length < 2) continue;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
    }
    const total = cum[cum.length - 1]!;
    const em = fantasyTextEm(text);
    // Shrink to fit short rivers; a name that cannot fit legibly is left off.
    const font = Math.min(idealFont, (total * 0.95) / em);
    if (font < minFont) continue;
    const width = em * font;

    // Slide a window of the text's width along the course and take the one
    // whose points stray least from its own chord, preferring the middle.
    const steps = 24;
    let best: { start: number; score: number } | null = null;
    for (let k = 0; k <= steps; k++) {
      const start = ((total - width) * k) / steps;
      const a = pointAt(pts, cum, start);
      const b = pointAt(pts, cum, start + width);
      const chord = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      let deviation = 0;
      for (let j = 1; j < 6; j++) {
        const p = pointAt(pts, cum, start + (width * j) / 6);
        deviation = Math.max(
          deviation,
          Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / chord,
        );
      }
      const centreBias = Math.abs(start + width / 2 - total / 2) / total;
      const score = deviation / size + centreBias * 0.3;
      if (!best || score < best.score) best = { start, score };
    }
    const a = pointAt(pts, cum, best!.start);
    const b = pointAt(pts, cum, best!.start + width);
    const rotation = upright(Math.atan2(b.y - a.y, b.x - a.x));
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // Sit just above the line (in the text's own frame) so the stroke stays visible.
    const lift = font * 0.75;
    out.push({
      text,
      size: font,
      rotation,
      at: { x: mid.x + Math.sin(rotation) * lift, y: mid.y - Math.cos(rotation) * lift },
    });
  }
  return out;
}

export function placeRangeLabels(
  ranges: MountainRange[],
  elevation: (Elevation | null)[],
  cols: number,
  size: number,
): FeatureLabel[] {
  const out: FeatureLabel[] = [];
  for (const range of ranges) {
    const text = range.name.trim().toUpperCase();
    if (!text) continue;
    const live = range.hexes.filter((i) => elevation[i] === 'Mountains');
    if (live.length === 0) continue;
    const centres = live.map((i) => hexCenter(i % cols, Math.floor(i / cols), size));
    const mean = centres.reduce((s, c) => ({ x: s.x + c.x, y: s.y + c.y }), { x: 0, y: 0 });
    mean.x /= centres.length;
    mean.y /= centres.length;

    let xx = 0;
    let yy = 0;
    let xy = 0;
    for (const c of centres) {
      const dx = c.x - mean.x;
      const dy = c.y - mean.y;
      xx += dx * dx;
      yy += dy * dy;
      xy += dx * dy;
    }
    // Follow the long axis only when the range is clearly elongated.
    const spread = Math.sqrt((xx - yy) ** 2 + 4 * xy * xy);
    const major = (xx + yy + spread) / 2;
    const minor = (xx + yy - spread) / 2;
    const rotation =
      centres.length > 2 && major > 2 * minor ? upright(Math.atan2(2 * xy, xx - yy) / 2) : 0;

    // Along the axis, the extent of the range sets how big the name may be.
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of centres) {
      const u = (c.x - mean.x) * cos + (c.y - mean.y) * sin;
      lo = Math.min(lo, u);
      hi = Math.max(hi, u);
    }
    const length = hi - lo + size * 1.8;
    const em = fantasyTextEm(text, 700);
    const font = Math.max(Math.max(8, size * 0.3), Math.min(size * 0.7, length / em));
    out.push({ text, size: font, rotation, at: mean });
  }
  return out;
}
