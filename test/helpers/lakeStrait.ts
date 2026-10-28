/** Drawing and measuring the lake strait fixture, shared by the fast and slow test tiers. */
import assert from 'node:assert/strict';
import { buildScene, defaultVisibility } from '../../src/render/scene.ts';
import { resolveStyle } from '../../src/render/styles.ts';
import { pathPolylines } from '../../src/render/ice.ts';
import { areaCoverage } from '../../src/render/footprint.ts';
import { evenOddTest } from '../../src/render/coast.ts';
import { hexCenter, hexCorners } from '../../shared/hex.ts';
import type { MapState } from '../../shared/types.ts';
import { lakeStraitFixture, type LakeStraitCase } from '../fixtures/lakeStrait.ts';

export const size = 30, cols = 7, centre = 24, hexArea = 1.5 * Math.sqrt(3) * size * size;
export const style = resolveStyle({ preset: 'parchment', overrides: { water: 'flat', grain: false, grid: 'none', land: 'uniform' } });
export function render(map: MapState) {
  const scene = buildScene(map, { size, visible: defaultVisibility(), labels: false, style });
  const lake = scene.prims.filter(p => p.kind === 'path' && p.fill === style.palette.lake);
  const rings = lake.flatMap(p => p.kind === 'path' ? pathPolylines(p.d, 12) : []);
  assert.ok(rings.length);
  const ink = Math.max(0.8, size * style.palette.coastWidth * style.knobs.lineWeight) / 2;
  const water = evenOddTest(rings, size / 8);
  const landClip = [[{ x: -size, y: -size }, { x: 500, y: -size }, { x: 500, y: 500 }, { x: -size, y: 500 }], ...rings];
  const measure = areaCoverage(landClip, { evenOdd: true, stroke: { rings, reach: ink } });
  return { scene, rings, water, ink, share: (i = centre) => measure(hexCorners(i % cols, Math.floor(i / cols), size), 192) / hexArea };
}
/** Measure opposing banks in the final water outline, rather than filtering pairs by arc length. */
export function throat(draw: ReturnType<typeof render>, extent = 1) {
  const c = hexCenter(3, 3, size), step = size / 70;
  const nx = Math.ceil(Math.sqrt(3) * size * extent / step) + 2, ny = Math.ceil(size * 2 * extent / step) + 2;
  const x0 = c.x - Math.sqrt(3) * size * extent / 2, y0 = c.y - size * extent;
  const corners = hexCorners(3, 3, size);
  const clip = corners.map(p => ({ x: c.x + (p.x-c.x)*extent, y: c.y + (p.y-c.y)*extent }));
  const inside = evenOddTest([clip], size / 8);
  const labels = new Int16Array(nx * ny), bankOf = new Map<number, number>();
  const pointAt = (i: number) => ({ x: x0 + (i % nx) * step, y: y0 + Math.floor(i / nx) * step });
  const segmentDistance = (p: {x: number; y: number}, a: {x: number; y: number}, b: {x: number; y: number}) => {
    const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
  };
  for (let i = 0; i < labels.length; i++) { const p = pointAt(i); if (inside(p) && !draw.water(p)) labels[i] = -1; }
  let next = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] !== -1) continue;
    const id = ++next, queue = [i]; labels[i] = id;
    let group = 0;
    for (let at = 0; at < queue.length; at++) {
      const k = queue[at]!, p = pointAt(k), x = k % nx, y = Math.floor(k / nx);
      for (const e of [2, 4, 5]) if (segmentDistance(p, corners[e]!, corners[(e + 1) % 6]!) < step * 1.6) group |= e === 2 ? 2 : 1;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const xx = x + dx!, yy = y + dy!, j = yy * nx + xx;
        if (xx < 0 || xx >= nx || yy < 0 || yy >= ny || labels[j] !== -1) continue;
        labels[j] = id; queue.push(j);
      }
    }
    assert.notEqual(group, 3, 'opposing mainland banks must stay separate inside the strait');
    bankOf.set(id, group);
  }
  const shores: Array<Array<{x: number; y: number}>> = [[], [], []];
  for (const ring of draw.rings) for (let k = 1; k < ring.length; k++) {
    const a = ring[k - 1]!, b = ring[k]!, length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!length) continue;
    const count = Math.max(1, Math.ceil(length / step));
    for (let j = 0; j < count; j++) {
      const t = j / count, p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (!inside(p)) continue;
      for (const reach of [step * 1.5, step * 3]) {
        const q = { x: p.x + (b.y - a.y) / length * reach, y: p.y - (b.x - a.x) / length * reach };
        const x = Math.round((q.x - x0) / step), y = Math.round((q.y - y0) / step);
        if (x < 0 || x >= nx || y < 0 || y >= ny) continue;
        const group = bankOf.get(labels[y * nx + x]!);
        if (group === 1 || group === 2) { shores[group]!.push(p); break; }
      }
    }
  }
  let best = { distance: Infinity, x: 0, y: 0 };
  for (const a of shores[1]!) for (const b of shores[2]!) {
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    if (distance < best.distance) best = { distance, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
  assert.ok(Number.isFinite(best.distance), 'both connected mainland banks must be visible');
  return best;
}

export function connected(draw: ReturnType<typeof render>) {
  const c = hexCenter(3, 3, size), half = Math.sqrt(3) * size / 2, step = size / 80;
  const x0 = c.x - half + step, y0 = c.y - size;
  const nx = Math.floor((2 * half - 2 * step) / step), ny = 160;
  const hex = evenOddTest([hexCorners(3, 3, size)], size / 8);
  const segments = draw.rings.flatMap(r => r.slice(1).map((b, i) => [r[i]!, b] as const));
  const wet = new Uint8Array(nx * ny);
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const p = { x: x0 + x * step, y: y0 + y * step };
    if (hex(p) && draw.water(p) && segments.every(([a, b]) => {
      const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1))); return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy)>draw.ink;
    })) wet[y * nx + x] = 1;
  }
  const queue: number[] = [];
  for (let y = 0; y < ny; y++) if (wet[y * nx]) { queue.push(y * nx); wet[y * nx] = 2; }
  for (let at = 0; at < queue.length; at++) {
    const i = queue[at]!, x = i % nx, y = Math.floor(i / nx);
    if (x === nx - 1) return true;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const xx = x + dx!, yy = y + dy!, j = yy * nx + xx;
      if (xx < 0 || xx >= nx || yy < 0 || yy >= ny || wet[j] !== 1) continue;
      wet[j] = 2; queue.push(j);
    }
  }
  return false;
}

/** A chosen lake strait case: the water route stays open at the requested width, and the bank does not fold. */
export function assertLakeStraitCase(example: LakeStraitCase): void {
  const draw = render(lakeStraitFixture(example));
  assert.ok(connected(draw), 'a painted water route must remain between the two lake arms');
  const measured = throat(draw);
  assert.ok(measured.distance > draw.ink * 2, 'the opposing banks must remain separated after ink');
  const percent = { 'Very narrow': 5, Narrow: 15, Normal: 30, Wide: 50 }[example.width];
  assert.ok(Math.abs(measured.distance - percent / 100 * Math.sqrt(3) * size) < size * 0.04, `requested ${percent}% width, measured ${measured.distance}`);
  const segments = draw.rings.flatMap(r => r.slice(1).map((b, i) => [r[i]!, b] as const));
  const cross = (a: {x:number;y:number}, b: {x:number;y:number}, c: {x:number;y:number}) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const [a, b] = segments[i]!, [c, d] = segments[j]!;
    assert.ok(!(cross(a,b,c)*cross(a,b,d)<-1e-8 && cross(c,d,a)*cross(c,d,b)<-1e-8), `the bank outline must not fold across itself: ${JSON.stringify([a,b,c,d])}`);
  }
}
