/**
 * Collision geometry shared by the map furniture (title, scale bar, compass,
 * legend) and the label audit.
 *
 * Everything the furniture must keep clear of is reduced to two things: rotated
 * rectangles (names and city markers) and the hexes that are not open sea. The
 * placer rasterises both onto a coarse grid so a candidate can be tested in
 * constant time; the audit tests the same things exactly, rectangle against
 * rectangle, so a placement the grid let through is still checked independently.
 */

import { FANTASY_FONT_STACK, FONT_STACK, textEm } from './fonts.js';
import type { OrientedBox } from './labels.js';
import type { Prim } from './prims.js';

export type TextPrim = Extract<Prim, { kind: 'text' }>;

/** Height of a line of lettering's ink, as a share of its type size: capitals and descenders, not the line pitch. */
const INK_HEIGHT_EM = 0.8;
/** Width given to a glyph whose advance is not known, in em. */
const GLYPH_EM = 0.62;

/** Every text primitive in `prims`, groups included. */
export function textPrims(prims: Prim[]): TextPrim[] {
  const out: TextPrim[] = [];
  for (const p of prims) {
    if (p.kind === 'text') out.push(p);
    else if (p.kind === 'group') out.push(...textPrims(p.prims));
  }
  return out;
}

/**
 * The rectangles a piece of lettering occupies: one for text set whole, one per
 * glyph for text set along a curve (a curved name does not fill the box that
 * encloses it).
 */
export function textBoxes(p: TextPrim): OrientedBox[] {
  const family = p.font ?? (p.fantasy ? FANTASY_FONT_STACK : FONT_STACK);
  const halfH = (p.size * INK_HEIGHT_EM) / 2;
  if (p.glyphs && p.glyphs.length > 0) {
    return p.glyphs.map((g) => ({
      cx: g.x,
      cy: g.y,
      halfW: Math.max(p.size * 0.12, (textEm(g.ch, family, p.weight ?? 600, p.italic) || GLYPH_EM) * p.size) / 2,
      halfH,
      rotation: g.rotation,
    }));
  }
  const width = textEm(p.text, family, p.weight ?? 600, p.italic) * p.size;
  const anchor = p.anchor ?? 'middle';
  const along = anchor === 'start' ? width / 2 : anchor === 'end' ? -width / 2 : 0;
  const rotation = p.rotation ?? 0;
  return [
    {
      cx: p.at.x + along * Math.cos(rotation),
      cy: p.at.y + along * Math.sin(rotation),
      halfW: width / 2,
      halfH,
      rotation,
    },
  ];
}

/**
 * Whether two rotated rectangles overlap, each grown by `pad` on every side:
 * the separating-axis test, exact for rectangles.
 */
export function boxesOverlap(a: OrientedBox, b: OrientedBox, pad = 0): boolean {
  const aw = a.halfW + pad;
  const ah = a.halfH + pad;
  const bw = b.halfW + pad;
  const bh = b.halfH + pad;
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  const reach = Math.hypot(aw, ah) + Math.hypot(bw, bh);
  if (dx * dx + dy * dy > reach * reach) return false;
  const ac = Math.cos(a.rotation);
  const as = Math.sin(a.rotation);
  const bc = Math.cos(b.rotation);
  const bs = Math.sin(b.rotation);
  const axes: Array<[number, number]> = [
    [ac, as],
    [-as, ac],
    [bc, bs],
    [-bs, bc],
  ];
  for (const [ux, uy] of axes) {
    const ra = aw * Math.abs(ux * ac + uy * as) + ah * Math.abs(ux * -as + uy * ac);
    const rb = bw * Math.abs(ux * bc + uy * bs) + bh * Math.abs(ux * -bs + uy * bc);
    if (Math.abs(dx * ux + dy * uy) >= ra + rb) return false;
  }
  return true;
}

