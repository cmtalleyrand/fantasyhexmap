/**
 * Drawn relief and vegetation.
 *
 * Each hex gets a few small drawings for its height and, when vegetation is
 * shown, its cover: peaks with a lit and a shaded face, rounded hills, the
 * flat top of a mesa, conifers and broadleaf trees, marsh tufts, dunes, grass
 * and field furrows. Faces are coloured from the ground they stand on (its
 * fill, with any realm colour over it), lightened or darkened, so a peak in
 * a red kingdom is a red-tinged peak rather than a beige sticker.
 *
 * Placement is seeded per hex, and every symbol on the map is returned with
 * the y of its base so the caller can draw them back to front: a peak lower
 * on the map overlaps the one behind it, as in a drawn landscape.
 */

import type { Point } from '../../shared/hex.js';
import type { Elevation, Vegetation } from '../../shared/types.js';
import type { PathCmd, Prim } from './prims.js';

export interface Placed {
  /** Base line of the symbol; larger y is nearer the viewer and drawn later. */
  y: number;
  prims: Prim[];
  /** The hex the symbol belongs to, when the caller records it. */
  hex?: number;
}

export interface SymbolInk {
  /** The colour of the ground under the symbol. */
  ground: string;
  ink: string;
}

function mix(a: string, b: string, t: number): string {
  const pa = /^#([0-9a-f]{6})$/i.exec(a);
  const pb = /^#([0-9a-f]{6})$/i.exec(b);
  if (!pa || !pb) return a;
  const na = parseInt(pa[1]!, 16);
  const nb = parseInt(pb[1]!, 16);
  const ch = (s: number) => Math.round(((na >> s) & 255) * (1 - t) + ((nb >> s) & 255) * t);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

const light = (c: SymbolInk) => mix(c.ground, '#ffffff', 0.32);
const shade = (c: SymbolInk) => mix(c.ground, c.ink, 0.38);

function peak(base: Point, w: number, h: number, lean: number, c: SymbolInk, size: number): Placed {
  const apex = { x: base.x + lean * w, y: base.y - h };
  const left = { x: base.x - w / 2, y: base.y };
  const right = { x: base.x + w / 2, y: base.y };
  // The ridge from the summit meets the foot a little right of centre.
  const foot = { x: base.x + w * 0.12 + lean * w * 0.4, y: base.y };
  const notch = { x: apex.x + w * 0.16, y: apex.y + h * 0.22 };
  const stroke = Math.max(0.6, size * 0.035);
  return {
    y: base.y,
    prims: [
      { kind: 'path', d: [['M', left.x, left.y], ['L', apex.x, apex.y], ['L', foot.x, foot.y], ['Z']], fill: light(c) },
      {
        kind: 'path',
        d: [['M', apex.x, apex.y], ['L', notch.x, notch.y], ['L', right.x, right.y], ['L', foot.x, foot.y], ['Z']],
        fill: shade(c),
      },
      {
        kind: 'path',
        d: [['M', left.x, left.y], ['L', apex.x, apex.y], ['L', notch.x, notch.y], ['L', right.x, right.y]],
        stroke: c.ink,
        strokeWidth: stroke,
        round: true,
      },
      { kind: 'path', d: [['M', apex.x, apex.y], ['L', foot.x, foot.y]], stroke: c.ink, strokeWidth: stroke * 0.6, round: true },
    ],
  };
}

function hump(base: Point, w: number, h: number, c: SymbolInk, size: number, filled = true): Placed {
  const d: PathCmd[] = [['M', base.x - w / 2, base.y], ['Q', base.x, base.y - h * 2, base.x + w / 2, base.y]];
  const stroke = Math.max(0.55, size * 0.032);
  const prims: Prim[] = [];
  if (filled) prims.push({ kind: 'path', d: [...d, ['Z']], fill: light(c) });
  prims.push({ kind: 'path', d, stroke: c.ink, strokeWidth: stroke, round: true });
  if (filled) {
    // Two short strokes of shading on the side away from the light.
    for (let k = 0; k < 2; k++) {
      const x = base.x + w * (0.12 + k * 0.14);
      prims.push({
        kind: 'path',
        d: [['M', x, base.y - h * (0.75 - k * 0.3)], ['L', x + w * 0.05, base.y - h * 0.05]],
        stroke: shade(c),
        strokeWidth: stroke * 0.8,
        round: true,
      });
    }
  }
  return { y: base.y, prims };
}

/** The drawings for one hex's height. `rand(k)` is the hex's seeded randomness. */
export function reliefSymbols(
  centre: Point,
  size: number,
  elevation: Elevation,
  rand: (k: number) => number,
  colours: SymbolInk,
): Placed[] {
  const j = (k: number, amount: number) => (rand(k) - 0.5) * 2 * amount * size;
  const at = (dx: number, dy: number, k: number): Point => ({ x: centre.x + dx * size + j(k, 0.08), y: centre.y + dy * size + j(k + 1, 0.06) });
  switch (elevation) {
    case 'Mountains': {
      // Two or three peaks of varied size, arranged differently in each hex,
      // so a range reads as a range rather than as a repeated tile.
      const layouts: Array<Array<[number, number, number]>> = [
        [[0.22, 0.05, 0.72], [-0.2, 0.32, 1]],
        [[-0.24, 0.02, 0.7], [0.18, 0.3, 0.95]],
        [[0.3, 0.12, 0.62], [-0.3, 0.12, 0.66], [0, 0.38, 1]],
        [[-0.05, 0.1, 0.85], [0.32, 0.36, 0.7]],
      ];
      const layout = layouts[Math.floor(rand(9) * layouts.length)]!;
      return layout.map(([dx, dy, scale], k) => {
        const s = scale * (0.88 + rand(20 + k) * 0.28);
        return peak(
          { x: centre.x + (dx + (rand(30 + k) - 0.5) * 0.22) * size, y: centre.y + (dy + (rand(40 + k) - 0.5) * 0.14) * size },
          size * 0.86 * s,
          size * 0.88 * s,
          (rand(50 + k) - 0.5) * 0.35,
          colours,
          size,
        );
      });
    }
    case 'Highland':
      return [
        peak(at(-0.18, 0.25, 1), size * 0.62, size * 0.5, (rand(3) - 0.5) * 0.3, colours, size),
        hump(at(0.28, 0.32, 5), size * 0.46, size * 0.17, colours, size),
      ];
    case 'Hills':
      return [
        hump(at(-0.22, 0.1, 1), size * 0.48, size * 0.19, colours, size),
        hump(at(0.24, 0.34, 5), size * 0.5, size * 0.2, colours, size),
      ];
    case 'Rolling':
      return [
        hump(at(-0.2, 0.18, 1), size * 0.42, size * 0.09, colours, size, false),
        hump(at(0.22, 0.36, 5), size * 0.4, size * 0.08, colours, size, false),
      ];
    case 'Plateau':
      // A plateau is flat on top; it is drawn where it rises, along its
      // edges (see escarpment), not in every hex.
      return [];
    case 'Lowland':
      return [];
  }
}

function conifer(base: Point, h: number, c: SymbolInk, size: number): Placed {
  const w = h * 0.55;
  return {
    y: base.y,
    prims: [
      { kind: 'path', d: [['M', base.x, base.y - h], ['L', base.x + w / 2, base.y - h * 0.18], ['L', base.x - w / 2, base.y - h * 0.18], ['Z']], fill: mix(c.ground, '#1f4a2c', 0.55), stroke: c.ink, strokeWidth: Math.max(0.45, size * 0.022), round: true },
      { kind: 'path', d: [['M', base.x, base.y - h * 0.18], ['L', base.x, base.y]], stroke: c.ink, strokeWidth: Math.max(0.45, size * 0.025), round: true },
    ],
  };
}

function broadleaf(base: Point, h: number, c: SymbolInk, size: number, wet = false): Placed {
  const r = h * 0.34;
  const cy = base.y - h + r;
  const crown: PathCmd[] = [
    ['M', base.x - r, cy],
    ['C', base.x - r, cy - r * 1.3, base.x + r, cy - r * 1.3, base.x + r, cy],
    ['C', base.x + r, cy + r * 0.9, base.x - r, cy + r * 0.9, base.x - r, cy],
    ['Z'],
  ];
  return {
    y: base.y,
    prims: [
      { kind: 'path', d: [['M', base.x, cy + r * 0.5], ['L', base.x, base.y]], stroke: c.ink, strokeWidth: Math.max(0.45, size * 0.025), round: true },
      { kind: 'path', d: crown, fill: mix(c.ground, wet ? '#1c5a33' : '#3d6b2c', 0.5), stroke: c.ink, strokeWidth: Math.max(0.45, size * 0.022), round: true },
    ],
  };
}

function strokes(lines: Array<[Point, Point]>, c: SymbolInk, size: number, y: number, curve = 0): Placed {
  const d: PathCmd[] = [];
  for (const [a, b] of lines) {
    if (curve) d.push(['M', a.x, a.y], ['Q', (a.x + b.x) / 2, (a.y + b.y) / 2 - curve, b.x, b.y]);
    else d.push(['M', a.x, a.y], ['L', b.x, b.y]);
  }
  return { y, prims: [{ kind: 'path', d, stroke: mix(c.ground, c.ink, 0.7), strokeWidth: Math.max(0.45, size * 0.026), round: true }] };
}

/** Spots for a few symbols in a hex, spread on a loose seeded grid. */
function spots(centre: Point, size: number, count: number, rand: (k: number) => number, avoidTop: boolean): Point[] {
  const grid: Array<[number, number]> = [[-0.32, -0.18], [0.1, -0.24], [-0.1, 0.12], [0.34, 0.08], [-0.34, 0.38], [0.14, 0.42], [0.42, 0.4]];
  const usable = avoidTop ? grid.filter(([, y]) => y > 0) : grid;
  const out: Point[] = [];
  for (let k = 0; k < Math.min(count, usable.length); k++) {
    const [gx, gy] = usable[(k + Math.floor(rand(90) * usable.length)) % usable.length]!;
    out.push({ x: centre.x + (gx + (rand(100 + k) - 0.5) * 0.14) * size, y: centre.y + (gy + (rand(200 + k) - 0.5) * 0.1) * size });
  }
  return out;
}

/** The drawings for one hex's vegetation; sparser where relief already fills the hex. */
export function vegetationSymbols(
  centre: Point,
  size: number,
  vegetation: Vegetation,
  rand: (k: number) => number,
  colours: SymbolInk,
  crowded: boolean,
): Placed[] {
  const s = size;
  switch (vegetation) {
    case 'Boreal Forest':
    case 'Coniferous Forest':
      return spots(centre, s, crowded ? 2 : 5, rand, crowded).map((p, k) => conifer(p, s * (0.3 + rand(300 + k) * 0.08), colours, s));
    case 'Deciduous Forest':
    case 'Subtropical Rainforest':
      return spots(centre, s, crowded ? 2 : 5, rand, crowded).map((p, k) => broadleaf(p, s * (0.3 + rand(300 + k) * 0.08), colours, s));
    case 'Tropical Rainforest':
      return spots(centre, s, crowded ? 3 : 6, rand, crowded).map((p, k) => broadleaf(p, s * (0.32 + rand(300 + k) * 0.08), colours, s, true));
    case 'Wetland':
      return spots(centre, s, crowded ? 1 : 3, rand, crowded).map((p) =>
        strokes(
          [
            [{ x: p.x - s * 0.12, y: p.y }, { x: p.x + s * 0.12, y: p.y }],
            [{ x: p.x - s * 0.06, y: p.y }, { x: p.x - s * 0.08, y: p.y - s * 0.12 }],
            [{ x: p.x, y: p.y }, { x: p.x, y: p.y - s * 0.15 }],
            [{ x: p.x + s * 0.06, y: p.y }, { x: p.x + s * 0.08, y: p.y - s * 0.12 }],
          ],
          colours,
          s,
          p.y,
        ),
      );
    case 'Barren Desert':
      return spots(centre, s, crowded ? 1 : 2, rand, crowded).map((p) =>
        strokes([[{ x: p.x - s * 0.18, y: p.y }, { x: p.x + s * 0.18, y: p.y }]], colours, s, p.y, s * 0.12),
      );
    case 'Steppe':
    case 'Prairie':
    case 'Savanna':
    case 'Veld':
    case 'Scrubland':
    case 'Tundra':
      return crowded
        ? []
        : spots(centre, s, 3, rand, false).map((p) =>
            strokes(
              [
                [{ x: p.x - s * 0.04, y: p.y }, { x: p.x - s * 0.07, y: p.y - s * 0.08 }],
                [{ x: p.x + s * 0.04, y: p.y }, { x: p.x + s * 0.07, y: p.y - s * 0.08 }],
              ],
              colours,
              s,
              p.y,
            ),
          );
    case 'Breadbasket':
    case 'Black Earth':
    case 'Assart':
    case 'Paddy Fields':
    case 'Flood Plain': {
      if (crowded) return [];
      const angle = (rand(400) - 0.5) * 0.6;
      const lines: Array<[Point, Point]> = [];
      for (let k = -1; k <= 1; k++) {
        const ox = -Math.sin(angle) * k * s * 0.12;
        const oy = Math.cos(angle) * k * s * 0.12;
        lines.push([
          { x: centre.x + ox - Math.cos(angle) * s * 0.26, y: centre.y + oy - Math.sin(angle) * s * 0.26 },
          { x: centre.x + ox + Math.cos(angle) * s * 0.26, y: centre.y + oy + Math.sin(angle) * s * 0.26 },
        ]);
      }
      return [strokes(lines, colours, s, centre.y)];
    }
    case 'Desert Oasis':
      return spots(centre, s, 2, rand, crowded).map((p, k) => broadleaf(p, s * (0.26 + rand(300 + k) * 0.06), colours, s, true));
  }
}

/** Heights for shading: Plateau is high but flat, so it shades like Highland. */
const HEIGHT: Record<Elevation, number> = { Lowland: 0, Rolling: 1, Hills: 2, Highland: 3, Mountains: 4, Plateau: 3 };

/**
 * How lit one hex is, from the height of its neighbours: the slope facing
 * north-west is lit, the one facing south-east is in shadow. Positive is lit.
 * `neighbour(e)` gives the elevation across edge e, `'water'` for water, or
 * null off the map.
 */
export function hillshade(
  here: Elevation,
  neighbour: (edge: number) => Elevation | 'water' | null,
): number {
  const h = HEIGHT[here];
  let gx = 0;
  let gy = 0;
  for (let e = 0; e < 6; e++) {
    const n = neighbour(e);
    if (n === null) continue;
    const hn = n === 'water' ? -0.6 : HEIGHT[n];
    const angle = (e * Math.PI) / 3;
    gx += (hn - h) * Math.cos(angle);
    gy += (hn - h) * Math.sin(angle);
  }
  // Light from the north-west: up and to the left on screen.
  const lx = -Math.SQRT1_2;
  const ly = -Math.SQRT1_2;
  // The surface faces against its uphill gradient.
  return -(gx * lx + gy * ly) / 3 + (h >= 4 ? 0.1 : 0);
}

/**
 * The edge of a plateau where it falls to lower ground: a line just inside
 * the plateau's side of the hex edge, with short ticks running downhill
 * across it, the cartographer's sign for an escarpment.
 */
export function escarpment(a: Point, b: Point, centre: Point, size: number, colours: SymbolInk, rand: (k: number) => number): Placed {
  const inset = 0.14;
  const p = { x: a.x + (centre.x - a.x) * inset, y: a.y + (centre.y - a.y) * inset };
  const q = { x: b.x + (centre.x - b.x) * inset, y: b.y + (centre.y - b.y) * inset };
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  // Downhill: away from the plateau hex's centre.
  const mx = (p.x + q.x) / 2;
  const my = (p.y + q.y) / 2;
  const ox = mx - centre.x;
  const oy = my - centre.y;
  const olen = Math.hypot(ox, oy) || 1;
  const dx = ox / olen;
  const dy = oy / olen;
  const ink = mix(colours.ground, colours.ink, 0.75);
  const stroke = Math.max(0.55, size * 0.03);
  const d: PathCmd[] = [['M', p.x, p.y], ['L', q.x, q.y]];
  const ticks = Math.max(3, Math.round(len / (size * 0.16)));
  for (let k = 0; k < ticks; k++) {
    const t = (k + 0.5) / ticks;
    const x = p.x + (q.x - p.x) * t;
    const y = p.y + (q.y - p.y) * t;
    const l = size * (0.13 + 0.05 * rand(k));
    d.push(['M', x, y], ['L', x + dx * l, y + dy * l]);
  }
  return { y: my, prims: [{ kind: 'path', d, stroke: ink, strokeWidth: stroke, round: true }] };
}
