/**
 * Text set along a curve, one glyph at a time.
 *
 * A name that follows a river (or, later, a sea or a realm) is laid out as
 * glyphs, each placed at its own distance along the curve and turned to the
 * curve's direction there, with optional letter-spacing. The renderers draw
 * the glyphs; nothing depends on a browser's support for text on a path or
 * for canvas letter-spacing, so the PNG and SVG exports set them identically.
 */

import type { Point } from '../../shared/hex.js';
import { fantasyTextEm, textEm } from './fonts.js';

export interface Glyph {
  ch: string;
  x: number;
  y: number;
  rotation: number;
}

/** Advance of each glyph in px, and the run's total width (no trailing tracking). */
export function glyphAdvances(
  text: string,
  size: number,
  tracking: number,
  weight = 600,
  family?: string,
  italic = false,
): { advances: number[]; width: number } {
  const em = (ch: string) => (family ? textEm(ch, family, weight, italic) : fantasyTextEm(ch, weight));
  const advances = [...text].map((ch) => em(ch) * size + tracking * size);
  const width = advances.reduce((a, b) => a + b, 0) - (text.length > 0 ? tracking * size : 0);
  return { advances, width };
}

function cumulative(points: Point[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  }
  return cum;
}

function pointAt(points: Point[], cum: number[], d: number): Point {
  let i = 1;
  while (i < points.length - 1 && cum[i]! < d) i++;
  const span = cum[i]! - cum[i - 1]! || 1;
  const t = Math.max(0, Math.min(1, (d - cum[i - 1]!) / span));
  return {
    x: points[i - 1]!.x + (points[i]!.x - points[i - 1]!.x) * t,
    y: points[i - 1]!.y + (points[i]!.y - points[i - 1]!.y) * t,
  };
}

/**
 * Lay `text` along `points` starting `start` px from the first point. Text
 * always reads left to right: if the stretch runs leftward the curve is walked
 * from the other end. `lift` moves each glyph off the line, toward the top of
 * the text, so the line it follows stays visible.
 */
export function glyphsAlong(
  text: string,
  size: number,
  points: Point[],
  start: number,
  options: { tracking?: number; lift?: number; weight?: number; family?: string; italic?: boolean } = {},
): Glyph[] {
  const tracking = options.tracking ?? 0;
  const lift = options.lift ?? 0;
  const { advances, width } = glyphAdvances(text, size, tracking, options.weight, options.family, options.italic);
  let path = points;
  let cum = cumulative(path);
  let from = start;
  const a = pointAt(path, cum, from);
  const b = pointAt(path, cum, from + width);
  if (b.x < a.x) {
    path = [...points].reverse();
    cum = cumulative(path);
    from = cum[cum.length - 1]! - start - width;
  }
  const glyphs: Glyph[] = [];
  let s = from;
  [...text].forEach((ch, k) => {
    const centre = s + (advances[k]! - tracking * size) / 2;
    const p = pointAt(path, cum, centre);
    const before = pointAt(path, cum, centre - size * 0.35);
    const after = pointAt(path, cum, centre + size * 0.35);
    const rotation = Math.atan2(after.y - before.y, after.x - before.x);
    glyphs.push({
      ch,
      x: p.x + Math.sin(rotation) * lift,
      y: p.y - Math.cos(rotation) * lift,
      rotation,
    });
    s += advances[k]!;
  });
  return glyphs;
}

/** Text laid letter-spaced along a straight baseline centred on `at`. */
export function glyphsStraight(
  text: string,
  size: number,
  at: Point,
  rotation: number,
  options: { tracking: number; weight?: number; family?: string; italic?: boolean },
): Glyph[] {
  const { width } = glyphAdvances(text, size, options.tracking, options.weight, options.family, options.italic);
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const reach = width;
  const line = [
    { x: at.x - c * reach, y: at.y - s * reach },
    { x: at.x + c * reach, y: at.y + s * reach },
  ];
  return glyphsAlong(text, size, line, reach - width / 2, options);
}
