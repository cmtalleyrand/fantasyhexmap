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
import { glyphAdvances, glyphsAlong, type Glyph } from './glyphs.js';

export interface FeatureLabel {
  text: string;
  at: Point;
  size: number;
  rotation: number;
  /** The name set glyph by glyph along the feature, when it follows a curve. */
  glyphs?: Glyph[];
  /** Length of the set text in px. */
  width?: number;
}

/** Letter-spacing of river names, in em: open type reads at small sizes over busy ground. */
const RIVER_TRACKING = 0.08;

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

/**
 * `pathFor` supplies the course as drawn when it is not the hex-centre polyline
 * (a meandering river), so the name sits on the line the reader sees.
 */
export function placeRiverLabels(
  rivers: River[],
  size: number,
  pathFor?: (riverId: string) => Point[] | null,
): FeatureLabel[] {
  const out: FeatureLabel[] = [];
  // Large enough to read against relief and polity colour; a river too
  // short to carry its name at the floor size goes unnamed.
  const idealFont = Math.max(9, size * 0.44);
  const minFont = Math.max(7, size * 0.3);
  for (const river of rivers) {
    const text = river.name.trim();
    if (!text) continue;
    const pts = pathFor?.(river.id) ?? riverPath(river, size);
    if (pts.length < 2) continue;
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
    }
    const total = cum[cum.length - 1]!;
    const em = glyphAdvances(text, 1, RIVER_TRACKING).width;
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
      // The name bends with the river, so a bend matters less than for straight type.
      const score = (deviation / size) * 0.5 + centreBias * 0.3;
      if (!best || score < best.score) best = { start, score };
    }
    const a = pointAt(pts, cum, best!.start);
    const b = pointAt(pts, cum, best!.start + width);
    const rotation = upright(Math.atan2(b.y - a.y, b.x - a.x));
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    // Sit just above the line (in the text's own frame) so the stroke stays visible.
    const lift = font * 0.8;
    out.push({
      text,
      size: font,
      rotation,
      at: { x: mid.x + Math.sin(rotation) * lift, y: mid.y - Math.cos(rotation) * lift },
      glyphs: glyphsAlong(text, font, pts, best!.start, { tracking: RIVER_TRACKING, lift }),
      width,
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

/** Letter-spacing of sea names, in em: wide, as atlases set water. */
const WATER_TRACKING = 0.32;

/**
 * Names of seas, bays and lakes. Each is set in spaced capitals across its
 * hexes, along the body's long axis. A long, narrow body (a strait, a gulf)
 * gets its name curved along a spine through the middle of its hexes rather
 * than a straight line that would run onto the land at either end.
 */
export function placeWaterLabels(
  bodies: Array<{ name: string; hexes: number[] }>,
  cols: number,
  size: number,
): FeatureLabel[] {
  const out: FeatureLabel[] = [];
  for (const body of bodies) {
    const text = body.name.trim().toUpperCase();
    if (!text || body.hexes.length === 0) continue;
    const centres = body.hexes.map((i) => hexCenter(i % cols, Math.floor(i / cols), size));
    const mean = centres.reduce((s, c) => ({ x: s.x + c.x, y: s.y + c.y }), { x: 0, y: 0 });
    mean.x /= centres.length;
    mean.y /= centres.length;
    let xx = 0;
    let yy = 0;
    let xy = 0;
    for (const c of centres) {
      xx += (c.x - mean.x) ** 2;
      yy += (c.y - mean.y) ** 2;
      xy += (c.x - mean.x) * (c.y - mean.y);
    }
    const spread = Math.sqrt((xx - yy) ** 2 + 4 * xy * xy);
    const major = (xx + yy + spread) / 2;
    const minor = (xx + yy - spread) / 2;
    const axis = centres.length > 2 && major > 1.5 * minor ? upright(Math.atan2(2 * xy, xx - yy) / 2) : 0;
    const cos = Math.cos(axis);
    const sin = Math.sin(axis);
    let lo = Infinity;
    let hi = -Infinity;
    for (const c of centres) {
      const u = (c.x - mean.x) * cos + (c.y - mean.y) * sin;
      lo = Math.min(lo, u);
      hi = Math.max(hi, u);
    }
    const length = hi - lo + size * 1.2;
    const em = glyphAdvances(text, 1, WATER_TRACKING, 500).width;
    const font = Math.max(size * 0.32, Math.min(size * 0.85, (length * 0.8) / em));
    const width = em * font;

    // The spine: hex centres binned along the axis, each bin's mean, so a
    // curving strait carries a curving name.
    const bins = Math.max(2, Math.min(7, Math.round((hi - lo) / (size * 2)) + 1));
    const sums = Array.from({ length: bins }, () => ({ x: 0, y: 0, n: 0 }));
    for (const c of centres) {
      const u = (c.x - mean.x) * cos + (c.y - mean.y) * sin;
      const b = Math.min(bins - 1, Math.floor(((u - lo) / Math.max(1e-6, hi - lo)) * bins));
      sums[b]!.x += c.x;
      sums[b]!.y += c.y;
      sums[b]!.n++;
    }
    const spine = sums.filter((b) => b.n > 0).map((b) => ({ x: b.x / b.n, y: b.y / b.n }));
    const elongated = major > 6 * minor && spine.length >= 3;
    // Extend the spine (or a straight axis) well past both ends so the name always fits on it.
    const line = elongated
      ? (() => {
          const first = spine[0]!;
          const second = spine[1]!;
          const last = spine[spine.length - 1]!;
          const prev = spine[spine.length - 2]!;
          const ext = (a: { x: number; y: number }, b: { x: number; y: number }) => {
            const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
            return { x: a.x + ((a.x - b.x) / d) * width, y: a.y + ((a.y - b.y) / d) * width };
          };
          return [ext(first, second), ...spine, ext(last, prev)];
        })()
      : [
          { x: mean.x - cos * width * 2, y: mean.y - sin * width * 2 },
          { x: mean.x + cos * width * 2, y: mean.y + sin * width * 2 },
        ];
    // Centre the name on the line's point nearest the body's centre.
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1]! + Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.y - line[i - 1]!.y));
    let mid = 0;
    let bestD = Infinity;
    for (let k = 0; k <= 200; k++) {
      const d = (cum[cum.length - 1]! * k) / 200;
      const p = pointAt(line, cum, d);
      const dist = Math.hypot(p.x - mean.x, p.y - mean.y);
      if (dist < bestD) {
        bestD = dist;
        mid = d;
      }
    }
    const glyphs = glyphsAlong(text, font, line, mid - width / 2, { tracking: WATER_TRACKING, weight: 500 });
    out.push({ text, at: mean, size: font, rotation: axis, glyphs, width });
  }
  return out;
}
