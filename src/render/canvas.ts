import { FANTASY_FONT_STACK, FONT_STACK } from './fonts.js';
import type { PathCmd, Prim } from './prims.js';
import type { Scene } from './scene.js';
import { MAP_COLOURS } from './palette.js';
import type { GrainTile } from './texture.js';

type Ctx = CanvasRenderingContext2D;

export function drawScene(ctx: Ctx, scene: Scene): void {
  drawPrims(ctx, scene.prims);
}

export function drawPrims(ctx: Ctx, prims: Prim[]): void {
  for (const prim of prims) drawPrim(ctx, prim);
}

function tracePath(ctx: Ctx, d: PathCmd[]): void {
  ctx.beginPath();
  for (const c of d) {
    switch (c[0]) {
      case 'M': ctx.moveTo(c[1], c[2]); break;
      case 'L': ctx.lineTo(c[1], c[2]); break;
      case 'Q': ctx.quadraticCurveTo(c[1], c[2], c[3], c[4]); break;
      case 'C': ctx.bezierCurveTo(c[1], c[2], c[3], c[4], c[5], c[6]); break;
      case 'Z': ctx.closePath(); break;
    }
  }
}

/** One canvas per tile, reused: building the pattern source is the expensive part. */
const tileCanvases = new Map<string, HTMLCanvasElement | OffscreenCanvas>();

function tileSource(tile: GrainTile): HTMLCanvasElement | OffscreenCanvas | null {
  const hit = tileCanvases.get(tile.id);
  if (hit) return hit;
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(tile.size, tile.size);
  else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = tile.size;
    canvas.height = tile.size;
  } else return null;
  const tctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!tctx) return null;
  tctx.putImageData(new ImageData(new Uint8ClampedArray(tile.rgba), tile.size, tile.size), 0, 0);
  tileCanvases.set(tile.id, canvas);
  return canvas;
}

