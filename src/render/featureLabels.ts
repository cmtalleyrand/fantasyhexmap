/**
 * Name placement for rivers and mountain ranges.
 *
 * Both are laid out as a single rotated line of text. A river's name runs
 * along the straightest stretch of its course that is long enough to carry it;
 * a range's name sits on the range's own hexes, turned to follow its long axis.
 */

import { hexCenter, hexEdgeMidpoint, hexIndex, inBounds, pixelToOffset, type Point } from '../../shared/hex.js';
import type { BaseGeo, Elevation, MountainRange, River } from '../../shared/types.js';
import type { FaceRole } from './lettering.js';
import { LETTERINGS } from './lettering.js';
import { insideBox, type OrientedBox } from './labels.js';
import { glyphAdvances, glyphsAlong, glyphsStraight, type Glyph } from './glyphs.js';
import { depthWithin, ridgePath } from './depth.js';

/**
 * Largest type for a water name, in hex sizes: a body only a hex or two deep
 * keeps the first; one eight or more hexes deep may reach the second, a little
 * under the largest realm type (1.5 hexes), so oceans outrank lakes without
 * outshouting realms.
 */
const WATER_FONT_SHALLOW = 0.85;
const WATER_FONT_DEEP = 1.2;

/** The type a water body `maxDepth` hexes deep may carry: a pond keeps modest type, an ocean approaches the largest realm names. */
function waterCeiling(size: number, maxDepth: number): number {
  return size * WATER_FONT_SHALLOW + size * (WATER_FONT_DEEP - WATER_FONT_SHALLOW) * Math.min(1, Math.max(0, (maxDepth - 2) / 6));
}

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
  // Hex distance from land: 1 beside land, rising into the open water. A body
  // with no shore at all (open water to the map's edge) is deep everywhere.
  const depth = depthWithin(hexes, open, cols, height);
  if (depth.size === 0) return null;
  const maxDepth = Math.max(...depth.values());

  // The body's centre of mass: where its name belongs, not at its edge. Depth
  // alone cannot say, since for a body that meets the map's edge the deepest
  // water is the edge itself.
  const centreOf = (i: number) => hexCenter(i % cols, Math.floor(i / cols), size);
  const centre = { x: 0, y: 0 };
  for (const i of depth.keys()) {
    const c = centreOf(i);
    centre.x += c.x / depth.size;
    centre.y += c.y / depth.size;
  }
  const bodyRadius = Math.max(size, Math.sqrt(depth.size) * size);
  // The deeper half of the water, nearest the middle first.
  const candidates = [...depth.entries()]
    .filter(([, d]) => d >= Math.max(1, maxDepth * 0.5))
    .map(([i]) => ({ i, off: Math.hypot(centreOf(i).x - centre.x, centreOf(i).y - centre.y) }))
    .sort((a, b) => a.off - b.off)
    .slice(0, 60);
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
  const ceiling = waterCeiling(size, maxDepth);
  let fitAt = 0;
  for (let font = ceiling; font >= size * 0.32; font *= 0.9) {
    // Once a size fits, one smaller may still win by sitting nearer the middle.
    if (fitAt > 0 && font < fitAt * 0.85) break;
    const width = em * font;
    for (const { i, off } of candidates) {
      const at = centreOf(i);
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
        // Larger type first; then the middle of the body, level, and the deepest water.
        const score = font / size - 0.15 * Math.min(1, off / bodyRadius) - 0.12 * Math.abs(sn) + 0.01 * Math.min(depth.get(i) ?? 0, 12);
        found.push({ score, at, angle, font });
      }
    }
    if (found.length > 0 && fitAt === 0) fitAt = font;
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
 * A name set along the middle of a winding body of water (a gulf, a bay with
 * a corridor): the ridge of its deepest water, from end to end, with the name
 * on the stretch of it nearest the body's middle where every letter, with
 * room above and below, lies over open water. Larger type is tried first.
 * Null when no stretch carries the name at its smallest size.
 */
