/**
 * The land a hex is drawn with once its land share is enforced.
 *
 * A hex's share is the part of it that is land (`landFraction`). The coast the
 * map is traced from knows only whole hexes and the twelve pieces of a split
 * hex (see `surfaceMap`), so a hex that sets a share (or whose type has one)
 * is reshaped here until the land left is exactly that share:
 *
 * - A coast hex (Coastal Land, Glacier, or an Isthmus or mainland hex with no
 *   land beside it) has its sea-facing edges moved in, all by one depth.
 * - A split hex is given a land of uniform width: an Isthmus or a mainland is
 *   a neck of land running from the middle of the hex to each land neighbour,
 *   and a Strait is the hex less a channel running from the middle to each sea
 *   neighbour. The width is found so that the land is exactly the share, so a
 *   neck or a channel stays whole whatever the share, and widens with it.
 *
 * What moved is returned as water drawn over land (`strips`) and land drawn
 * over water (`grown`), and the coast is re-traced round the land that results:
 * the boundary of the union of every hex's land. Where a hex's land no longer
 * reaches the whole of a border it shares with land, the neighbour's coast
 * steps along the border to where it does.
 *
 * Everything is convex polygons, clipped one half-plane at a time, so the
 * areas are exact and the pieces never overlap.
 */

import { hexCenter, hexCorners, hexIndex, inBounds, neighbourOf, type Point } from '../../shared/hex.js';
import { landInsetDepth, piecePoints, type CoastEdge, type Sliver, type SurfaceMap } from './coast.js';
import type { PathCmd } from './prims.js';
import { polygonSliver, sliverPolygon } from './sliver.js';

export type Poly = Point[];

/** A polygon and the hex whose colours it takes. */
export interface Frag {
  poly: Poly;
  donor: number;
}

/** Points closer than this (in map units) are one point. */
const SNAP = 1e-4;
/** Two edges closer than this to one line lie on it. */
const ON_LINE = 1e-3;
/** Area (in hex areas) under which a piece is left out. */
const NEGLIGIBLE = 1e-7;

const snap = (v: number): number => Math.round(v / SNAP) * SNAP;

/** The signed distance of `q` to the right of the line a -> b: positive on the land side of a coast edge. */
function right(a: Point, b: Point, q: Point): number {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len = Math.hypot(ex, ey) || 1;
  return ((q.x - a.x) * -ey + (q.y - a.y) * ex) / len;
}

/** Area of a polygon wound as a hex's corners are. */
export function polyArea(p: Poly): number {
  let sum = 0;
  for (let k = 0; k < p.length; k++) {
    const a = p[k]!;
    const b = p[(k + 1) % p.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/** `poly` cut to one side of the line through a -> b, moved `off` to its right: the right (`keep`) or the left. */
function cut(poly: Poly, a: Point, b: Point, off: number, keep: 'right' | 'left'): Poly {
  const sign = keep === 'right' ? 1 : -1;
  const out: Poly = [];
  const ex = b.x - a.x, ey = b.y - a.y;
  const len = Math.hypot(ex, ey) || 1;
  const side = (q: Point) => sign * (((q.x - a.x) * -ey + (q.y - a.y) * ex) / len - off);
  let vp = poly.length > 0 ? side(poly[0]!) : 0;
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k]!;
    const q = poly[(k + 1) % poly.length]!;
    const vq = side(q);
    if (vp >= 0) out.push(p);
    if (vp >= 0 !== vq >= 0) {
      const t = vp / (vp - vq);
      // Keep intersections in floating-point until the final edge join. Rounding
      // after every clip rotates short edges and makes area fitting discontinuous.
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
    vp = vq;
  }
  return tidy(out);
}

/** A polygon without repeated points, or none if too little is left of it. */
function tidy(poly: Poly): Poly {
  const out: Poly = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < SNAP / 2 && Math.abs(last.y - p.y) < SNAP / 2) continue;
    out.push(p);
  }
  while (out.length > 1 && Math.abs(out[0]!.x - out[out.length - 1]!.x) < SNAP / 2 && Math.abs(out[0]!.y - out[out.length - 1]!.y) < SNAP / 2) out.pop();
  return out.length >= 3 ? out : [];
}

/** The part of `poly` inside the convex `clip`. */
function within(poly: Poly, clip: Poly): Poly {
  let out = poly;
  for (let k = 0; k < clip.length && out.length > 0; k++) out = cut(out, clip[k]!, clip[(k + 1) % clip.length]!, 0, 'right');
  return out;
}

/** The parts of `poly` outside the convex `clip`, as convex pieces that do not overlap. */
function outside(poly: Poly, clip: Poly): Poly[] {
  const parts: Poly[] = [];
  let rest = poly;
  for (let k = 0; k < clip.length && rest.length > 0; k++) {
    const a = clip[k]!;
    const b = clip[(k + 1) % clip.length]!;
    const away = cut(rest, a, b, 0, 'left');
    if (away.length > 0) parts.push(away);
    rest = cut(rest, a, b, 0, 'right');
  }
  return parts;
}


/** `poly` with every polygon in `clips` taken out of it, as convex pieces. */
function without(poly: Poly, clips: Poly[]): Poly[] {
  let frags: Poly[] = [poly];
  for (const clip of clips) frags = frags.flatMap((f) => outside(f, clip));
  return frags;
}

/** Positive-length contact, rather than a point touch that can pinch off. */
function sharedEdge(a: Poly, b: Poly): boolean {
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    const p = a[i]!, q = a[(i + 1) % a.length]!, u = b[j]!, v = b[(j + 1) % b.length]!;
    const dx = q.x - p.x, dy = q.y - p.y, length = Math.hypot(dx, dy);
    if (length < ON_LINE || Math.abs(right(p, q, u)) > 1e-7 || Math.abs(right(p, q, v)) > 1e-7) continue;
    const t0 = ((u.x - p.x) * dx + (u.y - p.y) * dy) / length;
    const t1 = ((v.x - p.x) * dx + (v.y - p.y) * dy) / length;
    if (Math.min(length, Math.max(t0, t1)) - Math.max(0, Math.min(t0, t1)) > ON_LINE) return true;
  }
  return false;
}

/** Keep only land connected by a real edge to a mainland-facing boundary. */
function attachedBanks(polys: Poly[], outline: Poly, dry: number[]): Poly[] {
  const kept = new Set<number>();
  const frontier: number[] = [];
  polys.forEach((p, i) => {
    if (dry.some(e => sharedEdge(p, [outline[e]!, outline[(e + 1) % 6]!]))) { kept.add(i); frontier.push(i); }
  });
  for (let head = 0; head < frontier.length; head++) {
    const p = polys[frontier[head]!]!;
    polys.forEach((q, i) => {
      if (!kept.has(i) && sharedEdge(p, q)) { kept.add(i); frontier.push(i); }
    });
  }
  return polys.filter((_, i) => kept.has(i));
}

/** A polygon wound as a hex's corners are (clockwise on the page), whichever way it was given. */
function wound(poly: Poly): Poly {
  let sum = 0;
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k]!;
    const b = poly[(k + 1) % poly.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum >= 0 ? poly : [...poly].reverse();
}

