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

export interface LabelObstacle extends LabelBox {}

export interface LabelInput {
  cols: number;
  rows: number;
  size: number;
  owner: (string | null)[];
  polities: { id: string; name: string; shortName?: string }[];
  /** Markers and names already on the map that a polity name should not cover. */
  obstacles: LabelObstacle[];
}

const LABEL_HEIGHT_EM = LABEL_LINE_EM;
/** Preference for keeping a name on one line when wrapping gains nothing. */
const WRAP_PENALTY = 0.02;
const MIN_FONT = 7;
const GOOD_COVERAGE = 0.92;
const FALLBACK_COVERAGE = 0.78;
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
    // Tiny territories are keyed by colour in the legend instead. A name
    // cannot fit legibly inside one to three hexes at any useful zoom.
    if (owned.length <= 3) continue;

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
    const idealSize = size * 0.28 * Math.sqrt(owned.length);

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
    const label =
      attempt(blockers, GOOD_COVERAGE, MIN_FONT) ??
      attempt(claimed, GOOD_COVERAGE, MIN_FONT) ??
      attempt(claimed, FALLBACK_COVERAGE, MIN_FONT);
    if (!label) continue;
    placed.push(label);
    const em = Math.max(...label.lines.map((line) => fantasyTextEm(line)));
    claimed.push(
      labelBox(label.at, em * label.size, label.size * LABEL_HEIGHT_EM * label.lines.length, label.rotation),
    );
  }
  return placed;
}