function spineLabel(
  text: string,
  hexes: number[],
  cols: number,
  rows: number,
  size: number,
  face: FaceRole,
  base: ReadonlyArray<BaseGeo | null>,
): FeatureLabel | null {
  if (hexes.length > 6000) return null;
  const inBody = new Set(hexes);
  const open = (i: number) => inBody.has(i) && (base[i] === 'Sea' || base[i] === 'Lake');
  const height = Number.isFinite(rows) ? rows : Math.ceil(Math.max(...hexes) / cols) + 1;
  const depth = depthWithin(hexes, open, cols, height);
  if (depth.size < 2) return null;
  const maxDepth = Math.max(...depth.values());
  const ridge = ridgePath(depth, cols, height);
  if (ridge.length < 2) return null;
  // Smooth the hex-to-hex zigzag so letters follow a curve, not a staircase.
  let path = ridge.map((i) => hexCenter(i % cols, Math.floor(i / cols), size));
  for (let pass = 0; pass < 2; pass++) {
    path = path.map((p, k) => (k === 0 || k === path.length - 1
      ? p
      : { x: (path[k - 1]!.x + p.x + path[k + 1]!.x) / 3, y: (path[k - 1]!.y + p.y + path[k + 1]!.y) / 3 }));
  }
  const cum = [0];
  for (let k = 1; k < path.length; k++) cum.push(cum[k - 1]! + Math.hypot(path[k]!.x - path[k - 1]!.x, path[k]!.y - path[k - 1]!.y));
  const length = cum[cum.length - 1]!;
  const centre = { x: 0, y: 0 };
  for (const i of depth.keys()) {
    const c = hexCenter(i % cols, Math.floor(i / cols), size);
    centre.x += c.x / depth.size;
    centre.y += c.y / depth.size;
  }
  const bodyRadius = Math.max(size, Math.sqrt(depth.size) * size);

  const wet = (x: number, y: number, margin: number) =>
    [[0, 0], [margin, 0], [-margin, 0], [0, margin], [0, -margin]].every(([dx, dy]) => {
      const { col, row } = pixelToOffset(x + dx!, y + dy!, size);
      return inBounds(cols, height, col, row) && open(hexIndex(cols, col, row));
    });
  const em = glyphAdvances(text, 1, face.tracking, face.weight, face.family, face.italic).width;
  const options = { tracking: face.tracking, weight: face.weight, family: face.family, italic: face.italic };
  let best: { score: number; glyphs: Glyph[]; at: Point; font: number } | null = null;
  let fitAt = 0;
  for (let font = waterCeiling(size, maxDepth); font >= size * 0.32; font *= 0.9) {
    if (fitAt > 0 && font < fitAt * 0.85) break;
    const width = em * font;
    if (width > length) continue;
    const steps = 40;
    for (let k = 0; k <= steps; k++) {
      const start = ((length - width) * k) / steps;
      const glyphs = glyphsAlong(text, font, path, start, options);
      // Every letter, and the room above and below it, over open water.
      const over = glyphs.every((g) =>
        [-0.5, 0, 0.5].every((side) => wet(g.x - Math.sin(g.rotation) * font * side, g.y + Math.cos(g.rotation) * font * side, size * 0.1)),
      );
      if (!over) continue;
      // A name that bends sharply reads badly: the turn from first to last letter.
      const turn = Math.abs(glyphs[glyphs.length - 1]!.rotation - glyphs[0]!.rotation);
      if (turn > (2 * Math.PI) / 3) continue;
      const mid = glyphs[Math.floor(glyphs.length / 2)]!;
      const score = font / size - 0.15 * Math.min(1, Math.hypot(mid.x - centre.x, mid.y - centre.y) / bodyRadius) - 0.1 * turn;
      if (!best || score > best.score) best = { score, glyphs, at: { x: mid.x, y: mid.y }, font };
    }
    if (best && fitAt === 0) fitAt = font;
  }
  if (!best) return null;
  const mid = best.glyphs[Math.floor(best.glyphs.length / 2)]!;
  return { text, at: best.at, size: best.font, rotation: mid.rotation, glyphs: best.glyphs, width: em * best.font };
}

/**
 * A name of two or more words split across open water either side of an
 * obstruction (an island group in the middle of an ocean): the words stand
 * on one baseline, each in its own stretch of open water, set as close
 * together as the obstruction allows so they still read as one name. Larger
 * type is tried first. Null when no baseline has two such stretches, or when
 * they lie further apart than a few word-lengths, which would read as two names.
 */