/** Whether (x, y) lies inside `box` grown by `pad`. */
export function boxContains(box: OrientedBox, x: number, y: number, pad = 0): boolean {
  const dx = x - box.cx;
  const dy = y - box.cy;
  const c = Math.cos(box.rotation);
  const s = Math.sin(box.rotation);
  return Math.abs(dx * c + dy * s) <= box.halfW + pad && Math.abs(-dx * s + dy * c) <= box.halfH + pad;
}

/** The axis-aligned rectangle that encloses `box` grown by `pad`. */
export function boxBounds(box: OrientedBox, pad = 0): { x0: number; y0: number; x1: number; y1: number } {
  const c = Math.abs(Math.cos(box.rotation));
  const s = Math.abs(Math.sin(box.rotation));
  const hw = (box.halfW + pad) * c + (box.halfH + pad) * s;
  const hh = (box.halfW + pad) * s + (box.halfH + pad) * c;
  return { x0: box.cx - hw, y0: box.cy - hh, x1: box.cx + hw, y1: box.cy + hh };
}

/** An axis-aligned rectangle as an oriented box. */
export function rectBox(x0: number, y0: number, x1: number, y1: number): OrientedBox {
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, halfW: (x1 - x0) / 2, halfH: (y1 - y0) / 2, rotation: 0 };
}

/**
 * A page rasterised into square cells, each either free or blocked, with a
 * summed-area table so "is this rectangle entirely free" is four lookups.
 * Cells are sampled at their centres, so callers grow what they block by about
 * half a cell (the placer's clearance is several cells, which covers it).
 */
export class OccupancyGrid {
  readonly cols: number;
  readonly rows: number;
  private readonly blocked: Uint8Array;
  private sums: Int32Array | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly cell: number,
  ) {
    this.cols = Math.max(1, Math.ceil(width / cell));
    this.rows = Math.max(1, Math.ceil(height / cell));
    this.blocked = new Uint8Array(this.cols * this.rows);
  }

  /** Block every cell whose centre `test` says is taken. */
  blockWhere(test: (x: number, y: number) => boolean): void {
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (test((c + 0.5) * this.cell, (r + 0.5) * this.cell)) this.blocked[r * this.cols + c] = 1;
      }
    }
    this.sums = null;
  }

  blockBox(box: OrientedBox, pad = 0): void {
    const b = boxBounds(box, pad);
    const c0 = Math.max(0, Math.floor(b.x0 / this.cell));
    const c1 = Math.min(this.cols - 1, Math.floor(b.x1 / this.cell));
    const r0 = Math.max(0, Math.floor(b.y0 / this.cell));
    const r1 = Math.min(this.rows - 1, Math.floor(b.y1 / this.cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (boxContains(box, (c + 0.5) * this.cell, (r + 0.5) * this.cell, pad)) this.blocked[r * this.cols + c] = 1;
      }
    }
    this.sums = null;
  }

  private table(): Int32Array {
    if (this.sums) return this.sums;
    const w = this.cols + 1;
    const t = new Int32Array(w * (this.rows + 1));
    for (let r = 0; r < this.rows; r++) {
      let run = 0;
      for (let c = 0; c < this.cols; c++) {
        run += this.blocked[r * this.cols + c]!;
        t[(r + 1) * w + c + 1] = t[r * w + c + 1]! + run;
      }
    }
    this.sums = t;
    return t;
  }

  /** Whether every cell the rectangle touches is free. A rectangle off the page is not free. */
  rectFree(x0: number, y0: number, x1: number, y1: number): boolean {
    if (x0 < 0 || y0 < 0 || x1 > this.width || y1 > this.height) return false;
    const c0 = Math.floor(x0 / this.cell);
    const c1 = Math.min(this.cols - 1, Math.floor(x1 / this.cell));
    const r0 = Math.floor(y0 / this.cell);
    const r1 = Math.min(this.rows - 1, Math.floor(y1 / this.cell));
    const t = this.table();
    const w = this.cols + 1;
    const taken = t[(r1 + 1) * w + c1 + 1]! - t[r0 * w + c1 + 1]! - t[(r1 + 1) * w + c0]! + t[r0 * w + c0]!;
    return taken === 0;
  }
}
