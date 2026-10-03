/**
 * Map furniture: the frame, title, scale bar and compass.
 *
 * Furniture is added to a finished scene as more primitives, so the PNG and the
 * SVG draw it identically. Where each piece goes is decided by a search, not a
 * fixed corner: a piece may sit only on open sea, clear of every name, city
 * marker, other piece and the legend. The search runs on a coarse grid of the
 * page (see `OccupancyGrid`) in which land, the legend's panel and everything
 * that carries lettering are blocked; the candidates nearest a piece's preferred
 * corner win. A piece that fits nowhere is set in the margin band round the
 * frame instead, which grows on that side only as far as the piece needs. The
 * audit (see audit.ts) re-checks the result rectangle against rectangle.
 *
 * The band exists because the frame is not drawn over the map: the page is
 * grown by a margin on every side, filled with parchment, and the map sits
 * inside it. Nothing of the map is covered, and the band is guaranteed empty.
 */

import { gridPixelSize, pixelToOffset, type Point } from '../../shared/hex.js';
import { normaliseHexDimensions } from '../../shared/surfaceArea.js';
import type { MapState } from '../../shared/types.js';
import { boxesOverlap, OccupancyGrid, rectBox, textPrims, textBoxes } from './collide.js';
import { fantasyTextEm, textEm } from './fonts.js';
import type { OrientedBox } from './labels.js';
import type { PathCmd, Prim } from './prims.js';
import { mix, withLandOf, type FurniturePlacement, type Scene } from './scene.js';
import { CLASSIC_STYLE, type MapStyle } from './styles.js';

export interface MarginaliaOptions {
  /** A double rule just inside the page's edge, with a parchment margin band between it and the map. */
  frame: boolean;
  /** The map's name, set in open sea. */
  title: boolean;
  /** A scale bar derived from the width of one hex. */
  scaleBar: boolean;
  /** A compass rose. */
  compass: boolean;
}

export const DEFAULT_MARGINALIA: MarginaliaOptions = { frame: true, title: true, scaleBar: true, compass: true };

export function marginaliaWanted(o: MarginaliaOptions | null | undefined): o is MarginaliaOptions {
  return !!o && (o.frame || o.title || o.scaleBar || o.compass);
}

/** The margin band's colour: the legend panel's paper. */
export const PARCHMENT = '#f6f1e4';
const FRAME_INK = '#2a2118';
const LIGHT_INK = '#f3ead2';

/** Colours for lettering and linework on one surface. */
interface Ink {
  ink: string;
  paper: string;
  halo: string;
}

const BAND_INK: Ink = { ink: FRAME_INK, paper: PARCHMENT, halo: PARCHMENT };

