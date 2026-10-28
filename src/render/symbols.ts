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
 * A shared rim vertex is inset toward all plateau cells meeting that corner.
 * Using the same cells on either side keeps the rim joined across hexes.
 */
export function plateauRimVertex(vertex: Point, centres: Point[], size: number): Point {
  const ordered = [...centres].sort((a, b) => a.x - b.x || a.y - b.y);
  const mean = ordered.reduce((p, c) => ({ x: p.x + c.x / ordered.length, y: p.y + c.y / ordered.length }), { x: 0, y: 0 });
  const length = Math.hypot(mean.x - vertex.x, mean.y - vertex.y) || 1;
  return { x: vertex.x + (mean.x - vertex.x) / length * size * 0.14,
    y: vertex.y + (mean.y - vertex.y) / length * size * 0.14 };
}

/** Continuous, deterministic value noise: erosion must not restart at every hex edge. */
function erosionNoise(x: number, y: number, salt: number, seed = 0): number {
  const hash = (i: number, j: number) => {
    const n = Math.sin(i * 127.1 + j * 311.7 + salt * 74.7 + seed * 913.3) * 43758.5453;
    return n - Math.floor(n);
  };
  const ix = Math.floor(x), iy = Math.floor(y);
  const ease = (v: number) => v * v * (3 - 2 * v);
  const u = ease(x - ix), v = ease(y - iy);
  return (hash(ix, iy) * (1-u) + hash(ix+1, iy) * u) * (1-v)
    + (hash(ix, iy+1) * (1-u) + hash(ix+1, iy+1) * u) * v;
}

/** Smooth the whole connected rim, so alternating hex corners do not become scallops. */
export function smoothPlateauRims(rims: Array<[Point, Point]>, contour?: { size: number; seed: number }): Point[][] {
  const key = (p: Point) => `${p.x.toFixed(5)},${p.y.toFixed(5)}`;
  const vertices = new Map<string, { point: Point; neighbours: Set<string> }>();
  for (const [a, b] of rims) {
    for (const [p, q] of [[a, b], [b, a]] as Array<[Point, Point]>) {
      const id = key(p);
      if (!vertices.has(id)) vertices.set(id, { point: p, neighbours: new Set() });
      vertices.get(id)!.neighbours.add(key(q));
    }
  }
  // Relax the zigzag before interpolating it; rounding each hex corner alone
  // would still advertise the grid. Open ends stay fixed at higher terrain.
  for (let pass = 0; pass < 2; pass++) {
    const next = new Map<string, Point>();
    for (const [id, v] of vertices) {
      const neighbours = [...v.neighbours].map(k => vertices.get(k)!.point);
      next.set(id, neighbours.length === 2 ? {
        x: v.point.x * 0.5 + (neighbours[0]!.x + neighbours[1]!.x) * 0.25,
        y: v.point.y * 0.5 + (neighbours[0]!.y + neighbours[1]!.y) * 0.25,
      } : v.point);
    }
    for (const [id, point] of next) vertices.get(id)!.point = point;
  }
  return rims.map(([a, b]) => {
    const va = vertices.get(key(a))!, vb = vertices.get(key(b))!;
    const p = va.point, q = vb.point;
    const before = [...va.neighbours].find(id => id !== key(b));
    const after = [...vb.neighbours].find(id => id !== key(a));
    const prev = before ? vertices.get(before)!.point : p;
    const next = after ? vertices.get(after)!.point : q;
    // Cubic Hermite interpolation gives the same tangent on both sides of a join.
    return Array.from({ length: 25 }, (_, k) => {
      const t = k / 24, t2 = t * t, t3 = t2 * t;
      const at = (axis: 'x' | 'y') => (2*t3 - 3*t2 + 1)*p[axis] + (t3 - 2*t2 + t)*(q[axis] - prev[axis])/2
        + (-2*t3 + 3*t2)*q[axis] + (t3 - t2)*(next[axis] - p[axis])/2;
      const point = { x: at('x'), y: at('y') };
      if (!contour) return point;
      const { size, seed } = contour;
      // Shape the contour itself: broad shoulders interrupted by unequal
      // re-entrants. Domain warping prevents a regular series of scallops.
      const x = point.x / size, y = point.y / size;
      const wx = x + (erosionNoise(x * 0.35, y * 0.35, 1, seed) - 0.5) * 1.6;
      const wy = y + (erosionNoise(x * 0.35, y * 0.35, 2, seed) - 0.5) * 1.6;
      const shoulder = (erosionNoise(wx * 0.45, wy * 0.45, 3, seed) - 0.5) * 0.6;
      const gully = Math.max(0, erosionNoise(wx * 1.15, wy * 1.15, 4, seed) - 0.38) * 1.65;
      const ledge = (erosionNoise(wx * 3.2, wy * 3.2, 5, seed) - 0.5) * 0.16;
      const derivative = (axis: 'x' | 'y') => (6*t2 - 6*t)*p[axis] + (3*t2 - 4*t + 1)*(q[axis] - prev[axis])/2
        + (-6*t2 + 6*t)*q[axis] + (3*t2 - 2*t)*(next[axis] - p[axis])/2;
      const tx = derivative('x'), ty = derivative('y');
      const length = Math.hypot(tx, ty) || 1;
      // Fade displacement into fixed open ends where the plateau meets higher ground.
      const fade = (before ? 1 : t*t*(3-2*t)) * (after ? 1 : (1-t)*(1-t)*(1+2*t));
      let offset = Math.max(-0.6, Math.min(0.25, shoulder - gully + ledge)) * size * fade;
      // A recess cannot cut deeper than the radius of a tight bend: that
      // would fold the normal-offset curve into a loop, especially on mesas.
      const curvatureAt = (a: Point, b: Point, c: Point): number => {
        const cross = (b.x-a.x)*(c.y-b.y) - (b.y-a.y)*(c.x-b.x);
        const lengths = Math.hypot(b.x-a.x, b.y-a.y) * Math.hypot(c.x-b.x, c.y-b.y) * Math.hypot(c.x-a.x, c.y-a.y);
        return lengths > 1e-8 ? 2*cross/lengths : 0;
      };
      // Shared vertices also share their curvature limit. The Hermite
      // pieces have different second derivatives at a join.
      const curvature = curvatureAt(prev, p, q)*(1-t) + curvatureAt(p, q, next)*t;
      if (offset * curvature < 0 && Math.abs(curvature) > 1e-8) {
        const limit = 0.4 / Math.abs(curvature);
        offset = limit * Math.tanh(offset / limit);
      }
      return { x: point.x + ty / length * offset, y: point.y - tx / length * offset };
    });
  });
}

