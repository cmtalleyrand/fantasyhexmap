/**
 * Polity label placement.
 *
 * A label is a rotated rectangle of text. A placement is good when the whole
 * rectangle sits inside the territory it names, so the score is the fraction of
 * sample points across the rectangle that land on hexes the polity owns. The
 * earlier approach only anchored the label on an owned hex centre and sized it
 * from the territory's bounding spans; for any non-convex, elongated or
 * ragged realm the text then spilled over neighbours and the sea.
 */

import {
  hexCenter,
  hexIndex,
  inBounds,
  neighbourOf,
  pixelToOffset,
  type Point,
} from '../../shared/hex.js';
import { fantasyTextEm } from './fonts.js';

export interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface PolityLabel {
  polityId: string;
  at: Point;
  /** One entry per rendered line, top to bottom. */
  lines: string[];
  size: number;
  rotation: number;
}

export const LABEL_LINE_EM = 1.1;

/**
 * Smallest territory, in hexes, that gets a name on the map: a number from 0
 * (every polity is named) to 5, or `auto`, where the placer names a small
 * polity only if the name fits cleanly without covering anything else.
 */
export type PolityNameMin = 0 | 1 | 2 | 3 | 4 | 5 | 'auto';
export const POLITY_NAME_MIN_OPTIONS: PolityNameMin[] = ['auto', 0, 1, 2, 3, 4, 5];
export const DEFAULT_POLITY_NAME_MIN: PolityNameMin = 4;

export function parsePolityNameMin(value: unknown): PolityNameMin {
  if (value === 'auto') return 'auto';
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5
    ? (value as PolityNameMin)
    : DEFAULT_POLITY_NAME_MIN;
}

/** Territories under this size are only named in `auto` mode when a clean fit exists. */
const AUTO_CLEAN_FIT_BELOW = 4;

export interface LabelObstacle extends LabelBox {}

export interface LabelInput {
  cols: number;
  rows: number;
  size: number;
  owner: (string | null)[];
  polities: { id: string; name: string; shortName?: string }[];
  /** Markers and names already on the map that a polity name should not cover. */
  obstacles: LabelObstacle[];
  /** Defaults to {@link DEFAULT_POLITY_NAME_MIN}. */
  minHexes?: PolityNameMin;
}

const LABEL_HEIGHT_EM = LABEL_LINE_EM;
/** Preference for keeping a name on one line when wrapping gains nothing. */
const WRAP_PENALTY = 0.02;
const MIN_FONT = 7;
const GOOD_COVERAGE = 0.92;
/** Tried before the fallback, so a name shrinks before it is allowed over water. */
const SECOND_COVERAGE = 0.86;
const FALLBACK_COVERAGE = 0.78;
/** Largest realm-name type, in hex sizes. */
const MAX_FONT_HEXES = 2.2;
const SIZE_STEP = 0.9;
const ROTATION_STEP = Math.PI / 12;
const MAX_ROTATION = Math.PI / 6;

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function labelBox(at: Point, width: number, height: number, rotation: number): LabelBox {
  const c = Math.abs(Math.cos(rotation));
  const s = Math.abs(Math.sin(rotation));
  const halfWidth = (width * c + height * s) / 2;
  const halfHeight = (width * s + height * c) / 2;
  return {
    left: at.x - halfWidth,
    right: at.x + halfWidth,
    top: at.y - halfHeight,
    bottom: at.y + halfHeight,
  };
}

interface Candidate {
  at: Point;
  /** Distance from the territory centroid, used to prefer central placements. */
  offCentre: number;
}

interface TextLayout {
  lines: string[];
  /** Width of the widest line, in em. */
  em: number;
}

/** The name on one line, plus the most balanced two-line split if it has spaces. */
function textLayouts(text: string): TextLayout[] {
  const layouts: TextLayout[] = [{ lines: [text], em: fantasyTextEm(text) }];
  const words = text.split(/\s+/).filter(Boolean);
  let best: TextLayout | null = null;
  for (let k = 1; k < words.length; k++) {
    const lines = [words.slice(0, k).join(' '), words.slice(k).join(' ')];
    const em = Math.max(...lines.map((line) => fantasyTextEm(line)));
    if (!best || em < best.em) best = { lines, em };
  }
  if (best) layouts.push(best);
  return layouts;
}