function drawPrim(ctx: Ctx, prim: Prim): void {
  switch (prim.kind) {
    case 'path': {
      tracePath(ctx, prim.d);
      if (prim.fill) {
        ctx.fillStyle = prim.fill;
        ctx.fill(prim.fillRule ?? 'nonzero');
      }
      if (prim.stroke) {
        ctx.strokeStyle = prim.stroke;
        ctx.lineWidth = prim.strokeWidth ?? 1;
        ctx.lineJoin = prim.round ? 'round' : 'miter';
        ctx.lineCap = prim.round ? 'round' : 'butt';
        ctx.setLineDash(prim.dash ?? []);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineJoin = 'miter';
        ctx.lineCap = 'butt';
      }
      break;
    }
    case 'group': {
      ctx.save();
      if (prim.clip) {
        tracePath(ctx, prim.clip);
        ctx.clip('nonzero');
      }
      drawPrims(ctx, prim.prims);
      ctx.restore();
      break;
    }
    case 'texture': {
      const source = tileSource(prim.tile);
      const pattern = source ? ctx.createPattern(source as CanvasImageSource, 'repeat') : null;
      if (!pattern) break;
      ctx.fillStyle = pattern;
      ctx.fillRect(prim.x, prim.y, prim.width, prim.height);
      break;
    }
    case 'polygon': {
      ctx.beginPath();
      prim.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.closePath();
      if (prim.fill) {
        ctx.fillStyle = prim.fill;
        ctx.fill();
      }
      if (prim.stroke) {
        ctx.strokeStyle = prim.stroke;
        ctx.lineWidth = prim.strokeWidth ?? 1;
        ctx.stroke();
      }
      break;
    }
    case 'polyline': {
      ctx.beginPath();
      if (prim.smooth && prim.points.length > 2) {
        ctx.moveTo(prim.points[0]!.x, prim.points[0]!.y);
        for (let i = 1; i < prim.points.length - 1; i++) {
          const p = prim.points[i]!;
          const next = prim.points[i + 1]!;
          ctx.quadraticCurveTo(p.x, p.y, (p.x + next.x) / 2, (p.y + next.y) / 2);
        }
        const last = prim.points.at(-1)!;
        ctx.lineTo(last.x, last.y);
      } else {
        prim.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      }
      ctx.strokeStyle = prim.stroke;
      ctx.lineWidth = prim.strokeWidth;
      ctx.lineJoin = prim.round ? 'round' : 'miter';
      ctx.lineCap = prim.round ? 'round' : 'butt';
      ctx.setLineDash(prim.dash ?? []);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineJoin = 'miter';
      ctx.lineCap = 'butt';
      break;
    }
    case 'circle': {
      ctx.beginPath();
      ctx.arc(prim.c.x, prim.c.y, prim.r, 0, Math.PI * 2);
      if (prim.fill) {
        ctx.fillStyle = prim.fill;
        ctx.fill();
      }
      if (prim.stroke) {
        ctx.strokeStyle = prim.stroke;
        ctx.lineWidth = prim.strokeWidth ?? 1;
        ctx.stroke();
      }
      break;
    }
    case 'text': {
      if (prim.glyphs) {
        // Every halo first, then every glyph, so no halo covers a neighbour's ink.
        const passes = prim.halo
          ? [{ halo: prim.halo, fill: 'rgba(0,0,0,0)' }, { halo: undefined, fill: prim.fill }]
          : [{ halo: undefined, fill: prim.fill }];
        for (const pass of passes) {
          for (const g of prim.glyphs) {
            drawPrim(ctx, { ...prim, ...pass, glyphs: undefined, text: g.ch, at: { x: g.x, y: g.y }, rotation: g.rotation, anchor: 'middle' });
          }
        }
        break;
      }
      ctx.save();
      ctx.translate(prim.at.x, prim.at.y);
      ctx.rotate(prim.rotation ?? 0);
      ctx.font = `${prim.italic ? 'italic ' : ''}${prim.weight ?? 600} ${prim.size}px ${prim.fantasy ? FANTASY_FONT_STACK : FONT_STACK}`;
      ctx.textAlign = prim.anchor === 'start' ? 'left' : prim.anchor === 'end' ? 'right' : 'center';
      ctx.textBaseline = 'middle';
      if (prim.halo) {
        ctx.lineWidth = Math.max(2, prim.size * 0.28);
        ctx.strokeStyle = prim.halo;
        ctx.lineJoin = 'round';
        ctx.strokeText(prim.text, 0, 0, prim.maxWidth);
        ctx.lineJoin = 'miter';
      }
      ctx.fillStyle = prim.fill;
      ctx.fillText(prim.text, 0, 0, prim.maxWidth);
      ctx.restore();
      break;
    }
    case 'city': {
      const { c, r, symbol } = prim;
      const ring = prim.ring ?? MAP_COLOURS.cityRing;
      ctx.fillStyle = prim.fill ?? MAP_COLOURS.city;
      ctx.strokeStyle = ring;
      ctx.lineWidth = Math.max(1, r * 0.16);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      if (symbol === 'village' || symbol === 'town') {
        ctx.arc(c.x, c.y, r * (symbol === 'village' ? 0.58 : 0.82), 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (symbol === 'town') {
          ctx.beginPath();
          ctx.arc(c.x, c.y, r * 0.48, 0, Math.PI * 2);
          ctx.stroke();
        }
      } else if (symbol === 'city') {
        ctx.moveTo(c.x, c.y - r);
        ctx.lineTo(c.x + r, c.y);
        ctx.lineTo(c.x, c.y + r);
        ctx.lineTo(c.x - r, c.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.moveTo(c.x - r, c.y + r * 0.72);
        ctx.lineTo(c.x - r, c.y - r * 0.35);
        ctx.lineTo(c.x - r * 0.65, c.y - r * 0.7);
        ctx.lineTo(c.x - r * 0.3, c.y - r * 0.35);
        ctx.lineTo(c.x, c.y - r);
        ctx.lineTo(c.x + r * 0.3, c.y - r * 0.35);
        ctx.lineTo(c.x + r * 0.65, c.y - r * 0.7);
        ctx.lineTo(c.x + r, c.y - r * 0.35);
        ctx.lineTo(c.x + r, c.y + r * 0.72);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(c.x, c.y, Math.max(1.5, r * 0.2), 0, Math.PI * 2);
      ctx.fillStyle = prim.onRiver ? prim.riverDot ?? MAP_COLOURS.river : ring;
      ctx.fill();
      ctx.lineJoin = 'miter';
      break;
    }
  }
}

/** Render a scene into a fresh canvas at `scale`, for PNG export. */
export function renderToCanvas(scene: Scene, scale = 2): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(scene.width * scale);
  canvas.height = Math.ceil(scene.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create a 2D canvas context for export.');
  if (scene.background !== 'transparent') {
    ctx.fillStyle = scene.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.scale(scale, scale);
  drawScene(ctx, scene);
  return canvas;
}
