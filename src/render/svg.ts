import type { Prim, Scene } from './scene.js';

const FONT_STACK =
  'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
const FANTASY_FONT_STACK = 'Palatino Linotype, Palatino, Book Antiqua, Georgia, serif';

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
      if (prim.smooth && prim.points.length > 2) {
        const first = prim.points[0]!;
        let d = `M ${n(first.x)} ${n(first.y)}`;
        for (let i = 1; i < prim.points.length - 1; i++) {
          const p = prim.points[i]!;
          const next = prim.points[i + 1]!;
          d += ` Q ${n(p.x)} ${n(p.y)} ${n((p.x + next.x) / 2)} ${n((p.y + next.y) / 2)}`;
        }
        const last = prim.points.at(-1)!;
        d += ` L ${n(last.x)} ${n(last.y)}`;
        return `<path d="${d}" fill="none" stroke="${prim.stroke}" stroke-width="${n(prim.strokeWidth)}"${dash}${caps}/>`;
      }
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
      return `<text x="${n(prim.at.x)}" y="${n(prim.at.y)}" font-family="${prim.fantasy ? FANTASY_FONT_STACK : FONT_STACK}" font-size="${n(prim.size)}" font-weight="${prim.weight ?? 600}" text-anchor="${anchor}" dominant-baseline="central" fill="${prim.fill}"${halo}>${esc(prim.text)}</text>`;
    }
    case 'city': {
      const { c, r } = prim;
      const d = `M ${n(c.x - r)} ${n(c.y + r * 0.72)} L ${n(c.x - r)} ${n(c.y - r * 0.35)} L ${n(c.x - r * 0.65)} ${n(c.y - r * 0.7)} L ${n(c.x - r * 0.3)} ${n(c.y - r * 0.35)} L ${n(c.x)} ${n(c.y - r)} L ${n(c.x + r * 0.3)} ${n(c.y - r * 0.35)} L ${n(c.x + r * 0.65)} ${n(c.y - r * 0.7)} L ${n(c.x + r)} ${n(c.y - r * 0.35)} L ${n(c.x + r)} ${n(c.y + r * 0.72)} Z`;
      const gate = `M ${n(c.x - r * 0.27)} ${n(c.y + r * 0.72)} A ${n(r * 0.27)} ${n(r * 0.27)} 0 0 1 ${n(c.x + r * 0.27)} ${n(c.y + r * 0.72)} Z`;
      return `<path d="${d}" fill="#1a1410" stroke="#f6f1e4" stroke-width="${n(Math.max(1, r * 0.16))}" stroke-linejoin="round"/><path d="${gate}" fill="${prim.onRiver ? '#3f8fd0' : '#f6f1e4'}"/>`;
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