export function placePolityLabels(input: LabelInput): PolityLabel[] {
  const { cols, rows, size, owner, polities } = input;
  const width = cols;
  const minHexes = input.minHexes ?? DEFAULT_POLITY_NAME_MIN;

  const hexesByPolity = new Map<string, number[]>();
  owner.forEach((id, i) => {
    if (!id) return;
    const list = hexesByPolity.get(id);
    if (list) list.push(i);
    else hexesByPolity.set(id, [i]);
  });

  const isOwnedBy = (id: string, x: number, y: number): boolean => {
    const { col, row } = pixelToOffset(x, y, size);
    return inBounds(cols, rows, col, row) && owner[hexIndex(width, col, row)] === id;
  };

  const ordered = [...polities].sort(
    (a, b) => (hexesByPolity.get(b.id)?.length ?? 0) - (hexesByPolity.get(a.id)?.length ?? 0),
  );

  const placed: PolityLabel[] = [];
  const claimed: LabelBox[] = [];

  for (const polity of ordered) {
    const owned = hexesByPolity.get(polity.id) ?? [];
    // Tiny territories are keyed by colour in the legend instead; how tiny is
    // the user's call. In auto mode a small polity is named only when a clean
    // placement exists (see `small` below), so nothing is forced into a hex.
    const small = owned.length < AUTO_CLEAN_FIT_BELOW;
    if (minHexes !== 'auto' && owned.length < minHexes) continue;

    const centres = owned.map((i) => hexCenter(i % cols, Math.floor(i / cols), size));
    const mean = centres.reduce((sum, c) => ({ x: sum.x + c.x, y: sum.y + c.y }), { x: 0, y: 0 });
    mean.x /= centres.length;
    mean.y /= centres.length;

    // Anchors: every owned hex centre plus the midpoint to each owned
    // neighbour. Half-hex granularity lets a long name sit between hexes.
    const ownedSet = new Set(owned);
    const candidates: Candidate[] = [];
    const addCandidate = (at: Point) =>
      candidates.push({ at, offCentre: Math.hypot(at.x - mean.x, at.y - mean.y) });
    owned.forEach((i, k) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      addCandidate(centres[k]!);
      for (let e = 0; e < 6; e++) {
        const n = neighbourOf(col, row, e);
        if (!inBounds(cols, rows, n.col, n.row)) continue;
        const j = hexIndex(cols, n.col, n.row);
        if (j <= i || !ownedSet.has(j)) continue;
        const nc = hexCenter(n.col, n.row, size);
        addCandidate({ x: (centres[k]!.x + nc.x) / 2, y: (centres[k]!.y + nc.y) / 2 });
      }
    });
    candidates.sort((a, b) => a.offCentre - b.offCentre);

    // Principal axis of the territory, kept within 30 degrees of horizontal and
    // snapped to 15 so that placement reads as deliberate. Flat and slightly
    // tilted options are always tried as well, since the principal axis of a
    // blob says little about where its text actually fits.
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
    let principal = Math.atan2(2 * xy, xx - yy) / 2;
    if (Math.cos(principal) < 0) principal += Math.PI;
    principal = Math.max(-MAX_ROTATION, Math.min(MAX_ROTATION, principal));
    principal = Math.round(principal / ROTATION_STEP) * ROTATION_STEP;
    const rotations = [...new Set([0, principal, -ROTATION_STEP, ROTATION_STEP, -MAX_ROTATION, MAX_ROTATION])]
      .sort((a, b) => Math.abs(a) - Math.abs(b));

    const text = (polity.shortName?.trim() || polity.name).toUpperCase();
    const layouts = textLayouts(text);
    // Hex area is proportional to size², so a linear dimension such as type
    // size grows with sqrt(hex count).
    // Capped, so the largest realms are named in large type rather than in
    // letters so big they cannot fit without crossing water and neighbours.
    const idealSize = Math.min(size * MAX_FONT_HEXES, size * 0.28 * Math.sqrt(owned.length));

    const attempt = (
      obstacles: LabelBox[],
      minCoverage: number,
      fontFloor: number,
    ): PolityLabel | null => {
      for (let font = idealSize; font >= fontFloor; font *= SIZE_STEP) {
        let best: { at: Point; rotation: number; lines: string[]; score: number } | null = null;
        for (const layout of layouts) {
          const w = layout.em * font;
          const h = font * LABEL_HEIGHT_EM * layout.lines.length;
          const across = Math.min(24, Math.max(3, Math.ceil(w / (size * 0.45))));
          const down = Math.max(3, layout.lines.length * 2 + 1);
          for (const rotation of rotations) {
            const cos = Math.cos(rotation);
            const sin = Math.sin(rotation);
            const samples: Point[] = [];
            for (let a = 0; a < across; a++) {
              for (let b = 0; b < down; b++) {
                const u = ((a + 0.5) / across - 0.5) * w;
                const v = (b / (down - 1) - 0.5) * h * 0.9;
                samples.push({ x: u * cos - v * sin, y: u * sin + v * cos });
              }
            }
            const allowedMisses = Math.floor(samples.length * (1 - minCoverage));
            for (const cand of candidates) {
              const box = labelBox(cand.at, w, h, rotation);
              if (box.left < 0 || box.top < 0) continue;
              if (obstacles.some((o) => overlaps(box, o))) continue;
              let misses = 0;
              for (const s of samples) {
                if (!isOwnedBy(polity.id, cand.at.x + s.x, cand.at.y + s.y) && ++misses > allowedMisses) break;
              }
              if (misses > allowedMisses) continue;
              const coverage = 1 - misses / samples.length;
              const score =
                coverage -
                (cand.offCentre / size) * 0.01 -
                (Math.abs(rotation) / MAX_ROTATION) * 0.03 -
                (layout.lines.length > 1 ? WRAP_PENALTY : 0);
              if (!best || score > best.score) best = { at: cand.at, rotation, lines: layout.lines, score };
            }
          }
        }
        if (best) return { polityId: polity.id, at: best.at, lines: best.lines, size: font, rotation: best.rotation };
      }
      return null;
    };

    const blockers = [...input.obstacles, ...claimed];
    // Prefer clean placements; relax in stages so a realm is named somewhere
    // sensible rather than not at all.
    // A small polity in auto mode gets only the strictest attempt: clear of
    // cities and other names, fully inside its territory.
    const label =
      attempt(blockers, GOOD_COVERAGE, MIN_FONT) ??
      (minHexes === 'auto' && small
        ? null
        : (attempt(claimed, GOOD_COVERAGE, MIN_FONT) ??
          attempt(claimed, SECOND_COVERAGE, MIN_FONT) ??
          attempt(claimed, FALLBACK_COVERAGE, MIN_FONT)));
    if (!label) continue;
    placed.push(label);
    const em = Math.max(...label.lines.map((line) => fantasyTextEm(line)));
    claimed.push(
      labelBox(label.at, em * label.size, label.size * LABEL_HEIGHT_EM * label.lines.length, label.rotation),
    );
  }
  return placed;
}

