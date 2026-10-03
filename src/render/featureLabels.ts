/**
 * Name placement for rivers and mountain ranges.
 *
 * Both are laid out as a single rotated line of text. A river's name runs
 * along the straightest stretch of its course that is long enough to carry it;
 * a range's name sits on the range's own hexes, turned to follow its long axis.
 */

import { hexCenter, hexEdgeMidpoint, hexIndex, inBounds, neighbourOf, pixelToOffset, type Point } from '../../shared/hex.js';
import type { BaseGeo, Elevation, MountainRange, River } from '../../shared/types.js';
import type { FaceRole } from './lettering.js';
import { LETTERINGS } from './lettering.js';
import { insideBox, type OrientedBox } from './labels.js';
import { glyphAdvances, glyphsAlong, glyphsStraight, type Glyph } from './glyphs.js';

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
 * A sea or lake name set straight across the most open water of its body:
 * the hexes furthest from any land, at the angle (level preferred) where the
 * whole name, with a margin, lies over open water. Null when no such place
 * fits the name at its smallest size; the caller then sets it along the
 * body's spine, as for a strait.
 */
function openWaterLabel(
  text: string,
  hexes: number[],
  cols: number,
  rows: number,
  size: number,
  face: FaceRole,
  base: ReadonlyArray<BaseGeo | null>,
): FeatureLabel | null {
  const inBody = new Set(hexes);
  // Open water: the body's sea and lake hexes, not those holding land.
  const open = (i: number) => inBody.has(i) && (base[i] === 'Sea' || base[i] === 'Lake');
  const height = Number.isFinite(rows) ? rows : Math.ceil(Math.max(...hexes) / cols) + 1;
  // Hex distance from land: 1 beside land, rising into the open water.
  const depth = new Map<number, number>();
  let frontier: number[] = [];
  for (const i of hexes) {
    if (!open(i)) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const shore = [0, 1, 2, 3, 4, 5].some((e) => {
      const n = neighbourOf(col, row, e);
      return inBounds(cols, height, n.col, n.row) && !open(hexIndex(cols, n.col, n.row));
    });
    if (shore) {
      depth.set(i, 1);
      frontier.push(i);
    }
  }
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const i of frontier) {
      for (let e = 0; e < 6; e++) {
        const n = neighbourOf(i % cols, Math.floor(i / cols), e);
        if (!inBounds(cols, height, n.col, n.row)) continue;
        const j = hexIndex(cols, n.col, n.row);
        if (!open(j) || depth.has(j)) continue;
        depth.set(j, depth.get(i)! + 1);
        next.push(j);
      }
    }
    frontier = next;
  }
  // A body with no shore at all (open water to the map's edge) is deep everywhere.
  for (const i of hexes) if (open(i) && !depth.has(i)) depth.set(i, 99);
  const candidates = [...depth.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([i]) => i);
  if (candidates.length === 0) return null;

  /** Whether a point lies over open water with a margin of `margin` all round. */
  const wet = (x: number, y: number, margin: number) =>
    [[0, 0], [margin, 0], [-margin, 0], [0, margin], [0, -margin]].every(([dx, dy]) => {
      const { col, row } = pixelToOffset(x + dx!, y + dy!, size);
      return inBounds(cols, height, col, row) && open(hexIndex(cols, col, row));
    });
  const em = glyphAdvances(text, 1, face.tracking, face.weight, face.family, face.italic).width;
  const angles = [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3, Math.PI / 2];
  interface Spot {
    score: number;
    at: Point;
    angle: number;
    font: number;
  }
  const found: Spot[] = [];
  for (let font = size * 0.85; font >= size * 0.32; font *= 0.9) {
    const width = em * font;
    for (const i of candidates) {
      const at = hexCenter(i % cols, Math.floor(i / cols), size);
      for (const angle of angles) {
        const c = Math.cos(angle);
        const sn = Math.sin(angle);
        let fits = true;
        for (let t = -width / 2 - font * 0.4; t <= width / 2 + font * 0.4 && fits; t += size * 0.3) {
          for (const lift of [-font * 0.55, 0, font * 0.55]) {
            if (!wet(at.x + c * t - sn * lift, at.y + sn * t + c * lift, size * 0.2)) {
              fits = false;
              break;
            }
          }
        }
        if (!fits) continue;
        // Larger type first; then level, then the deepest water.
        const score = font / size - 0.12 * Math.abs(sn) + 0.01 * (depth.get(i) ?? 0);
        found.push({ score, at, angle, font });
      }
    }
    if (found.length > 0) break;
  }
  const best = found.sort((a, b) => b.score - a.score)[0];
  if (!best) return null;
  const rotation = upright(best.angle);
  const glyphs = glyphsStraight(text, best.font, best.at, rotation, {
    tracking: face.tracking,
    weight: face.weight,
    family: face.family,
    italic: face.italic,
  });
  return { text, at: best.at, size: best.font, rotation, glyphs, width: em * best.font };
}