function splitLabel(
  text: string,
  hexes: number[],
  cols: number,
  rows: number,
  size: number,
  face: FaceRole,
  base: ReadonlyArray<BaseGeo | null>,
): FeatureLabel | null {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 2 || hexes.length > 6000) return null;
  const inBody = new Set(hexes);
  const open = (i: number) => inBody.has(i) && (base[i] === 'Sea' || base[i] === 'Lake');
  const height = Number.isFinite(rows) ? rows : Math.ceil(Math.max(...hexes) / cols) + 1;
  const depth = depthWithin(hexes, open, cols, height);
  if (depth.size === 0) return null;
  const maxDepth = Math.max(...depth.values());
  const centreOf = (i: number) => hexCenter(i % cols, Math.floor(i / cols), size);
  const centre = { x: 0, y: 0 };
  for (const i of depth.keys()) {
    centre.x += centreOf(i).x / depth.size;
    centre.y += centreOf(i).y / depth.size;
  }
  const bodyRadius = Math.max(size, Math.sqrt(depth.size) * size);
  const wet = (x: number, y: number, margin: number) =>
    [[0, 0], [margin, 0], [-margin, 0], [0, margin], [0, -margin]].every(([dx, dy]) => {
      const { col, row } = pixelToOffset(x + dx!, y + dy!, size);
      return inBounds(cols, height, col, row) && open(hexIndex(cols, col, row));
    });
  const options = { tracking: face.tracking, weight: face.weight, family: face.family, italic: face.italic };
  const emOf = (t: string) => glyphAdvances(t, 1, face.tracking, face.weight, face.family, face.italic).width;
  // Every way to cut the words into a first part and a second.
  const cuts = words.slice(1).map((_, k) => [words.slice(0, k + 1).join(' '), words.slice(k + 1).join(' ')] as const);
  // Baselines through the body's middle-most hexes, level and a little tilted.
  const origins = [...depth.keys()]
    .map((i) => ({ at: centreOf(i), off: Math.hypot(centreOf(i).x - centre.x, centreOf(i).y - centre.y) }))
    .sort((a, b) => a.off - b.off)
    .slice(0, 80);
  const angles = [0, Math.PI / 12, -Math.PI / 12];
  const step = size * 0.3;
  interface Spot {
    score: number;
    parts: Array<{ text: string; at: Point }>;
    angle: number;
    font: number;
    mid: Point;
    span: number;
  }
  let best: Spot | null = null;
  let fitAt = 0;
  for (let font = waterCeiling(size, maxDepth); font >= size * 0.32; font *= 0.9) {
    if (fitAt > 0 && font < fitAt * 0.85) break;
    const margin = font * 0.45;
    for (const [first, second] of cuts) {
      const w1 = emOf(first) * font;
      const w2 = emOf(second) * font;
      const reach = (w1 + w2) * 2;
      for (const { at, off } of origins) {
        for (const angle of angles) {
          const c = Math.cos(angle);
          const sn = Math.sin(angle);
          // Stretches of open water along the baseline, as [start, end] offsets from the origin.
          const runs: Array<[number, number]> = [];
          let from: number | null = null;
          for (let t = -reach; t <= reach; t += step) {
            const ok = [-font * 0.55, 0, font * 0.55].every((lift) => wet(at.x + c * t - sn * lift, at.y + sn * t + c * lift, size * 0.2));
            if (ok && from === null) from = t;
            if (!ok && from !== null) {
              runs.push([from, t - step]);
              from = null;
            }
          }
          if (from !== null) runs.push([from, reach]);
          // The first part in an earlier stretch, the second in a later one, nearest each other.
          for (let a = 0; a < runs.length; a++) {
            if (runs[a]![1] - runs[a]![0] < w1 + 2 * margin) continue;
            for (let b = a + 1; b < runs.length; b++) {
              if (runs[b]![1] - runs[b]![0] < w2 + 2 * margin) continue;
              const t1 = runs[a]![1] - margin - w1 / 2;
              const t2 = runs[b]![0] + margin + w2 / 2;
              const gap = t2 - w2 / 2 - (t1 + w1 / 2);
              if (gap > 3 * Math.max(w1, w2)) continue;
              const mid = { x: at.x + c * ((t1 + t2) / 2), y: at.y + sn * ((t1 + t2) / 2) };
              const score = font / size - 0.15 * Math.min(1, Math.hypot(mid.x - centre.x, mid.y - centre.y) / bodyRadius) - 0.12 * Math.abs(sn) - 0.05 * (gap / (w1 + w2)) - 0.0001 * off;
              if (!best || score > best.score) {
                best = {
                  score,
                  parts: [
                    { text: first, at: { x: at.x + c * t1, y: at.y + sn * t1 } },
                    { text: second, at: { x: at.x + c * t2, y: at.y + sn * t2 } },
                  ],
                  angle,
                  font,
                  mid,
                  span: t2 + w2 / 2 - (t1 - w1 / 2),
                };
              }
              break;
            }
          }
        }
      }
    }
    if (best && fitAt === 0) fitAt = font;
  }
  if (!best) return null;
  const found: Spot = best;
  const glyphs = found.parts.flatMap((part) => glyphsStraight(part.text, found.font, part.at, found.angle, options));
  return { text, at: found.mid, size: found.font, rotation: found.angle, glyphs, width: found.span };
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
  /** The river's mean drawn width, where it has one: wider rivers carry slightly larger names. */
  widthFor?: (riverId: string) => number | undefined,
): FeatureLabel[] {
  const out: FeatureLabel[] = [];
  const minFont = Math.max(7, size * 0.3);
  for (const river of rivers) {
    const text = river.name.trim();
    if (!text) continue;
    const drawn = widthFor?.(river.id) ?? 0;
    // Large enough to read against relief and polity colour, and up to a tenth
    // larger on a wide river; a river too short to carry its name at the floor
    // size goes unnamed.
    const idealFont = Math.max(9, size * 0.44) * (1 + 0.1 * Math.min(1, drawn / (size * 0.17)));
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
    const lift = Math.max(font * 0.8, drawn / 2 + font * 0.45);
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
    const straight = base ? openWaterLabel(text, body.hexes, cols, rows, size, face, base) : null;
    // A winding body may hold only a small straight name; a name along its
    // water is worth taking when its type is meaningfully larger.
    const winding = base && (!straight || straight.size < size * WATER_FONT_SHALLOW)
      ? spineLabel(text, body.hexes, cols, rows, size, face, base)
      : null;
    const single = winding && (!straight || winding.size > straight.size * 1.25) ? winding : straight;
    // An ocean cut by islands may carry only a small single run; its words,
    // set either side of the obstruction, can be meaningfully larger.
    const divided = base ? splitLabel(text, body.hexes, cols, rows, size, face, base) : null;
    const open = divided && (!single || divided.size > single.size * 1.25) ? divided : single;
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