// --- city names ------------------------------------------------------------------

/** A rotated rectangle: centre, half extents, and rotation in radians. */
export interface OrientedBox {
  cx: number;
  cy: number;
  halfW: number;
  halfH: number;
  rotation: number;
}

function inside(box: OrientedBox, x: number, y: number): boolean {
  const dx = x - box.cx;
  const dy = y - box.cy;
  const c = Math.cos(-box.rotation);
  const s = Math.sin(-box.rotation);
  return Math.abs(dx * c - dy * s) <= box.halfW && Math.abs(dx * s + dy * c) <= box.halfH;
}

export interface CityNameInput {
  id: string;
  name: string;
  at: Point;
  /** Marker radius. */
  r: number;
  /** Larger cities are named first and so get first choice of slot. */
  population: number;
}

export interface CityNamePlacement {
  id: string;
  at: Point;
  anchor: 'start' | 'middle' | 'end';
  /** True when every slot was blocked and the least-blocked one was used. */
  crowded: boolean;
}

/**
 * Place each city's name in the first free slot around its marker: right,
 * left, below, above, then the four diagonals. A slot is free when it clears
 * the realm and river names already on the map, every city marker, every name
 * placed before it, and the map's edge. A name with no free slot takes its
 * least-covered slot, so a realm's name never moves to make room for a city's.
 */