function luminance(colour: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(colour);
  if (!m) return 0;
  const n = parseInt(m[1]!, 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}

/** Ink for the sea: light on a dark sea, dark on a pale one. */
function seaInk(sea: string): Ink {
  return luminance(sea) < 0.5
    ? { ink: LIGHT_INK, paper: mix(sea, LIGHT_INK, 0.2), halo: mix(sea, '#000000', 0.35) }
    : { ink: FRAME_INK, paper: mix(sea, '#ffffff', 0.5), halo: mix(sea, '#ffffff', 0.6) };
}

// --- the pieces ------------------------------------------------------------

interface Piece {
  kind: 'title' | 'scale' | 'compass';
  /** Width and height of the rectangle the piece occupies. */
  w: number;
  h: number;
  /** The primitives, with the rectangle's centre at `c`. */
  build: (c: Point, ink: Ink) => Prim[];
}

/** Lengths a scale bar is rounded to: 1, 2, 2.5 and 5 times a power of ten. */
const NICE = [1, 2, 2.5, 5];

/** The longest round length, in map units, whose bar is no wider than `maxUnits`. */
export function niceLength(maxUnits: number): number {
  if (!(maxUnits > 0) || !Number.isFinite(maxUnits)) return 1;
  const exp = Math.floor(Math.log10(maxUnits));
  let best = 0;
  for (const e of [exp - 1, exp]) {
    for (const f of NICE) {
      const v = f * 10 ** e;
      if (v <= maxUnits * (1 + 1e-9) && v > best) best = v;
    }
  }
  return best;
}

function formatValue(v: number): string {
  return String(Number(v.toFixed(3)));
}

/**
 * The scale bar's length. One hex is `hexDimensions.width` units across, flat to
 * flat, and the pointy-top grid lays hexes that same distance apart along a row,
 * so a unit is `size * sqrt(3) / width` pixels along the page's horizontal.
 */
export function scaleBarFor(map: MapState, size: number, maxPx: number): { units: number; px: number; unit: string } {
  const dims = normaliseHexDimensions(map.hexDimensions);
  const pxPerUnit = (size * Math.sqrt(3)) / dims.width;
  const units = niceLength(maxPx / pxPerUnit);
  return { units, px: units * pxPerUnit, unit: dims.unit || 'km' };
}

function scalePiece(map: MapState, size: number, mapWidth: number): Piece {
  const hexPx = size * Math.sqrt(3);
  const { units, px, unit } = scaleBarFor(map, size, Math.min(7 * hexPx, 0.3 * mapWidth));
  const lf = Math.max(9, size * 0.42);
  const bar = Math.max(3, size * 0.14);
  const gap = Math.max(2, size * 0.1);
  const lastLabel = `${formatValue(units)} ${unit}`;
  const left = (textEm('0', FANTASY, 600) * lf) / 2;
  const right = Math.max((textEm(lastLabel, FANTASY, 600) * lf) / 2, left);
  const w = left + px + right;
  const h = lf + gap + bar;
  return {
    kind: 'scale',
    w,
    h,
    build: (c, ink) => {
      const x0 = c.x - w / 2 + left;
      const top = c.y - h / 2;
      const barY0 = top + lf + gap;
      const stroke = Math.max(1, size * 0.04);
      const out: Prim[] = [];
      const parts = 4;
      for (let k = 0; k < parts; k++) {
        const a = x0 + (px * k) / parts;
        const b = x0 + (px * (k + 1)) / parts;
        out.push({
          kind: 'polygon',
          points: [{ x: a, y: barY0 }, { x: b, y: barY0 }, { x: b, y: barY0 + bar }, { x: a, y: barY0 + bar }],
          fill: k % 2 === 0 ? ink.ink : ink.paper,
          stroke: ink.ink,
          strokeWidth: stroke,
        });
      }
      const labels: Array<[number, string]> = [
        [0, '0'],
        [px / 2, formatValue(units / 2)],
        [px, lastLabel],
      ];
      for (const [dx, text] of labels) {
        out.push({
          kind: 'polyline',
          points: [{ x: x0 + dx, y: barY0 - gap * 0.8 }, { x: x0 + dx, y: barY0 }],
          stroke: ink.ink,
          strokeWidth: stroke,
        });
        out.push({
          kind: 'text',
          at: { x: x0 + dx, y: top + lf / 2 - gap * 0.4 },
          text,
          size: lf,
          fill: ink.ink,
          halo: ink.halo,
          weight: 600,
          anchor: 'middle',
          fantasy: true,
          tag: { kind: 'scale' },
        });
      }
      return out;
    },
  };
}

const FANTASY = '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif';

function titlePiece(name: string, size: number, mapWidth: number, scale = 1, rules = true): Piece {
  let fs = size * 1.2 * scale;
  const em = fantasyTextEm(name, 700);
  // A long name is set smaller rather than allowed to run across half the sea.
  fs = Math.min(fs, (0.5 * mapWidth) / Math.max(1, em));
  const tw = em * fs;
  const w = tw + fs * 0.8;
  const h = rules ? fs * 2.1 : fs * 1.2;
  return {
    kind: 'title',
    w,
    h,
    build: (c, ink) => {
      const out: Prim[] = [];
      if (rules) {
        const stroke = Math.max(1, size * 0.04);
        for (const dy of [-h / 2 + stroke, h / 2 - stroke]) {
          out.push({
            kind: 'polyline',
            points: [{ x: c.x - w / 2, y: c.y + dy }, { x: c.x + w / 2, y: c.y + dy }],
            stroke: ink.ink,
            strokeWidth: stroke,
          });
        }
      }
      out.push({
        kind: 'text',
        at: { x: c.x, y: c.y },
        text: name,
        size: fs,
        fill: ink.ink,
        halo: ink.halo,
        weight: 700,
        anchor: 'middle',
        fantasy: true,
        tag: { kind: 'title' },
      });
      return out;
    },
  };
}

function compassPiece(size: number): Piece {
  const d = size * 3.4;
  return {
    kind: 'compass',
    w: d,
    h: d,
    build: (c, ink) => {
      const cx = c.x;
      const cy = c.y + d * 0.07;
      const R = d * 0.36;
      const stroke = Math.max(1, size * 0.035);
      const out: Prim[] = [];
      const at = (angle: number, r: number): [number, number] => [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
      out.push({ kind: 'circle', c: { x: cx, y: cy }, r: R * 0.62, stroke: ink.ink, strokeWidth: stroke });
      // A point is two triangles sharing its axis, one dark and one light.
      const point = (angle: number, length: number, waist: number, fillA: string, fillB: string): Prim[] => {
        const [tx, ty] = at(angle, length);
        const [ax, ay] = at(angle - Math.PI / 4, waist);
        const [bx, by] = at(angle + Math.PI / 4, waist);
        const tri = (px: number, py: number, fill: string): Prim => ({
          kind: 'path',
          d: [['M', tx, ty], ['L', cx, cy], ['L', px, py], ['Z']] as PathCmd[],
          fill,
          stroke: ink.ink,
          strokeWidth: stroke,
          round: true,
        });
        return [tri(ax, ay, fillA), tri(bx, by, fillB)];
      };
      for (let k = 0; k < 4; k++) {
        out.push(...point(-Math.PI / 4 + (k * Math.PI) / 2, R * 0.55, R * 0.16, ink.paper, ink.ink));
      }
      // The cardinal points over the lesser ones; north is the longest.
      const cardinals = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
      cardinals.forEach((angle, k) => {
        out.push(...point(angle, k === 0 ? R : k === 2 ? R * 0.88 : R * 0.8, R * 0.2, ink.ink, ink.paper));
      });
      out.push({
        kind: 'text',
        at: { x: cx, y: cy - R - size * 0.3 },
        text: 'N',
        size: size * 0.5,
        fill: ink.ink,
        halo: ink.halo,
        weight: 700,
        anchor: 'middle',
        fantasy: true,
        tag: { kind: 'compass' },
      });
      return out;
    },
  };
}

// --- placement -------------------------------------------------------------

type Side = 'top' | 'right' | 'bottom' | 'left';

interface Placed {
  piece: Piece;
  c: Point;
  where: 'sea' | 'band';
  ink: Ink;
}

/** Where on the map each kind of piece prefers to sit: corners and edges, in order of preference. */
function targets(kind: Piece['kind'], w: number, h: number, mapW: number, mapH: number, pad: number): Point[] {
  const left = pad + w / 2;
  const right = mapW - pad - w / 2;
  const top = pad + h / 2;
  const bottom = mapH - pad - h / 2;
  if (kind === 'title') return [{ x: mapW / 2, y: top }, { x: mapW / 2, y: bottom }];
  if (kind === 'scale') return [{ x: left, y: bottom }, { x: right, y: bottom }, { x: left, y: top }];
  return [{ x: left, y: top }, { x: left, y: bottom }, { x: right, y: top }, { x: right, y: bottom }];
}

export function addMarginalia(
  map: MapState,
  scene: Scene,
  size: number,
  opts: MarginaliaOptions,
  style: MapStyle = CLASSIC_STYLE,
): Scene {
  if (!marginaliaWanted(opts)) return scene;
  const u = size / 32;
  const { cols, rows } = map;
  const { width: mapW, height: mapH } = gridPixelSize(cols, rows, size);
  const W = scene.width;
  const H = scene.height;
  const base = map.layers.base.data;
  const sea = seaInk(style.palette.sea);

  const pieces: Piece[] = [];
  if (opts.title && map.name.trim()) pieces.push(titlePiece(map.name.trim(), size, mapW));
  if (opts.compass) pieces.push(compassPiece(size));
  if (opts.scaleBar) pieces.push(scalePiece(map, size, mapW));

  // --- what the pieces must keep clear of ---
  const cell = Math.max(2, size / 4);
  const clearance = size * 0.45;
  const grid = new OccupancyGrid(W, H, cell);
  grid.blockWhere((x, y) => {
    // Past the map is the legend's panel, or page the map does not reach.
    if (x >= mapW || y >= mapH) return true;
    if (!base) return false;
    const { col, row } = pixelToOffset(x, y, size);
    const c = Math.min(cols - 1, Math.max(0, col));
    const r = Math.min(rows - 1, Math.max(0, row));
    return base[r * cols + c] !== 'Sea';
  });
  const obstacles: OrientedBox[] = [
    ...textPrims(scene.prims).filter((p) => p.tag).flatMap(textBoxes),
    ...(scene.markers ?? []),
  ];
  for (const o of obstacles) grid.blockBox(o, clearance);

  // --- open sea ---
  const placed: Placed[] = [];
  const boxOf = (p: Piece, c: Point): OrientedBox => ({ cx: c.x, cy: c.y, halfW: p.w / 2, halfH: p.h / 2, rotation: 0 });
  const apart = size * 2; // the gap kept between the compass and the title, and from the scale bar
  const toBand: Piece[] = [];
  for (const piece of pieces) {
    const goals = targets(piece.kind, piece.w, piece.h, mapW, mapH, clearance);
    const title = placed.find((p) => p.piece.kind === 'title');
    const keepAway = placed.filter((p) => piece.kind === 'compass' ? p.piece.kind !== 'scale' : true);
    let best: { c: Point; cost: number } | null = null;
    const x0 = Math.ceil((clearance + piece.w / 2) / cell) * cell;
    for (let cy = clearance + piece.h / 2; cy <= mapH - clearance - piece.h / 2; cy += cell) {
      for (let cx = x0; cx <= mapW - clearance - piece.w / 2; cx += cell) {
        const c = { x: cx, y: cy };
        if (!grid.rectFree(cx - piece.w / 2 - clearance, cy - piece.h / 2 - clearance, cx + piece.w / 2 + clearance, cy + piece.h / 2 + clearance)) continue;
        const box = boxOf(piece, c);
        if (keepAway.some((p) => boxesOverlap(box, boxOf(p.piece, p.c), apart / 2))) continue;
        let cost = Math.min(...goals.map((g, k) => Math.hypot(cx - g.x, cy - g.y) + k * size * 2));
        // The compass sits as far from the title as the corners allow.
        if (piece.kind === 'compass' && title) cost -= 0.4 * Math.hypot(cx - title.c.x, cy - title.c.y);
        if (!best || cost < best.cost) best = { c, cost };
      }
    }
    if (!best) {
      toBand.push(piece);
      continue;
    }
    placed.push({ piece, c: best.c, where: 'sea', ink: sea });
    grid.blockBox(boxOf(piece, best.c), clearance);
  }

  // --- the margin band ---
  const frameOn = opts.frame;
  const bandEdge = frameOn ? 18 * u : 2 * u; // from the page's edge to where the band's free room begins
  const inner = 3 * u; // between that room and the map, and round a piece
  const base0 = frameOn ? 56 * u : 0;
  const margin: Record<Side, number> = { top: base0, right: base0, bottom: base0, left: base0 };
  const room = (s: Side) => Math.max(0, margin[s] - bandEdge - 2 * inner);
  const horizontal = (s: Side) => s === 'top' || s === 'bottom';
  /** How much of the band's depth a piece takes on a side. */
  const depthOn = (p: Piece, s: Side) => (horizontal(s) ? p.h : p.w);
  const prefer = (k: Piece['kind']): Side[] =>
    k === 'title' ? ['top', 'bottom', 'left', 'right'] : k === 'scale' ? ['bottom', 'top', 'right', 'left'] : ['left', 'right', 'top', 'bottom'];
  interface InBand {
    piece: Piece;
    side: Side;
    /** Centre of the piece along its side, in page coordinates of the map's own frame. */
    along: number;
  }
  const inBand: InBand[] = [];
  for (const wanted of toBand) {
    const sides = prefer(wanted.kind);
    let piece = wanted;
    let side = sides.find((s) => room(s) >= depthOn(piece, s));
    if (!side && wanted.kind === 'title') {
      // A title is made smaller to fit the band before the band is made larger.
      for (const k of [0.8, 0.65, 0.5]) {
        const smaller = titlePiece(map.name.trim(), size, mapW, k, false);
        const s = sides.find((s2) => room(s2) >= depthOn(smaller, s2));
        if (s) {
          piece = smaller;
          side = s;
          break;
        }
      }
    }
    // Otherwise its first choice, grown to hold it.
    side ??= sides[0]!;
    margin[side] = Math.max(margin[side], bandEdge + 2 * inner + depthOn(piece, side));
    // Along the side: the piece's preferred place first, then onward, until clear of what is there.
    const span = horizontal(side) ? W : H;
    const length = horizontal(side) ? piece.w : piece.h;
    const steps = Math.ceil(span / cell);
    const order: number[] = [];
    for (let t = 0; t <= steps; t++) {
      if (piece.kind === 'title') order.push(span / 2 + (t % 2 === 0 ? 1 : -1) * Math.ceil(t / 2) * cell);
      else if (piece.kind === 'scale') order.push(length / 2 + clearance + t * cell);
      else order.push(span - length / 2 - clearance - t * cell);
    }
    const taken = inBand.filter((o) => o.side === side).map((o) => [o.along - (horizontal(side!) ? o.piece.w : o.piece.h) / 2, o.along + (horizontal(side!) ? o.piece.w : o.piece.h) / 2]);
    const along =
      order.find((a) => a - length / 2 >= 0 && a + length / 2 <= span && taken.every(([lo, hi]) => a + length / 2 + inner <= lo! || a - length / 2 - inner >= hi!)) ??
      span / 2;
    inBand.push({ piece, side, along });
  }
  // With the margins final, each piece is centred in the room beside the map.
  const bandPlaced: Placed[] = inBand.map(({ piece, side, along }) => {
    // The free room spans from `inner` beside the map to `inner` short of the frame's rules.
    const centre = (margin[side] - bandEdge) / 2;
    const c: Point =
      side === 'top' ? { x: along, y: -centre }
      : side === 'bottom' ? { x: along, y: H + centre }
      : side === 'left' ? { x: -centre, y: along }
      : { x: W + centre, y: along };
    return { piece, c, where: 'band', ink: BAND_INK };
  });
  placed.push(...bandPlaced);

  // --- assemble ---
  const furniture: FurniturePlacement[] = placed.map((p) => ({ kind: p.piece.kind, box: boxOf(p.piece, p.c), where: p.where }));
  if (W > mapW) furniture.push({ kind: 'legend', box: rectBox(mapW, 0, W, H), where: 'panel' });
  const furniturePrims = placed.flatMap((p) => p.piece.build(p.c, p.ink));

  const banded = frameOn || bandPlaced.length > 0;
  if (!banded) {
    return withLandOf({ ...scene, prims: [...scene.prims, ...furniturePrims], furniture, origin: { x: 0, y: 0 } }, scene);
  }
  const total = { w: W + margin.left + margin.right, h: H + margin.top + margin.bottom };
  const transparent = scene.background === 'transparent';
  const rect = (x0: number, y0: number, x1: number, y1: number) => [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
  ];
  const prims: Prim[] = [];
  if (!transparent) prims.push({ kind: 'polygon', points: rect(0, 0, total.w, total.h), fill: PARCHMENT });
  const content: Prim[] = [];
  if (!transparent) content.push({ kind: 'polygon', points: rect(0, 0, W, H), fill: scene.background });
  content.push(...scene.prims, ...furniturePrims);
  content.push({ kind: 'polygon', points: rect(0, 0, W, H), stroke: FRAME_INK, strokeWidth: Math.max(1, u) });
  prims.push({ kind: 'group', translate: { x: margin.left, y: margin.top }, prims: content });
  if (frameOn) {
    prims.push({ kind: 'polygon', points: rect(9 * u, 9 * u, total.w - 9 * u, total.h - 9 * u), stroke: FRAME_INK, strokeWidth: 3 * u });
    prims.push({ kind: 'polygon', points: rect(15 * u, 15 * u, total.w - 15 * u, total.h - 15 * u), stroke: FRAME_INK, strokeWidth: Math.max(1, u) });
  }
  return withLandOf(
    {
      ...scene,
      width: total.w,
      height: total.h,
      background: transparent ? 'transparent' : PARCHMENT,
      prims,
      furniture,
      origin: { x: margin.left, y: margin.top },
    },
    scene,
  );
}