/** The strip of half-width `r` along the line from `from` to `to`, carried `r` past both ends. */
function arm(from: Point, to: Point, r: number): Poly {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const tail = { x: from.x - ux * r, y: from.y - uy * r };
  const tip = { x: to.x + ux * r, y: to.y + uy * r };
  return wound([
    { x: tail.x - uy * r, y: tail.y + ux * r },
    { x: tip.x - uy * r, y: tip.y + ux * r },
    { x: tip.x + uy * r, y: tip.y - ux * r },
    { x: tail.x + uy * r, y: tail.y - ux * r },
  ]);
}

/** The land and water pieces a split hex is cut into, and the edges its neck or channel runs out of. */
interface Split {
  land: Frag[];
  water: Frag[];
  /** The hex's outline and its middle. */
  hex: Poly;
  centre: Point;
  /** The edges (by index) the arms run to, and `mode`: how they are drawn. */
  edges: number[];
  /**
   * `neck`: land arms from the middle to each edge. `channel`: water arms, the land being
   * what they leave. `bands`: land along each edge, the water being what it leaves.
   */
  mode: 'neck' | 'channel' | 'bands';
  concentrationSide?: number;
  concentration?: number;
}

interface Reshaped {
  /** The hex's land as reshaped. */
  land: Poly[];
  /** Land made water, with the donor of the water that took it. */
  strips: Frag[];
  /** Water made land, with the donor of the land that took it. */
  grown: Frag[];
  /** The water of the hex's own pieces that is left (a split hex only). */
  water: Poly[];
  /** How far in from its edges a coast hex was cut. */
  depth?: number;
}

/**
 * The hex's land when its arms are `r` wide on either side of their middle line
 * (or, for bands, `r` deep). Arms to two edges that meet at a corner are joined
 * by the wedge of hex between them, so that no pocket of the other kind is
 * left cut off at the corner.
 */
function landAt(hex: Split, r: number): Poly[] {
  const { centre, edges, hex: outline } = hex;
  const mid = (e: number): Point => ({ x: (outline[e]!.x + outline[(e + 1) % 6]!.x) / 2, y: (outline[e]!.y + outline[(e + 1) % 6]!.y) / 2 });
  if (hex.mode === 'bands') {
    const strength = (hex.concentration ?? 0) / 100;
    const bands = edges.map((e) => {
      const delta = hex.concentrationSide === undefined ? 0 : ((e - hex.concentrationSide + 9) % 6) - 3;
      const depth = r * (1 + strength * Math.cos(delta * Math.PI / 3) * 0.9);
      return cut(outline, outline[e]!, outline[(e + 1) % 6]!, depth, 'left');
    }).filter((b) => b.length > 0);
    return bands.flatMap((b, k) => without(b, bands.slice(0, k)));
  }
  const shapes: Poly[] = edges.map((e) => arm(centre, mid(e), r));
  for (const e of edges) {
    const next = (e + 1) % 6;
    if (edges.includes(next)) shapes.push(wound([centre, mid(e), outline[next]!, mid(next)]));
  }
  if (hex.mode === 'channel') return without(outline, shapes);
  const clipped = shapes.map((a) => within(a, outline)).filter((a) => a.length > 0);
  return clipped.flatMap((a, k) => without(a, clipped.slice(0, k)));
}

/**
 * The land of a strait or an isthmus drawn `width` wide at its thinnest, whatever edges it meets.
 *
 * An isthmus retains its sectors and central neck. A strait connects one
 * opening per consecutive run of sea-facing sides to a shared junction. Its
 * banks grow independently from mainland edges in connected territories on
 * either side of that passage; they never grow across it into detached land.
 * Selecting a side moves the junction towards that side, inset by half width.
 *
 * `fill` tunes connected bank depths from 0 to 2. An explicit land share is
 * fitted within the range the passage width allows. Below the natural bank
 * area the water becomes wider; above the maximum the chosen width wins and
 * the scene reports the achieved share. Isthmuses retain their minimum neck.
 */
function fixedLand(hex: { hex: Poly; centre: Point; dry: number[]; wet: number[]; junctionSide?: number; bankBias?: readonly number[] }, width: number, kind: 'strait' | 'isthmus', fill = 1): Poly[] {
  const { hex: outline, centre: hexCentre, dry, wet } = hex;
  const mid = (e: number): Point => ({ x: (outline[e]!.x + outline[(e + 1) % 6]!.x) / 2, y: (outline[e]!.y + outline[(e + 1) % 6]!.y) / 2 });
  // A side-selected junction is inset from that edge by half the channel width. This keeps the
  // channel connected through the selected edge rather than collapsing it to a zero-width point.
  const chosen = kind === 'strait' && hex.junctionSide !== undefined ? mid(hex.junctionSide) : hexCentre;
  const distance = Math.hypot(chosen.x - hexCentre.x, chosen.y - hexCentre.y);
  const ratio = distance === 0 ? 0 : Math.max(0, distance - width / 2) / distance;
  const centre = { x: hexCentre.x + (chosen.x - hexCentre.x) * ratio, y: hexCentre.y + (chosen.y - hexCentre.y) * ratio };
  const span = Math.hypot(mid(0).x - mid(3).x, mid(0).y - mid(3).y);
  const band = (e: number, depth: number) => cut(outline, outline[e]!, outline[(e + 1) % 6]!, depth, 'left');
  if (kind === 'strait') {
    // Adjacent sea edges are one mouth, not independent channels. Running an
    // arm to every edge creates water cycles that cut islands out of the banks.
    const mouths: Point[] = [];
    for (const e of wet) {
      if (wet.includes((e + 5) % 6)) continue;
      const run = [e];
      while (wet.includes((run[run.length - 1]! + 1) % 6)) run.push((run[run.length - 1]! + 1) % 6);
      const middle = (run.length - 1) / 2;
      // An even-length mouth exits at the shared corner of its middle edges.
      // Averaging edge midpoints lies inside the hex and can leave a water hole.
      mouths.push(Number.isInteger(middle) ? mid(run[middle]!) : outline[run[Math.ceil(middle)]!]!);
    }
    const channels = mouths.map(p => within(arm(centre, p, width / 2), outline));
    const territory = without(outline, channels);
    // Grow connected banks from their mainland edges within the territories
    // on either side of the passage. Independent depths break paired shores.
    const banks = dry.flatMap(e => {
      const slab = band(e, fill * span * (hex.bankBias?.[e] ?? 1) / 2);
      // A bank grows only in its own connected territory. Letting a deep band
      // cross the channel creates a foreign fragment that later snaps onto the
      // other bank, making both topology and area jump during fitting.
      return attachedBanks(territory, outline, [e]).map(t => within(slab, t)).filter(p => p.length > 0);
    });
    const union = banks.flatMap((p, k) => without(p, banks.slice(0, k)));
    return attachedBanks(solid(union), outline, dry);
  }
  const scale = Math.min(1, fill);
  const rawSectors = dry.map((e): Poly => {
    const whole = wound([centre, outline[e]!, outline[(e + 1) % 6]!]);
    if (scale >= 1 || kind === 'isthmus') return whole;
    const slab = band(e, (scale * span) / 2);
    return slab.length > 0 ? within(whole, slab) : [];
  });
  // (a sector cut right back has no area, and would only confuse the cutting below)
  const sectors = solid(rawSectors);
  const arms = (edges: number[]): Poly[] => edges.map((e) => within(arm(centre, mid(e), width / 2), outline)).filter((a) => a.length > 0);
  const deeper = Math.max(0, fill - 1) * span;
  const grown = deeper > 0 ? dry.map((e) => band(e, deeper)).filter((b) => b.length > 0) : [];
  const pieces = [...sectors, ...grown, ...arms(dry)];
  return pieces.flatMap((b, k) => without(b, pieces.slice(0, k)));
}