export function placeCityNames(
  cities: CityNameInput[],
  fontSize: number,
  textWidth: (text: string) => number,
  obstacles: OrientedBox[],
  bounds: { width: number; height: number },
): CityNamePlacement[] {
  const order = [...cities].sort((a, b) => b.population - a.population || a.name.localeCompare(b.name));
  const markers: OrientedBox[] = cities.map((c) => ({ cx: c.at.x, cy: c.at.y, halfW: c.r, halfH: c.r, rotation: 0 }));
  const placed: OrientedBox[] = [];
  const out: CityNamePlacement[] = [];
  const h = fontSize * 1.1;
  const gap = fontSize * 0.3;
  for (const city of order) {
    const w = textWidth(city.name);
    const { x, y } = city.at;
    const r = city.r;
    const d = r * 0.75;
    const slots: Array<{ at: Point; anchor: 'start' | 'middle' | 'end'; box: OrientedBox }> = [
      { at: { x: x + r + gap, y }, anchor: 'start', box: { cx: x + r + gap + w / 2, cy: y, halfW: w / 2, halfH: h / 2, rotation: 0 } },
      { at: { x: x - r - gap, y }, anchor: 'end', box: { cx: x - r - gap - w / 2, cy: y, halfW: w / 2, halfH: h / 2, rotation: 0 } },
      { at: { x, y: y + r + gap + h / 2 }, anchor: 'middle', box: { cx: x, cy: y + r + gap + h / 2, halfW: w / 2, halfH: h / 2, rotation: 0 } },
      { at: { x, y: y - r - gap - h / 2 }, anchor: 'middle', box: { cx: x, cy: y - r - gap - h / 2, halfW: w / 2, halfH: h / 2, rotation: 0 } },
      { at: { x: x + d + gap, y: y - d - h / 2 }, anchor: 'start', box: { cx: x + d + gap + w / 2, cy: y - d - h / 2, halfW: w / 2, halfH: h / 2, rotation: 0 } },
      { at: { x: x - d - gap, y: y - d - h / 2 }, anchor: 'end', box: { cx: x - d - gap - w / 2, cy: y - d - h / 2, halfW: w / 2, halfH: h / 2, rotation: 0 } },
      { at: { x: x + d + gap, y: y + d + h / 2 }, anchor: 'start', box: { cx: x + d + gap + w / 2, cy: y + d + h / 2, halfW: w / 2, halfH: h / 2, rotation: 0 } },
      { at: { x: x - d - gap, y: y + d + h / 2 }, anchor: 'end', box: { cx: x - d - gap - w / 2, cy: y + d + h / 2, halfW: w / 2, halfH: h / 2, rotation: 0 } },
    ];
    const ownMarker = markers[cities.indexOf(city)];
    const blockers = [...obstacles, ...markers.filter((m) => m !== ownMarker), ...placed];
    let best = 0;
    let bestCover = Infinity;
    slots.forEach((slot, k) => {
      if (bestCover === 0) return;
      // Sample the slot: the share of points covered is how blocked it is.
      let covered = 0;
      let total = 0;
      for (let i = 0; i < 7; i++) {
        for (let j = 0; j < 3; j++) {
          const px = slot.box.cx + ((i / 6) - 0.5) * 2 * slot.box.halfW;
          const py = slot.box.cy + ((j / 2) - 0.5) * 2 * slot.box.halfH * 0.8;
          total++;
          if (px < 0 || py < 0 || px > bounds.width || py > bounds.height || blockers.some((b) => inside(b, px, py))) covered++;
        }
      }
      const cover = covered / total + k * 1e-3;
      if (covered === 0) {
        best = k;
        bestCover = 0;
      } else if (cover < bestCover) {
        best = k;
        bestCover = cover;
      }
    });
    const slot = slots[best]!;
    placed.push(slot.box);
    out.push({ id: city.id, at: slot.at, anchor: slot.anchor, crowded: bestCover > 0 });
  }
  return out;
}
