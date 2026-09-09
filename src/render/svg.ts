import type { Prim, Scene } from './scene.js';

const FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const n = (v: number) => (Math.round(v * 100) / 100).toString();

function primToSvg(prim: Prim): string {
  switch (prim.kind) {
    case 'polygon': {
      const points = prim.points.map((p) => `${n(p.x)},${n(p.y)}`).join(' ');
      const fill = prim.fill ?? 'none';
      const stroke = prim.stroke
        ? ` stroke="${prim.stroke}" stroke-width="${n(prim.strokeWidth ?? 1)}"`
        : '';
      return `<polygon points="${points}" fill="${fill}"${stroke}/>`;
    }
    case 'polyline': {
      const points = prim.points.map((p) => `${n(p.x)},${n(p.y)}`).join(' ');
      const dash = prim.dash ? ` stroke-dasharray="${prim.dash.join(' ')}"` : '';
      const caps = prim.round ? ' stroke-linecap="round" stroke-linejoin="round"' : '';
      return `<polyline points="${points}" fill="none" stroke="${prim.stroke}" stroke-width="${n(prim.strokeWidth)}"${dash}${caps}/>`;
    }
    case 'circle': {
      const stroke = prim.stroke
        ? ` stroke="${prim.stroke}" stroke-width="${n(prim.strokeWidth ?? 1)}"`
        : '';
      return `<circle cx="${n(prim.c.x)}" cy="${n(prim.c.y)}" r="${n(prim.r)}" fill="${prim.fill ?? 'none'}"${stroke}/>`;
    }
    case 'text': {
      const anchor =
        prim.anchor === 'start' ? 'start' : prim.anchor === 'end' ? 'end' : 'middle';
      // paint-order lets the halo sit behind the glyphs, matching strokeText/fillText
      // in the canvas renderer so the two outputs agree.
      const halo = prim.halo
        ? ` stroke="${prim.halo}" stroke-width="${n(Math.max(2, prim.size * 0.28))}" stroke-linejoin="round" paint-order="stroke"`
        : '';
      return `<text x="${n(prim.at.x)}" y="${n(prim.at.y)}" font-family="${FONT_STACK}" font-size="${n(prim.size)}" font-weight="${prim.weight ?? 600}" text-anchor="${anchor}" dominant-baseline="central" fill="${prim.fill}"${halo}>${esc(prim.text)}</text>`;
    }
  }
}

export function sceneToSvg(scene: Scene, title: string): string {
  const body = scene.prims.map(primToSvg).join('\n');
  const background =
    scene.background === 'transparent'
      ? ''
      : `<rect width="${n(scene.width)}" height="${n(scene.height)}" fill="${scene.background}"/>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${n(scene.width)}" height="${n(scene.height)}" viewBox="0 0 ${n(scene.width)} ${n(scene.height)}">
<title>${esc(title)}</title>
${background}${body}
</svg>
`;
}