/** The fill (see `fixedLand`) at which an isthmus or strait of this width has `target` of the hex as land, or the nearest it can. */
function fillFor(hex: { hex: Poly; centre: Point; dry: number[]; wet: number[]; junctionSide?: number; bankBias?: readonly number[] }, width: number, kind: 'strait' | 'isthmus', target: number, hexArea: number): number {
  const share = (fill: number) => fixedLand(hex, width, kind, fill).reduce((sum, p) => sum + polyArea(p), 0) / hexArea;
  let low = 0;
  let high = 2;
  if (share(low) >= target) return low;
  if (share(high) <= target) return high;
  for (let k = 0; k < 28 && high - low > 1e-5; k++) {
    const mid = (low + high) / 2;
    if (share(mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/** Pieces too thin to be land at all: what cutting leaves where two edges meet at a point. */
function solid(polys: Poly[]): Poly[] {
  return polys.filter((poly) => {
    let edge = 0;
    for (let k = 0; k < poly.length; k++) edge += Math.hypot(poly[(k + 1) % poly.length]!.x - poly[k]!.x, poly[(k + 1) % poly.length]!.y - poly[k]!.y);
    return edge > 0 && (2 * polyArea(poly)) / edge > 0.05;
  });
}

/** The piece among `pieces` that `p` is in, else the one nearest it. */
function nearest(p: Point, pieces: Frag[]): Frag | undefined {
  let best: Frag | undefined;
  let bestDist = Infinity;
  for (const piece of pieces) {
    if (inside(p, piece.poly)) return piece;
    const c = centroid(piece.poly);
    const dist = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
    if (dist < bestDist) {
      bestDist = dist;
      best = piece;
    }
  }
  return best;
}

/**
 * A split hex with its land made `target` of `hexArea`: the neck or channel
 * found whose width gives exactly that, and what that moves against the pieces
 * the hex was cut into.
 */
function reshapeSplit(hex: Split, target: number, hexArea: number): Reshaped {
  const total = (r: number) => landAt(hex, r).reduce((sum, p) => sum + polyArea(p), 0) / hexArea;
  // Land less the share: a neck or a band gains land as it widens, a channel loses it.
  const off = (r: number) => (hex.mode === 'channel' ? target - total(r) : total(r) - target);
  let low = 0;
  let high = Math.hypot(hex.hex[0]!.x - hex.hex[3]!.x, hex.hex[0]!.y - hex.hex[3]!.y);
  let fLow = off(low);
  let fHigh = off(high);
  // Regula falsi (Illinois): the area is smooth in the width, so a few tries are enough.
  let side = 0;
  let r = high;
  for (let k = 0; k < 30 && Math.abs(fLow) > 1e-7 && Math.abs(fHigh) > 1e-7 && high - low > high * 1e-7; k++) {
    r = fHigh === fLow ? (low + high) / 2 : high - (fHigh * (high - low)) / (fHigh - fLow);
    if (!(r > low && r < high)) r = (low + high) / 2;
    const f = off(r);
    if (Math.abs(f) < 1e-7) {
      low = high = r;
      break;
    }
    if (f < 0 === fLow < 0) {
      low = r;
      fLow = f;
      if (side === -1) fHigh /= 2;
      side = -1;
    } else {
      high = r;
      fHigh = f;
      if (side === 1) fLow /= 2;
      side = 1;
    }
  }
  const width = Math.abs(fLow) <= Math.abs(fHigh) ? low : high;
  return setAgainst(landAt(hex, width), hex.land, hex.water, hexArea);
}

/**
 * How far a lake's shore beside a split hex must move from the boundary of the hex's
 * water pieces for the land left to be `target` of `hexArea`: into the land (positive)
 * when the hex has more land than that, into the water (negative) when it has less.
 * The boundary of every water piece (or land piece) moves by the same distance.
 */
function lakeShoreOffset(land: Frag[], water: Frag[], target: number, hexArea: number, domain: Poly): number {
  const natural = land.reduce((sum, f) => sum + polyArea(f.poly), 0) / hexArea;
  if (Math.abs(natural - target) < 1e-5) return 0;
  const shrinking = target < natural;
  const dilate = (poly: Poly, d: number): Poly => {
    let out = domain;
    for (let k = 0; k < poly.length && out.length > 0; k++) out = cut(out, poly[k]!, poly[(k + 1) % poly.length]!, -d, 'right');
    return out;
  };
  const landAt = (d: number): number => {
    if (shrinking) {
      const wet = water.map((w) => dilate(w.poly, d));
      return land.reduce((sum, l) => sum + without(l.poly, wet).reduce((a, p) => a + polyArea(p), 0), 0) / hexArea;
    }
    const dry = land.map((l) => dilate(l.poly, d));
    const taken = water.reduce((sum, w) => sum + without(w.poly, []).reduce((a, p) => a + polyArea(p), 0) - without(w.poly, dry).reduce((a, p) => a + polyArea(p), 0), 0);
    return natural + taken / hexArea;
  };
  let low = 0;
  let high = Math.hypot(domain[0]!.x - domain[2]!.x, domain[0]!.y - domain[2]!.y);
  for (let k = 0; k < 36 && high - low > high * 1e-6; k++) {
    const mid = (low + high) / 2;
    if (shrinking ? landAt(mid) > target : landAt(mid) < target) low = mid;
    else high = mid;
  }
  return shrinking ? (low + high) / 2 : -(low + high) / 2;
}

/**
 * What reshaping a split hex to `land` moves against the pieces it was cut into:
 * the land the pieces had and `land` does not (water drawn over it, in the donor
 * of the nearest water), and the water `land` takes (land drawn over it).
 */
function setAgainst(shaped: Poly[], was: Frag[], water: Frag[], hexArea: number): Reshaped {
  const land = shaped.filter((p) => polyArea(p) > NEGLIGIBLE * hexArea);
  const strips: Frag[] = [];
  for (const piece of was) {
    for (const poly of without(piece.poly, land)) {
      if (polyArea(poly) > NEGLIGIBLE * hexArea) strips.push({ poly, donor: nearest(centroid(poly), water)?.donor ?? piece.donor });
    }
  }
  const grown: Frag[] = [];
  for (const piece of water) {
    for (const t of land) {
      const made = within(piece.poly, t);
      if (made.length > 0 && polyArea(made) > NEGLIGIBLE * hexArea) grown.push({ poly: made, donor: nearest(centroid(made), was)?.donor ?? piece.donor });
    }
  }
  const left = water.flatMap((piece) => without(piece.poly, land)).filter((p) => polyArea(p) > NEGLIGIBLE * hexArea);
  return { land, strips, grown, water: left };
}

/**
 * A coast hex cut back from its sea-facing edges until the land left is `target`:
 * the hex with each edge in `wet` moved in by one depth. The water it gives up is
 * returned edge by edge, each strip in the water of the edge it came from.
 */
function reshapeCoastHex(
  corners: Poly,
  wet: CoastEdge[],
  target: number,
  lake: CoastEdge[] = [],
  concentrationSide?: number,
  concentration = 0,
  joins: number[] = [],
): Reshaped | null {
  if (wet.length === 0 && lake.length === 0) return null;
  if (target >= 1) return null;
  // Edges against a lake count towards the depth but are not cut: the lake is drawn over the hex.
  const allWet = [...wet, ...lake];
  const strength = concentration / 100;
  const multiplier = (edge: CoastEdge): number => {
    if (concentrationSide === undefined || strength === 0) return 1;
    const centre = centroid(corners);
    const midpoint = { x: (edge.from.x + edge.to.x) / 2, y: (edge.from.y + edge.to.y) / 2 };
    const chosen = {
      x: ((corners[concentrationSide]!.x + corners[(concentrationSide + 1) % 6]!.x) / 2) - centre.x,
      y: ((corners[concentrationSide]!.y + corners[(concentrationSide + 1) % 6]!.y) / 2) - centre.y,
    };
    const facing = ((midpoint.x - centre.x) * chosen.x + (midpoint.y - centre.y) * chosen.y)
      / (Math.hypot(midpoint.x - centre.x, midpoint.y - centre.y) * Math.hypot(chosen.x, chosen.y));
    // Cut least at the chosen edge and most at its opposite, keeping every multiplier positive.
    return 1 - 0.9 * strength * facing;
  };
  const full = polyArea(corners);
  const share = Math.max(0, Math.min(1, target));
  if (joins.length && !lake.length && share > 0) {
    const centre = centroid(corners), size = Math.hypot(corners[0]!.x - centre.x, corners[0]!.y - centre.y);
    const landAt = (depth: number) => {
      let core = corners;
      for (const edge of wet) core = cut(core, edge.from, edge.to, depth * multiplier(edge), 'right');
      if (!core.length) return [];
      const root = centroid(core);
      const bridges = joins.map(e => within(arm(root, { x: (corners[e]!.x + corners[(e + 1) % 6]!.x) / 2,
        y: (corners[e]!.y + corners[(e + 1) % 6]!.y) / 2 }, size * 0.04 * Math.min(1, share / 0.1)), corners));
      const pieces = [core, ...bridges];
      return pieces.flatMap((p, k) => without(p, pieces.slice(0, k)));
    };
    let low = 0, high = size * 2;
    for (let k = 0; k < 28; k++) {
      const middle = (low + high) / 2;
      if (landAt(middle).reduce((sum, p) => sum + polyArea(p), 0) / full > share) low = middle;
      else high = middle;
    }
    const depth = (low + high) / 2, land = landAt(depth);
    return { land, strips: without(corners, land).map(poly => ({ poly, donor: wet[0]!.water })), grown: [], water: [], depth };
  }
  let low = 0;
  let high = Math.hypot(corners[0]!.x - corners[3]!.x, corners[0]!.y - corners[3]!.y);
  for (let k = 0; k < 24; k++) {
    const middle = (low + high) / 2;
    let shape = corners;
    for (const edge of allWet) shape = cut(shape, edge.from, edge.to, middle * multiplier(edge), 'right');
    if (shape.length >= 3 && polyArea(shape) / full > share) low = middle;
    else high = middle;
  }
  const depth = concentrationSide === undefined || strength === 0
    ? landInsetDepth(corners, allWet, target)
    : (low + high) / 2;
  const strips: Frag[] = [];
  let rest: Poly = corners;
  for (const e of wet) {
    const edgeDepth = depth * multiplier(e);
    const away = cut(rest, e.from, e.to, edgeDepth, 'left');
    if (away.length > 0) strips.push({ poly: away, donor: e.water });
    rest = cut(rest, e.from, e.to, edgeDepth, 'right');
  }
  return { land: rest.length > 0 ? [rest] : [], strips, grown: [], water: [], depth };
}

/** What reshaping a hex gives and takes, and the land it is left with. */
export interface HexShape {
  /** A split hex beside a lake: only the lake's shore moves, by `depth`, and nothing else is reshaped. */
  lake?: boolean;
  depth?: number;
  strips: Frag[];
  grown: Frag[];
  water?: PathCmd[];
  land: Land[];
}

/** What the traced coast is rebuilt from: a polygon of land, and the hex it is part of. */
interface Land {
  poly: Poly;
  /** Bounds of `poly`, to skip polygons nowhere near an edge. */
  box?: [number, number, number, number];
  hex: number;
  /** The hex whose colours the land takes: fixed, or found for each edge. */
  donor: number | ((at: Point) => number);
}

const toPath = (poly: Poly): PathCmd[] => [...poly.map((q, k) => [k === 0 ? 'M' : 'L', q.x, q.y] as PathCmd), ['Z'] as PathCmd];

/** What each hex was last cut to (see `shapeCoast`). */
export type ShapeMemo = Map<string, { sig: string; result: HexShape | null }>;

export interface ShapedCoast {
  /** The sea coast, traced round the land as reshaped. */
  edges: CoastEdge[];
  /** Land drawn as water. Never overlapping, so they can be cut out of a clip together. */
  strips: Sliver[];
  /** Water drawn as land. */
  grown: Sliver[];
  /** The water left in each reshaped split hex, by hex: what the hex's water pieces are cut to. */
  water: Map<number, PathCmd[]>;
  /** The land each reshaped hex is left with, by hex. */
  land: Map<number, Poly[]>;
  /** How far in from its edges each cut coast hex was cut (see `lakeBodyPath`, which draws a lake shore that far in). */
  insets: Map<number, number>;
}

/**
 * What a hex is to be reshaped to: the part of it that is land, and how.
 *
 * - `inset`: the hex cut back from its sea-facing edges (a coast hex, or any hex with no land beside it).
 * - `neck`: land of uniform width from the middle to each land neighbour (an isthmus).
 * - `channel`: water of uniform width from the middle to each sea neighbour, the
 *   land being what it leaves (a strait).
 *
 * A split hex of kind `inset` (a mainland) is land laid along the edges it shares
 * with land, as deep as its share needs, so that it stays joined to them.
 */
export interface ShapeTarget {
  share: number;
  kind: 'inset' | 'neck' | 'channel';
  concentrationSide?: number;
  concentration?: number;
  /**
   * For a `neck` or `channel`: how wide it is, in pixels. The arm is then drawn at that width however
   * many neighbours it runs to, and `share` is not aimed at (a fixed width has no share to find).
   */
  width?: number;
  /** With `width`: also aim at `share`, tuning how much land the hex has (see `fixedLand`). Without it the share is not aimed at. */
  fit?: boolean;
  /** For a channel, move its common junction towards this hex side; absent leaves it central. */
  junctionSide?: number;
  /** Independent seeded bank depths, indexed by hex side. */
  bankBias?: readonly number[];
  /** Preserve a coastal mainland's joins to land adjoining a split passage. */
  keepJoins?: boolean;
}

/**
 * Reshape the hexes in `targets` and trace the sea coast again round the result.
 * `seaEdges` is the coast of the hexes as they are (`surfaceEdges`): a coast hex
 * is cut back from its edges. Null when nothing needs to move, which leaves the
 * coast as it was traced.
 */
export function shapeCoast(
  seaEdges: CoastEdge[],
  surface: SurfaceMap,
  size: number,
  targets: ReadonlyMap<number, ShapeTarget>,
  /** The edges hexes have against a lake: they count towards a coast hex's depth but are not cut. */
  lakeEdges: CoastEdge[] = [],
  /** What each hex was last cut to, kept between calls on the same coast: a hex whose share has not changed is not cut again. */
  memo?: ShapeMemo,
): ShapedCoast | null {
  const { cols, rows } = surface;
  const hexArea = 1.5 * Math.sqrt(3) * size * size;
  const lakeWet = new Map<number, CoastEdge[]>();
  for (const edge of lakeEdges) {
    if (edge.hex !== undefined && targets.has(edge.hex) && !surface.split.has(edge.hex)) lakeWet.set(edge.hex, [...(lakeWet.get(edge.hex) ?? []), edge]);
  }
  const wetEdges = new Map<number, CoastEdge[]>();
  for (const edge of seaEdges) {
    if (edge.hex !== undefined && targets.has(edge.hex) && !surface.split.has(edge.hex)) {
      wetEdges.set(edge.hex, [...(wetEdges.get(edge.hex) ?? []), edge]);
    }
  }

  /** One hex cut to its share: what it gives up, what it takes, and the land it is left with. */
  const reshapeHex = (i: number, { share, kind, width, fit, concentrationSide, concentration, junctionSide, bankBias, keepJoins }: ShapeTarget): HexShape | null => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const split = surface.split.get(i);
    const corners = hexCorners(col, row, size);
    if (!split) {
      const joins = keepJoins ? [0, 1, 2, 3, 4, 5].filter(e => {
        const n = neighbourOf(col, row, e);
        if (!inBounds(cols, rows, n.col, n.row)) return false;
        const j = hexIndex(cols, n.col, n.row);
        return surface.split.get(j)?.sides[6 + (e + 3) % 6] === 'land' || surface.whole[j] === 'land';
      }) : [];
      const result = reshapeCoastHex(corners, wetEdges.get(i) ?? [], share, lakeWet.get(i) ?? [], concentrationSide, concentration, joins);
      return result ? { depth: result.depth, strips: result.strips, grown: [], land: result.land.map((poly) => ({ poly, hex: i, donor: i })) } : null;
    }
    const pieces = split.sides.map((side, p) => ({ side, poly: piecePoints(col, row, p, size), donor: split.donors[p]! }));
    const land = pieces.filter((p) => p.side === 'land');
    if (split.sides.some((s) => s === 'lake')) {
      // A lake has a body of its own, drawn over the hex: only its shore moves (see `lakeBodyPath`).
      const c = hexCenter(col, row, size);
      const r = size * 3;
      const domain: Poly = [{ x: c.x - r, y: c.y - r }, { x: c.x + r, y: c.y - r }, { x: c.x + r, y: c.y + r }, { x: c.x - r, y: c.y + r }];
      const offset = lakeShoreOffset(land, pieces.filter((p) => p.side === 'lake'), share, hexArea, domain);
      return offset === 0 ? null : { depth: offset, strips: [], grown: [], land: [] , lake: true };
    }
    const water = pieces.filter((p) => p.side === 'sea');
    const dry = [0, 1, 2, 3, 4, 5].filter((e) => split.sides[6 + e] === 'land');
    const wet = [0, 1, 2, 3, 4, 5].filter((e) => split.sides[6 + e] === 'sea');
    // A strait or isthmus of a set width has no share to find (see `fixedLand`).
    if (width !== undefined && kind !== 'inset') {
      if (dry.length === 0 || wet.length === 0) return null;
      const shape = { hex: corners, centre: hexCenter(col, row, size), dry, wet, junctionSide, bankBias };
      const type = kind === 'channel' ? 'strait' : 'isthmus';
      const fill = fit ? fillFor(shape, width, type, share, hexArea) : 1;
      const fixed = setAgainst(solid(fixedLand(shape, width, type, fill)), land, water, hexArea);
      const at = (p: Point) => nearest(p, land)?.donor ?? i;
      return { strips: fixed.strips, grown: fixed.grown, water: fixed.water.flatMap(toPath), land: fixed.land.map((poly) => ({ poly, hex: i, donor: at })) };
    }
    // A neck to three land edges, or a channel from three sea edges, would leave the hex's
    // other kind in pockets; and a mainland has no neck to run. Those hexes are land laid
    // along their land edges instead, deeper as the share grows, so that it stays joined to them.
    const mode = kind === 'channel' ? (wet.length >= 3 ? 'bands' : 'channel') : kind === 'neck' && dry.length < 3 ? 'neck' : 'bands';
    const arms = mode === 'channel' ? wet : dry;
    if (arms.length === 0) return null;
    const result = reshapeSplit({ land, water, hex: corners, centre: hexCenter(col, row, size), edges: arms, mode, concentrationSide, concentration }, share, hexArea);
    const donorAt = (at: Point) => nearest(at, land)?.donor ?? i;
    return {
      strips: result.strips,
      grown: result.grown,
      water: result.water.flatMap(toPath),
      land: result.land.map((poly) => ({ poly, hex: i, donor: donorAt })),
    };
  };
  const strips: Frag[] = [];
  const grown: Frag[] = [];
  const waterLeft = new Map<number, PathCmd[]>();
  const insets = new Map<number, number>();
  const reshaped = new Map<number, Land[]>();
  for (const [i, target] of targets) {
    // The same hex, cut to the same share among the same neighbours, is cut the same way.
    const code = (j: number) => `${surface.whole[j]}${surface.split.get(j)?.sides.join('') ?? ''}`;
    const sig = [target.share, target.kind, target.width ?? '', target.fit ? 'fit' : '', target.junctionSide ?? '-', target.bankBias?.join(',') ?? '', target.keepJoins ? 'joins' : '', target.concentrationSide ?? '-', target.concentration ?? 0, code(i), ...[0, 1, 2, 3, 4, 5].map((e) => {
      const n = neighbourOf(i % cols, Math.floor(i / cols), e);
      return inBounds(cols, rows, n.col, n.row) ? code(hexIndex(cols, n.col, n.row)) : '-';
    })].join('|');
    const memoKey = `${size}:${cols}:${rows}:${i}`;
    let done = memo?.get(memoKey);
    if (!done || done.sig !== sig) {
      done = { sig, result: reshapeHex(i, target) };
      memo?.set(memoKey, done);
    }
    const result = done.result;
    if (!result) continue;
    strips.push(...result.strips);
    grown.push(...result.grown);
    if (result.water) waterLeft.set(i, result.water);
    if (result.depth !== undefined) insets.set(i, result.depth);
    if (result.lake) continue;
    reshaped.set(i, result.land);
  }
  if (reshaped.size === 0 && insets.size === 0) return null;

  // Every hex's land, hex by hex: whole hexes and unmoved pieces as they were.
  // Only a reshaped hex and the hexes beside it can have a different coast.
  const touched = new Set<number>();
  for (const i of reshaped.keys()) {
    touched.add(i);
    for (let e = 0; e < 6; e++) {
      const n = neighbourOf(i % cols, Math.floor(i / cols), e);
      if (inBounds(cols, rows, n.col, n.row)) touched.add(hexIndex(cols, n.col, n.row));
    }
  }
  const landOf = (i: number): Land[] => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const here = reshaped.get(i);
    if (here) return here;
    const split = surface.split.get(i);
    if (split) {
      const out: Land[] = [];
      split.sides.forEach((side, p) => {
        if (side !== 'sea') out.push({ poly: piecePoints(col, row, p, size), hex: i, donor: split.donors[p]! });
      });
      return out;
    }
    return surface.whole[i] === 'land' || surface.whole[i] === 'lake' ? [{ poly: hexCorners(col, row, size), hex: i, donor: i }] : [];
  };
  const byHex = new Map<number, Land[]>();
  const lands = (i: number): Land[] => {
    let here = byHex.get(i);
    if (!here) {
      here = landOf(i);
      byHex.set(i, here);
    }
    return here;
  };

  // Strips by the hex they lie in, to tell what water a coast edge now meets.
  const stripsOf = new Map<number, Frag[]>();
  for (const frag of strips) {
    const j = nearestHex(centroid(frag.poly), cols, rows, size);
    stripsOf.set(j, [...(stripsOf.get(j) ?? []), frag]);
  }

  const edges: CoastEdge[] = seaEdges.filter((e) => e.hex === undefined || !touched.has(e.hex));
  for (const i of [...touched].sort((u, v) => u - v)) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const near: Land[] = [...lands(i)];
    // Edges of the hex that lie on the edge of the map: not coast, however the land ends there.
    const corners = hexCorners(col, row, size);
    const rim: Array<[Point, Point]> = [];
    for (let e = 0; e < 6; e++) {
      const n = neighbourOf(col, row, e);
      if (inBounds(cols, rows, n.col, n.row)) near.push(...lands(hexIndex(cols, n.col, n.row)));
      else rim.push([corners[e]!, corners[(e + 1) % 6]!]);
    }
    for (const land of lands(i)) {
      const poly = land.poly;
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k]!;
        const b = poly[(k + 1) % poly.length]!;
        if (rim.some(([u, v]) => Math.abs(right(u, v, a)) < ON_LINE && Math.abs(right(u, v, b)) < ON_LINE)) continue;
        for (const [from, to] of splitLong(freeParts(a, b, land, near), surface.split.has(land.hex) ? size * 1.05 : Infinity)) {
          const probe = probeLeft(from, to, size);
          const j = nearestHex(probe, cols, rows, size);
          const onto = probeLeft(to, from, size);
          edges.push({
            from,
            to,
            land: typeof land.donor === 'number' ? land.donor : land.donor(onto),
            water: waterDonorAt(probe, j, surface, stripsOf, cols, size),
            hex: land.hex,
            across: j,
          });
        }
      }
    }
  }

  // A sliver too thin to see would still be stroked, as a hairline across the hex.
  const sliver = (f: Frag): Sliver => polygonSliver(f.poly, f.donor);
  const real = (f: Frag) => {
    let edge = 0;
    for (let k = 0; k < f.poly.length; k++) edge += Math.hypot(f.poly[(k + 1) % f.poly.length]!.x - f.poly[k]!.x, f.poly[(k + 1) % f.poly.length]!.y - f.poly[k]!.y);
    return edge > 0 && (2 * polyArea(f.poly)) / edge > 0.05;
  };
  // Independently clipped neighbours can round the same intersection on
  // opposite sides of a quantisation boundary. Canonicalise within the same
  // tolerance used to remove shared edges, so their coast ends really join.
  const vertices = new Map<string, Point[]>();
  const vertex = (p: Point): Point => {
    const x = Math.floor(p.x / ON_LINE), y = Math.floor(p.y / ON_LINE);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const match = vertices.get(`${x + dx},${y + dy}`)?.find(q => Math.hypot(q.x - p.x, q.y - p.y) <= ON_LINE);
      if (match) return match;
    }
    const key = `${x},${y}`;
    vertices.set(key, [...(vertices.get(key) ?? []), p]);
    return p;
  };
  const joined = edges.map(e => ({ ...e, from: vertex(e.from), to: vertex(e.to) }))
    .filter(e => e.from !== e.to);
  return { edges: joined, strips: strips.filter(real).map(sliver), grown: grown.filter(real).map(sliver), water: waterLeft, insets, land: new Map([...reshaped].map(([i, lands]) => [i, lands.map((l) => l.poly)])) };
}

