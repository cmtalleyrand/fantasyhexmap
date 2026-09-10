import type { Prim, Scene } from './scene.js';

const FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export function drawScene(ctx: CanvasRenderingContext2D, scene: Scene): void {
  for (const prim of scene.prims) drawPrim(ctx, prim);
}

function drawPrim(ctx: CanvasRenderingContext2D, prim: Prim): void {
  switch (prim.kind) {
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
      prim.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
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
      ctx.font = `${prim.weight ?? 600} ${prim.size}px ${FONT_STACK}`;
      ctx.textAlign = prim.anchor === 'start' ? 'left' : prim.anchor === 'end' ? 'right' : 'center';
      ctx.textBaseline = 'middle';
      if (prim.halo) {
        ctx.lineWidth = Math.max(2, prim.size * 0.28);
        ctx.strokeStyle = prim.halo;
        ctx.lineJoin = 'round';
        ctx.strokeText(prim.text, prim.at.x, prim.at.y);
        ctx.lineJoin = 'miter';
      }
      ctx.fillStyle = prim.fill;
      ctx.fillText(prim.text, prim.at.x, prim.at.y);
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