/** A gently broken cliff lip, shaded face and varied downhill hachures. */
export function escarpment(a: Point, b: Point, centre: Point, size: number, colours: SymbolInk, rand: (k: number) => number,
  rim: Point[] = [plateauRimVertex(a, [centre], size), plateauRimVertex(b, [centre], size)],
): Placed {
  const p = rim[0]!, q = rim[rim.length - 1]!;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const olen = Math.hypot(mx - centre.x, my - centre.y) || 1;
  const dx = (mx - centre.x) / olen;
  const dy = (my - centre.y) / olen;
  const ink = mix(colours.ground, colours.ink, 0.68);
  const stroke = Math.max(0.5, size * 0.025);
  const steps = rim.length > 2 ? rim.length - 1 : 12;
  const lip = Array.from({ length: steps + 1 }, (_, k) => {
    const t = k / steps;
    return rim.length > 2 ? rim[k]! : { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
  });
  const d: PathCmd[] = lip.map((v, k) => [k === 0 ? 'M' : 'L', v.x, v.y]);
  // The foot follows the same curved outline, rather than exposing hex edges
  // through the shaded face. Downhill strokes follow its local normal.
  const feet = lip.map((v, k) => {
    if (rim.length === 2) return { x: a.x + (b.x - a.x) * k / steps, y: a.y + (b.y - a.y) * k / steps };
    const prev = lip[Math.max(0, k - 1)]!, next = lip[Math.min(steps, k + 1)]!;
    const tx = next.x - prev.x, ty = next.y - prev.y;
    const length = Math.hypot(tx, ty) || 1;
    const sign = (-ty * dx + tx * dy) >= 0 ? 1 : -1;
    return { x: v.x - ty / length * size * 0.10 * sign, y: v.y + tx / length * size * 0.10 * sign };
  });
  const ticks = Math.max(4, Math.round(Math.hypot(q.x - p.x, q.y - p.y) / (size * 0.18)));
  for (let k = 0; k < ticks; k++) {
    const t = (k + 0.15 + rand(k) * 0.7) / ticks;
    const segment = Math.min(steps - 1, Math.floor(t * steps));
    const u = t * steps - segment;
    const v = lip[segment]!, w = lip[segment + 1]!;
    const x = v.x + (w.x - v.x) * u, y = v.y + (w.y - v.y) * u;
    const f0 = feet[segment]!, f1 = feet[segment + 1]!;
    const f = { x: f0.x + (f1.x - f0.x) * u, y: f0.y + (f1.y - f0.y) * u };
    const reach = 0.65 + rand(20 + k) * 0.35;
    d.push(['M', x, y], ['L', x + (f.x - x) * reach, y + (f.y - y) * reach]);
  }
  // Light from the north-west, consistent with the other relief symbols.
  const shadow = 0.08 + 0.07 * (dx + dy + 2) / 4;
  const face: PathCmd[] = [...lip.map((v, k): PathCmd => [k === 0 ? 'M' : 'L', v.x, v.y]), ...[...feet].reverse().map((v): PathCmd => ['L', v.x, v.y]), ['Z']];
  return { y: my, prims: [
    { kind: 'path', d: face, fill: mix(colours.ground, colours.ink, shadow) },
    { kind: 'path', d, stroke: ink, strokeWidth: stroke, round: true },
  ] };
}

/** Points along a symbol's drawing: every vertex and control point, and the middle of each step between them. */
export function samplePoints(placed: Placed): Point[] {
  const out: Point[] = [];
  const walk = (prims: Prim[]) => {
    for (const prim of prims) {
      if (prim.kind === 'group') walk(prim.prims);
      if (prim.kind === 'polyline' || prim.kind === 'polygon') {
        prim.points.forEach((p, k) => {
          const last = k > 0 ? prim.points[k - 1]! : prim.kind === 'polygon' ? prim.points[prim.points.length - 1]! : null;
          if (last) out.push({ x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 });
          out.push(p);
        });
      }
      if (prim.kind !== 'path') continue;
      let last: Point | null = null;
      for (const cmd of prim.d) {
        if (cmd[0] === 'Z') continue;
        for (let k = 1; k + 1 < cmd.length; k += 2) {
          const p = { x: cmd[k] as number, y: cmd[k + 1] as number };
          if (last && cmd[0] !== 'M') out.push({ x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 });
          out.push(p);
          last = p;
        }
      }
    }
  };
  walk(placed.prims);
  return out;
}

/** Whether every part of a symbol stands on land. */
export function standsOnLand(placed: Placed, onLand: (p: Point) => boolean): boolean {
  return samplePoints(placed).every(onLand);
}

/** Escarpments have long straight strokes: test their ink and shore clearance,
 * not just endpoints that can straddle a small bay. */
export function escarpmentWithinLand(placed: Placed, onLand: (p: Point) => boolean, gap: number): boolean {
  for (const prim of placed.prims) {
    if (prim.kind !== 'path') continue;
    const reach = gap + (prim.strokeWidth ?? 0) / 2;
    let previous: Point | undefined;
    for (const cmd of prim.d) {
      if (cmd[0] !== 'M' && cmd[0] !== 'L') continue;
      const at = { x: cmd[1], y: cmd[2] };
      const from = cmd[0] === 'L' && previous ? previous : at;
      const steps = Math.max(1, Math.ceil(Math.hypot(at.x - from.x, at.y - from.y) / Math.max(0.5, reach)));
      for (let k = 0; k <= steps; k++) {
        const p = { x: from.x + (at.x - from.x) * k / steps, y: from.y + (at.y - from.y) * k / steps };
        if (!onLand(p)) return false;
        for (let d = 0; d < 8; d++) {
          if (!onLand({ x: p.x + Math.cos(d * Math.PI / 4) * reach, y: p.y + Math.sin(d * Math.PI / 4) * reach })) return false;
        }
      }
      previous = at;
    }
  }
  return true;
}

/** The sizes a hex's symbols are tried at, before any are left out. */
export const FIT_SCALES = [1, 0.85, 0.72, 0.6, 0.5];
/**
 * What drawing a set smaller costs against moving it, in hex sizes moved per unit of
 * scale lost: low, so a set is shrunk where it stands before it is moved far.
 */
const SHRINK_COST = 0.25;
/** How many places, nearest the middle of a hex's land, a set is tried at. */
const NEAREST_SPOTS = 16;

/** How a hex's symbols were fitted to its land. */
export interface Fitted {
  placed: Placed[];
  /** Where the set was laid out about, and at what size (1 being its own). */
  at: Point;
  scale: number;
  /** Which of the set laid out there were kept (all when absent). */
  keep?: number[];
  /** How many were laid out, and how many of those were left out for want of land. */
  wanted: number;
  dropped: number;
}

/** The same fitting drawn again (with other colours, say) without searching for it. */
export function refit(draw: (centre: Point, size: number) => Placed[], fitted: Fitted, size: number): Placed[] {
  const set = draw(fitted.at, size * fitted.scale);
  return fitted.keep ? fitted.keep.map((k) => set[k]!).filter(Boolean) : set;
}

/**
 * A hex's symbols kept to the land as drawn.
 *
 * `draw(centre, size)` lays the hex's symbols out about a point at a size. Where the
 * hex is land throughout, they are drawn as laid out about its middle. Where it has
 * less land than that (a coast cut back to its land share, a strait's banks), they
 * are shrunk, and moved towards the middle of the hex's own land, shrinking being
 * preferred to moving far, until every symbol stands on land with its foot in the
 * hex. Failing that even at the smallest size, the most symbols that do fit are kept
 * and the rest left out. A symbol is never drawn over water: no symbol at all is
 * better than a mountain standing in the sea.
 *
 * `inHex(p)` says whether a point is in the hex the symbols belong to, so that a set
 * is never moved onto a neighbour's ground.
 */
export function keepToLand(
  draw: (centre: Point, size: number) => Placed[],
  centre: Point,
  size: number,
  onLand: (p: Point) => boolean,
  inHex: (p: Point) => boolean,
): Fitted {
  const fits = (p: Placed) => {
    const points = samplePoints(p);
    if (points.length === 0) return true;
    const xs = points.map((q) => q.x);
    return inHex({ x: (Math.min(...xs) + Math.max(...xs)) / 2, y: p.y }) && points.every(onLand);
  };
  const first = draw(centre, size);
  const wanted = first.length;
  if (first.every(fits)) return { placed: first, at: centre, scale: 1, wanted, dropped: 0 };
  // The hex's land, on a fine grid.
  const step = size * 0.08;
  const spots: Point[] = [];
  for (let dy = -11; dy <= 11; dy++) {
    for (let dx = -11; dx <= 11; dx++) {
      const p = { x: centre.x + dx * step, y: centre.y + dy * step };
      if (inHex(p) && onLand(p)) spots.push(p);
    }
  }
  if (spots.length === 0) return { placed: [], at: centre, scale: 1, keep: [], wanted, dropped: wanted };
  const mid = {
    x: spots.reduce((s, p) => s + p.x, 0) / spots.length,
    y: spots.reduce((s, p) => s + p.y, 0) / spots.length,
  };
  // Every place and size, cheapest first: near the middle of the land, and as large as can be.
  // Only the places nearest that middle are tried; a set moved further would be cheaper shrunk.
  const near = spots
    .sort((a, b) => Math.hypot(a.x - mid.x, a.y - mid.y) - Math.hypot(b.x - mid.x, b.y - mid.y))
    .slice(0, NEAREST_SPOTS);
  const tries = FIT_SCALES.flatMap((scale) =>
    near.map((spot) => ({ spot, scale, cost: Math.hypot(spot.x - mid.x, spot.y - mid.y) / size + (1 - scale) * SHRINK_COST })),
  ).sort((a, b) => a.cost - b.cost);
  let best: Fitted = { placed: [], at: centre, scale: 1, keep: [], wanted, dropped: wanted };
  for (const { spot, scale } of tries) {
    const set = draw(spot, size * scale);
    const keep = set.flatMap((p, k) => (fits(p) ? [k] : []));
    if (keep.length === set.length) return { placed: set, at: spot, scale, wanted, dropped: 0 };
    if (keep.length > best.placed.length) best = { placed: keep.map((k) => set[k]!), at: spot, scale, keep, wanted, dropped: set.length - keep.length };
  }
  return best;
}

/** Where a symbol stands: the middle of its drawing across, on its base line. */
export function symbolAnchor(placed: Placed): Point {
  const points = samplePoints(placed);
  if (points.length === 0) return { x: 0, y: placed.y };
  const xs = points.map((p) => p.x);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: placed.y };
}