const centroid = (poly: Poly): Point => ({
  x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
  y: poly.reduce((s, p) => s + p.y, 0) / poly.length,
});

/** The hex a point lies in: the one whose centre is nearest. */
export function nearestHex(p: Point, cols: number, rows: number, size: number): number {
  // Pointy-top odd-r layout: estimate the row, then look at the hexes round it.
  const row0 = Math.round((p.y - size) / (size * 1.5));
  let best = -1;
  let bestDist = Infinity;
  for (let row = Math.max(0, row0 - 1); row <= Math.min(rows - 1, row0 + 1); row++) {
    const col0 = Math.round((p.x - (size * Math.sqrt(3)) / 2) / (size * Math.sqrt(3)) - 0.5 * (row & 1));
    for (let col = Math.max(0, col0 - 1); col <= Math.min(cols - 1, col0 + 1); col++) {
      const c = hexCenter(col, row, size);
      const dist = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = hexIndex(cols, col, row);
      }
    }
  }
  return best;
}

/** A point just off the water side of the edge from -> to, to find what is there. */
function probeLeft(from: Point, to: Point, size: number): Point {
  const ex = to.x - from.x;
  const ey = to.y - from.y;
  const len = Math.hypot(ex, ey) || 1;
  const reach = size * 0.01;
  return { x: (from.x + to.x) / 2 + (ey / len) * reach, y: (from.y + to.y) / 2 - (ex / len) * reach };
}

