import { FANTASY_FONT_STACK, FONT_STACK } from './fonts.js';
import type { PathCmd, Prim } from './prims.js';
import type { Scene } from './scene.js';
import { MAP_COLOURS } from './palette.js';
import { tileDataUri } from './texture.js';


const attrFont = (fantasy?: boolean) => (fantasy ? FANTASY_FONT_STACK : FONT_STACK).replace(/"/g, "'");

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const n = (v: number) => (Math.round(v * 100) / 100).toString();

function pathData(d: PathCmd[]): string {
  return d
    .map((c) => (c[0] === 'Z' ? 'Z' : `${c[0]}${c.slice(1).map((v) => n(v as number)).join(' ')}`))
    .join('');
}

/** Definitions (clip paths, patterns) gathered while the body is written. */
interface Defs {
  items: string[];
  patterns: Set<string>;
  next: number;
}

function primToSvg(prim: Prim, defs: Defs): string {
  switch (prim.kind) {
    case 'path': {
      const fill = prim.fill ?? 'none';
      const rule = prim.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : '';
      const stroke = prim.stroke
        ? ` stroke="${prim.stroke}" stroke-width="${n(prim.strokeWidth ?? 1)}"`
        : '';
      const dash = prim.stroke && prim.dash ? ` stroke-dasharray="${prim.dash.map(n).join(' ')}"` : '';
      const caps = prim.stroke && prim.round ? ' stroke-linecap="round" stroke-linejoin="round"' : '';
      return `<path d="${pathData(prim.d)}" fill="${fill}"${rule}${stroke}${dash}${caps}/>`;
    }
    case 'group': {
      const body = prim.prims.map((p) => primToSvg(p, defs)).join('\n');
      if (!prim.clip) return `<g>${body}</g>`;
      const id = `clip${defs.next++}`;
      defs.items.push(`<clipPath id="${id}"><path d="${pathData(prim.clip)}"${prim.clipRule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath>`);
      return `<g clip-path="url(#${id})">\n${body}\n</g>`;
    }
    case 'texture': {
      const id = prim.tile.id;
      if (!defs.patterns.has(id)) {
        defs.patterns.add(id);
        const s = prim.tile.size;
        defs.items.push(
          `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${s}" height="${s}"><image xlink:href="${tileDataUri(prim.tile)}" width="${s}" height="${s}"/></pattern>`,
        );
      }
      return `<rect x="${n(prim.x)}" y="${n(prim.y)}" width="${n(prim.width)}" height="${n(prim.height)}" fill="url(#${id})"/>`;
    }
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
      if (prim.glyphs) {
        // Every halo first, then every glyph, so no halo covers a neighbour's ink.
        const passes = prim.halo
          ? [{ halo: prim.halo, fill: 'none' }, { halo: undefined, fill: prim.fill }]
          : [{ halo: undefined, fill: prim.fill }];
        return `<g>${passes
          .flatMap((pass) =>
            prim.glyphs!.map((g) =>
              primToSvg({ ...prim, ...pass, glyphs: undefined, text: g.ch, at: { x: g.x, y: g.y }, rotation: g.rotation, anchor: 'middle' }, defs),
            ),
          )
          .join('')}</g>`;
      }
      const anchor =
        prim.anchor === 'start' ? 'start' : prim.anchor === 'end' ? 'end' : 'middle';
      // paint-order lets the halo sit behind the glyphs, matching strokeText/fillText
      // in the canvas renderer so the two outputs agree.
      const halo = prim.halo
        ? ` stroke="${prim.halo}" stroke-width="${n(Math.max(1.5, prim.size * 0.15))}" stroke-linejoin="round" paint-order="stroke"`
        : '';
      const transform = prim.rotation
        ? ` transform="rotate(${n(prim.rotation * 180 / Math.PI)} ${n(prim.at.x)} ${n(prim.at.y)})"`
        : '';
      return `<text x="${n(prim.at.x)}" y="${n(prim.at.y)}" font-family="${prim.font ? prim.font.replace(/"/g, "'") : attrFont(prim.fantasy)}" font-size="${n(prim.size)}"${prim.italic ? ' font-style="italic"' : ''} font-weight="${prim.weight ?? 600}" text-anchor="${anchor}" dominant-baseline="central" fill="${prim.fill}"${halo}${transform}>${esc(prim.text)}</text>`;
    }
    case 'city': {
      const { c, r, symbol } = prim;
      const fill = prim.fill ?? MAP_COLOURS.city;
      const ring = prim.ring ?? MAP_COLOURS.cityRing;
      const strokeWidth = n(Math.max(1, r * 0.16));
      let marker: string;
      if (symbol === 'village' || symbol === 'town') {
        const radius = r * (symbol === 'village' ? 0.58 : 0.82);
        marker = `<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${n(radius)}" fill="${fill}" stroke="${ring}" stroke-width="${strokeWidth}"/>`;
        if (symbol === 'town') {
          marker += `<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${n(r * 0.48)}" fill="none" stroke="${ring}" stroke-width="${strokeWidth}"/>`;
        }
      } else if (symbol === 'city') {
        marker = `<path d="M ${n(c.x)} ${n(c.y - r)} L ${n(c.x + r)} ${n(c.y)} L ${n(c.x)} ${n(c.y + r)} L ${n(c.x - r)} ${n(c.y)} Z" fill="${fill}" stroke="${ring}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>`;
      } else {
        const d = `M ${n(c.x - r)} ${n(c.y + r * 0.72)} L ${n(c.x - r)} ${n(c.y - r * 0.35)} L ${n(c.x - r * 0.65)} ${n(c.y - r * 0.7)} L ${n(c.x - r * 0.3)} ${n(c.y - r * 0.35)} L ${n(c.x)} ${n(c.y - r)} L ${n(c.x + r * 0.3)} ${n(c.y - r * 0.35)} L ${n(c.x + r * 0.65)} ${n(c.y - r * 0.7)} L ${n(c.x + r)} ${n(c.y - r * 0.35)} L ${n(c.x + r)} ${n(c.y + r * 0.72)} Z`;
        marker = `<path d="${d}" fill="${fill}" stroke="${ring}" stroke-width="${strokeWidth}" stroke-linejoin="round"/>`;
      }
      const centre = `<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${n(Math.max(1.5, r * 0.2))}" fill="${prim.onRiver ? prim.riverDot ?? MAP_COLOURS.river : ring}"/>`;
      return marker + centre;
    }
  }
}

/** `css` is added in a <style> element: the @font-face rules of embedded fonts. */
export function sceneToSvg(scene: Scene, title: string, css = ''): string {
  const defs: Defs = { items: [], patterns: new Set(), next: 0 };
  const body = scene.prims.map((p) => primToSvg(p, defs)).join('\n');
  if (css) defs.items.unshift(`<style>${css}</style>`);
  const defsBlock = defs.items.length > 0 ? `<defs>\n${defs.items.join('\n')}\n</defs>\n` : '';
  const background =
    scene.background === 'transparent'
      ? ''
      : `<rect width="${n(scene.width)}" height="${n(scene.height)}" fill="${scene.background}"/>\n`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n(scene.width)}" height="${n(scene.height)}" viewBox="0 0 ${n(scene.width)} ${n(scene.height)}">
<title>${esc(title)}</title>
${defsBlock}${background}${body}
</svg>
`;
}