/**
 * `pathFor` supplies the course as drawn when it is not the hex-centre polyline
 * (a meandering river), so the name sits on the line the reader sees.
 */
export function placeRiverLabels(
  rivers: River[],
  size: number,
  pathFor?: (riverId: string) => Point[] | null,
  face: FaceRole = LETTERINGS.classic.river,
  avoid: OrientedBox[] = [],
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
    const em = glyphAdvances(text, 1, face.tracking, face.weight, face.family, face.italic).width;
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
      // Names already placed (realms) are avoided: the share of the text's
      // length, sampled along its baseline and its top, that would fall on one.
      let covered = 0;
      if (avoid.length > 0) {
        for (let j = 0; j <= 8; j++) {
          const d = start + (width * j) / 8;
          const p = pointAt(pts, cum, d);
          const q = pointAt(pts, cum, d + font * 0.3);
          const angle = Math.atan2(q.y - p.y, q.x - p.x);
          const up = Math.cos(angle) >= 0 ? 1 : -1;
          for (const lift of [font * 0.4, font * 1.2]) {
            const x = p.x + Math.sin(angle) * lift * up;
            const y = p.y - Math.cos(angle) * lift * up;
            if (avoid.some((box) => insideBox(box, x, y))) covered++;
          }
        }
        covered /= 18;
      }
      // The name bends with the river, so a bend matters less than for straight type.
      const score = (deviation / size) * 0.5 + centreBias * 0.3 + covered * 2;
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
      glyphs: glyphsAlong(text, font, pts, best!.start, { tracking: face.tracking, lift, weight: face.weight, family: face.family, italic: face.italic }),
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
  face: FaceRole = LETTERINGS.classic.range,
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
    const em = glyphAdvances(text, 1, face.tracking, face.weight, face.family, face.italic).width;
    const font = Math.max(Math.max(8, size * 0.3), Math.min(size * 0.7, length / em));
    out.push({
      text,
      size: font,
      rotation,
      at: mean,
      width: em * font,
      ...(face.tracking > 0 ? { glyphs: glyphsStraight(text, font, mean, rotation, face) } : {}),
    });
  }
  return out;
}


/**
 * Names of land features and islands: set in capitals across the hexes, turned
 * to follow the long axis of an elongated area, sized to its extent.
 */
export function placeAreaLabels(
  areas: Array<{ name: string; hexes: number[] }>,
  cols: number,
  size: number,
  face: FaceRole = LETTERINGS.classic.range,
): FeatureLabel[] {
  const out: FeatureLabel[] = [];
  for (const area of areas) {
    const text = area.name.trim().toUpperCase();
    if (!text || area.hexes.length === 0) continue;
    const centres = area.hexes.map((i) => hexCenter(i % cols, Math.floor(i / cols), size));
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
    const rotation = centres.length > 2 && major > 2 * minor ? upright(Math.atan2(2 * xy, xx - yy) / 2) : 0;
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
    const em = glyphAdvances(text, 1, face.tracking, face.weight, face.family, face.italic).width;
    const font = Math.max(Math.max(8, size * 0.3), Math.min(size * 0.7, length / em));
    out.push({
      text,
      size: font,
      rotation,
      at: mean,
      width: em * font,
      ...(face.tracking > 0 ? { glyphs: glyphsStraight(text, font, mean, rotation, face) } : {}),
    });
  }
  return out;
}

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
  face: FaceRole = LETTERINGS.classic.water,
  base: ReadonlyArray<BaseGeo | null> | null = null,
  rows = Infinity,
): FeatureLabel[] {
  const out: FeatureLabel[] = [];
  for (const body of bodies) {
    const text = body.name.trim().toUpperCase();
    if (!text || body.hexes.length === 0) continue;
    const open = base ? openWaterLabel(text, body.hexes, cols, rows, size, face, base) : null;
    if (open) {
      out.push(open);
      continue;
    }
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
    const em = glyphAdvances(text, 1, face.tracking, face.weight, face.family, face.italic).width;
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
    const glyphs = glyphsAlong(text, font, line, mid - width / 2, { tracking: face.tracking, weight: face.weight, family: face.family, italic: face.italic });
    out.push({ text, at: mean, size: font, rotation: axis, glyphs, width });
  }
  return out;
}