function inside(p: Point, poly: Poly): boolean {
  for (let k = 0; k < poly.length; k++) {
    if (right(poly[k]!, poly[(k + 1) % poly.length]!, p) < 0) return false;
  }
  return true;
}

/** The hex whose colours the water at `p` (in hex `j`) takes: the water that took the land there, else the hex's own. */
function waterDonorAt(
  p: Point,
  j: number,
  surface: SurfaceMap,
  stripsOf: ReadonlyMap<number, Frag[]>,
  cols: number,
  size: number,
): number {
  const taken = stripsOf.get(j)?.find((f) => inside(p, f.poly));
  if (taken) return taken.donor;
  const split = surface.split.get(j);
  if (split) {
    const col = j % cols;
    const row = Math.floor(j / cols);
    for (let piece = 0; piece < 12; piece++) {
      if (split.sides[piece] !== 'land' && inside(p, piecePoints(col, row, piece, size))) return split.donors[piece]!;
    }
  }
  return j;
}

/**
 * The parts of the edge a -> b of `land` that are coast: those with no other
 * land against them. The rest is shared with land on its other side (a seam
 * between two pieces of a hex, or a border between two land hexes). Each part
 * runs between the points where some other polygon has a corner on the edge,
 * so that the coast chains up end to end.
 */
function freeParts(a: Point, b: Point, own: Land, near: Land[]): Array<[Point, Point]> {
  const ex = b.x - a.x;
  const ey = b.y - a.y;
  const len = Math.hypot(ex, ey);
  if (len < ON_LINE) return [];
  const along = (q: Point) => ((q.x - a.x) * ex + (q.y - a.y) * ey) / len;
  // Distance from the line through a and b, times its length: no square root per point.
  const tol = ON_LINE * len;
  const onLine = (q: Point) => Math.abs((q.x - a.x) * -ey + (q.y - a.y) * ex) < tol;
  const x0 = Math.min(a.x, b.x) - ON_LINE;
  const x1 = Math.max(a.x, b.x) + ON_LINE;
  const y0 = Math.min(a.y, b.y) - ON_LINE;
  const y1 = Math.max(a.y, b.y) + ON_LINE;
  // Corners of other polygons on this edge, and the stretches of it that land lies against.
  const stops: Array<{ at: number; p: Point }> = [
    { at: 0, p: a },
    { at: len, p: b },
  ];
  const shared: Array<[number, number]> = [];
  for (const other of near) {
    if (other === own) continue;
    const box = (other.box ??= boxOf(other.poly));
    if (box[2] < x0 || box[0] > x1 || box[3] < y0 || box[1] > y1) continue;
    const poly = other.poly;
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k]!;
      const q = poly[(k + 1) % poly.length]!;
      // Test the short edge against its neighbour's longer line too. Snapping
      // a tiny fragment rotates its line enough that distant neighbour corners
      // fail the opposite test, leaving dangling coast ends at a mainland join.
      if ((q.x - p.x) * ex + (q.y - p.y) * ey < 0 &&
        Math.abs(right(p, q, a)) < ON_LINE && Math.abs(right(p, q, b)) < ON_LINE) {
        shared.push([along(q), along(p)]);
      }
      if (!onLine(p)) continue;
      const s = along(p);
      if (s > ON_LINE && s < len - ON_LINE) stops.push({ at: s, p });
      // Against this edge, running the other way.
      if (onLine(q) && along(q) < s) shared.push([along(q), s]);
    }
  }
  stops.sort((u, v) => u.at - v.at);
  const parts: Array<[Point, Point]> = [];
  for (let k = 0; k + 1 < stops.length; k++) {
    const from = stops[k]!;
    const to = stops[k + 1]!;
    if (to.at - from.at < ON_LINE) continue;
    const middle = (from.at + to.at) / 2;
    if (shared.some(([lo, hi]) => lo <= middle && middle <= hi)) continue;
    parts.push([from.p, to.p]);
  }
  return parts;
}

const boxOf = (poly: Poly): [number, number, number, number] => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return [x0, y0, x1, y1];
};

/** The point of the polygons nearest `p`, and how far off: 0 when `p` lies inside one. */
export function nearestOn(p: Point, polys: Poly[]): { dist: number; at: Point } {
  let best = { dist: Infinity, at: p };
  for (const poly of polys) {
    if (inside(p, poly)) return { dist: 0, at: p };
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k]!;
      const b = poly[(k + 1) % poly.length]!;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / (ex * ex + ey * ey || 1)));
      const at = { x: a.x + ex * t, y: a.y + ey * t };
      const dist = Math.hypot(p.x - at.x, p.y - at.y);
      if (dist < best.dist) best = { dist, at };
    }
  }
  return best;
}

/**
 * The area inside the convex `clip` that the closed outlines `rings` cover
 * between them, overlaps counted once. Measured on a fine run of lines across
 * `clip`, which is accurate to a fraction of a percent of the hex.
 */
export function coveredArea(rings: Point[][], clip: Poly, lines = 96): number {
  return areaCoverage(rings)(clip, lines);
}

/** Prepare immutable outlines for repeated area measurements within one fitting pass. */
export function areaCoverage(rings: Point[][], options?: {
  evenOdd?: boolean;
  stroke?: { rings: Point[][]; reach: number };
}): (clip: Poly, lines?: number) => number {
  const band = 8;
  const prepared = rings.map(ring => {
    const bins = new Map<number, Array<[Point, Point]>>();
    ring.forEach((a, k) => {
      const b = ring[(k + 1) % ring.length]!;
      if (a.y === b.y) return;
      for (let y = Math.floor(Math.min(a.y, b.y) / band); y <= Math.floor(Math.max(a.y, b.y) / band); y++) {
        let bin = bins.get(y);
        if (!bin) { bin = []; bins.set(y, bin); }
        bin.push([a, b]);
      }
    });
    return { box: boxOf(ring), bins };
  });
  const radius = options?.stroke?.reach ?? 0;
  const strokes = radius > 0 ? options!.stroke!.rings.flatMap(ring => ring.flatMap((a, k) => {
    if (k + 1 >= ring.length) return [];
    const b = ring[k + 1]!, length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!length) return [];
    const dx = (b.y - a.y) / length * radius, dy = (a.x - b.x) / length * radius;
    return [{ poly: [{ x: a.x + dx, y: a.y + dy }, { x: b.x + dx, y: b.y + dy },
      { x: b.x - dx, y: b.y - dy }, { x: a.x - dx, y: a.y - dy }], a, b,
      box: [Math.min(a.x, b.x) - radius, Math.min(a.y, b.y) - radius,
        Math.max(a.x, b.x) + radius, Math.max(a.y, b.y) + radius] }];
  })) : [];
  return (clip, lines = 96) => {
    const top = Math.min(...clip.map((p) => p.y));
    const bottom = Math.max(...clip.map((p) => p.y));
    const step = (bottom - top) / lines;
    const x0 = Math.min(...clip.map(p => p.x)), x1 = Math.max(...clip.map(p => p.x));
    const nearbyStroke = strokes.filter(s => s.box[2]! >= x0 && s.box[0]! <= x1 && s.box[3]! >= top && s.box[1]! <= bottom);
    // Preserve all ray crossings (including those outside the clip), but discard
    // rings outside its bounds and edges that cannot cross any measuring line.
    const relevant = prepared.filter(({ box }) => !(box[2] < x0 || box[0] > x1 || box[3] < top || box[1] > bottom));
    let total = 0;
    for (let n = 0; n < lines; n++) {
      const y = top + (n + 0.5) * step;
      // The width of `clip` on this line.
      let left = Infinity;
      let right = -Infinity;
      for (let k = 0; k < clip.length; k++) {
        const a = clip[k]!;
        const b = clip[(k + 1) % clip.length]!;
        if (a.y <= y !== b.y <= y) {
          const x = a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x);
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
      }
      if (!(right > left)) continue;
      // Where each outline is on this line, as stretches of x.
      const runs: Array<[number, number]> = [];
      const crossings: number[] = [];
      for (const { bins } of relevant) {
        const xs: number[] = [];
        for (const [a, b] of bins.get(Math.floor(y / band)) ?? []) {
          if (a.y <= y !== b.y <= y) xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
        if (options?.evenOdd) crossings.push(...xs);
        else {
          xs.sort((u, v) => u - v);
          for (let k = 0; k + 1 < xs.length; k += 2) runs.push([Math.max(left, xs[k]!), Math.min(right, xs[k + 1]!)]);
        }
      }
      if (options?.evenOdd) {
        crossings.sort((a, b) => a - b);
        for (let k = 0; k + 1 < crossings.length; k += 2) runs.push([Math.max(left, crossings[k]!), Math.min(right, crossings[k + 1]!)]);
      }
      // Union the round coastline stroke with land, rather than estimating ink
      // as perimeter times width (which counts overlaps and outside-hex ink).
      for (const s of nearbyStroke) {
        if (y < s.box[1]! || y > s.box[3]!) continue;
        const xs: number[] = [];
        for (let k = 0; k < 4; k++) {
          const a = s.poly[k]!, b = s.poly[(k + 1) % 4]!;
          if (a.y <= y !== b.y <= y) xs.push(a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x));
        }
        if (xs.length >= 2) runs.push([Math.max(left, Math.min(...xs)), Math.min(right, Math.max(...xs))]);
        for (const p of [s.a, s.b]) {
          const dy = y - p.y;
          if (Math.abs(dy) >= radius) continue;
          const dx = Math.sqrt(radius * radius - dy * dy);
          runs.push([Math.max(left, p.x - dx), Math.min(right, p.x + dx)]);
        }
      }
      runs.sort((u, v) => u[0] - v[0]);
      let reach = -Infinity;
      for (const [from, to] of runs) {
        if (to <= from) continue;
        const start = Math.max(from, reach);
        if (to > start) total += (to - start) * step;
        reach = Math.max(reach, to);
      }
    }
    return total;
  };
}

/**
 * Land that the smoothing and roughening of a coast adds to (positive) or takes
 * from (negative) each of the hexes in `of`, in area: the slivers it repaints,
 * cut to the hexes they lie in. `cut` are the corners cut off, less the first
 * `strips` of them, which are land reshaping took and not the smoothing.
 */
export function driftOf(
  slivers: { toWater: Sliver[]; toLand: Sliver[] },
  strips: number,
  of: ReadonlySet<number>,
  cols: number,
  rows: number,
  size: number,
  flatten: (d: PathCmd[]) => Point[][],
): Map<number, number> {
  const drift = new Map<number, number>();
  const clips = new Map<number, { poly: Poly; box: [number, number, number, number] }>();
  const spread = (slivers: Sliver[], sign: number) => {
    for (const sliver of slivers) {
      const points = sliverPolygon(sliver);
      for (const ring of points ? [points] : flatten(sliver.d)) {
        const poly = wound(tidy(ring));
        if (poly.length < 3) continue;
        const here = nearestHex(centroid(poly), cols, rows, size);
        const col = here % cols;
        const row = Math.floor(here / cols);
        const near = [here];
        for (let e = 0; e < 6; e++) {
          const n = neighbourOf(col, row, e);
          if (inBounds(cols, rows, n.col, n.row)) near.push(hexIndex(cols, n.col, n.row));
        }
        const bounds = boxOf(poly);
        for (const j of near) {
          if (!of.has(j)) continue;
          let clip = clips.get(j);
          if (!clip) { const poly = hexCorners(j % cols, Math.floor(j / cols), size); clip = { poly, box: boxOf(poly) }; clips.set(j, clip); }
          const box = clip.box;
          if (bounds[2] < box[0] - ON_LINE || bounds[0] > box[2] + ON_LINE || bounds[3] < box[1] - ON_LINE || bounds[1] > box[3] + ON_LINE) continue;
          const part = within(poly, clip.poly);
          if (part.length >= 3) drift.set(j, (drift.get(j) ?? 0) + sign * polyArea(part));
        }
      }
    }
  };
  spread(slivers.toWater.slice(strips), -1);
  spread(slivers.toLand, 1);
  return drift;
}

/**
 * Parts of a coast longer than `longest` cut into equal pieces, so that a neck or channel
 * edge is roughened along its length and not only at its ends, as the short edges of a
 * hex cut into pieces always were.
 */
function splitLong(parts: Array<[Point, Point]>, longest: number): Array<[Point, Point]> {
  return parts.flatMap(([a, b]) => {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / longest);
    if (n <= 1) return [[a, b] as [Point, Point]];
    const stops = Array.from({ length: n + 1 }, (_, k) =>
      k === 0 ? a : k === n ? b : { x: snap(a.x + ((b.x - a.x) * k) / n), y: snap(a.y + ((b.y - a.y) * k) / n) });
    return stops.slice(1).map((q, k) => [stops[k]!, q] as [Point, Point]);
  });
}

/**
 * The length of the drawn coast that belongs to each hex of `of`: every stretch of `paths` is given to the
 * nearest of the hexes in `of` to its middle (the land hex, where a stretch lies on an edge it shares with water).
 * Used to count the coastline's ink as part of a hex's land.
 */
export function coastLengthIn(
  paths: Point[][],
  of: ReadonlySet<number>,
  cols: number,
  rows: number,
  size: number,
): Map<number, number> {
  const length = new Map<number, number>();
  for (const ring of paths) {
    for (let k = 0; k + 1 < ring.length; k++) {
      const a = ring[k]!;
      const b = ring[k + 1]!;
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const here = nearestHex(m, cols, rows, size);
      let best = -1;
      let bestDist = Infinity;
      const col = here % cols;
      const row = Math.floor(here / cols);
      const near = [here];
      for (let e = 0; e < 6; e++) {
        const n = neighbourOf(col, row, e);
        if (inBounds(cols, rows, n.col, n.row)) near.push(hexIndex(cols, n.col, n.row));
      }
      for (const j of near) {
        if (!of.has(j)) continue;
        const c = hexCenter(j % cols, Math.floor(j / cols), size);
        const d = Math.hypot(c.x - m.x, c.y - m.y);
        if (d < bestDist) {
          bestDist = d;
          best = j;
        }
      }
      if (best >= 0) length.set(best, (length.get(best) ?? 0) + Math.hypot(b.x - a.x, b.y - a.y));
    }
  }
  return length;
}
