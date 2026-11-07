import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, options } from '../../scripts/render-profile-input.ts';
import { buildStaticScene, type Scene } from '../../src/render/scene.ts';
import { beginRenderProfile, endRenderProfile } from '../../src/render/profile.ts';
import { hexCenter, type Point } from '../../shared/hex.ts';
import { pathPolylines } from '../../src/render/ice.ts';
import type { Prim } from '../../src/render/prims.ts';

/** Every coast polyline a scene draws. */
function coastRings(scene: Scene, stroke: string): Point[][] {
  const out: Point[][] = [];
  const walk = (list: Prim[]) => {
    for (const p of list) {
      if (p.kind === 'group') walk(p.prims);
      else if (p.kind === 'path' && p.stroke === stroke) out.push(...pathPolylines(p.d, 8));
    }
  };
  walk(scene.prims);
  return out;
}

/** The farthest any point of `rings` lies from the coast `other`. */
function farthest(rings: Point[][], other: Point[][]): number {
  const cell = 8, grid = new Map<string, Array<[Point, Point]>>();
  for (const r of other) for (let k = 0; k + 1 < r.length; k++) {
    const p = r[k]!, q = r[k + 1]!;
    for (let x = Math.floor(Math.min(p.x, q.x) / cell); x <= Math.floor(Math.max(p.x, q.x) / cell); x++)
      for (let y = Math.floor(Math.min(p.y, q.y) / cell); y <= Math.floor(Math.max(p.y, q.y) / cell); y++) {
        const key = `${x},${y}`;
        (grid.get(key) ?? grid.set(key, []).get(key)!).push([p, q]);
      }
  }
  let worst = 0;
  for (const r of rings) for (const p of r) {
    let best = Infinity;
    for (let reach = 1; reach <= 8 && best > (reach - 1) * cell; reach *= 2) {
      const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
      for (let i = cx - reach; i <= cx + reach; i++) for (let j = cy - reach; j <= cy + reach; j++) for (const [u, v] of grid.get(`${i},${j}`) ?? []) {
        const dx = v.x - u.x, dy = v.y - u.y, l = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((p.x - u.x) * dx + (p.y - u.y) * dy) / l));
        best = Math.min(best, Math.hypot(p.x - u.x - t * dx, p.y - u.y - t * dy));
      }
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

const misses = (scene: Scene) => new Set((scene.compromises ?? []).filter(c => c.what.includes('land drawn')).map(c => c.hexes[0]));

test('an incremental coastal edit refits only near the edit, keeps the far coast still and keeps the shares', () => {
  const map = fixture('populated'), base = options(), opts = { ...base, incrementalCoast: true }, { cols } = map, size = opts.size;
  const stroke = opts.style.palette.coast;
  let current = map;
  let previous = coastRings(buildStaticScene(current, opts), stroke);
  // Four coastal hexes turned to sea in turn: across the continent's shores and beside its islands.
  for (const hex of [871, 553, 650, 1253]) {
    current = { ...current, layers: { ...current.layers, base: { ...current.layers.base, data: current.layers.base.data!.map((v, i) => i === hex ? 'Sea' : v) } } };
    beginRenderProfile();
    const scene = buildStaticScene(current, opts);
    const { counters } = endRenderProfile()!;
    assert.ok((counters['coast.windowFits'] ?? 0) >= 2, `edit at ${hex}: both fits windowed`);
    assert.equal(counters['coast.windowFallbacks'] ?? 0, 0, `edit at ${hex}: no group fitted whole`);
    const fresh = buildStaticScene(current, { ...base, cache: 'off' });
    // The shares hold: no hex misses its share that a fresh build of the same map fits.
    const freshMisses = misses(fresh);
    for (const h of misses(scene)) assert.ok(freshMisses.has(h), `edit at ${hex}: hex ${h} misses its share only incrementally`);
    // Beyond five hexes of the edit the coast stays where it was drawn, where a fresh build slides
    // the roughening's features along the whole ring (DECISIONS §94), and stays near a fresh build.
    const at = hexCenter(hex % cols, Math.floor(hex / cols), size), radius = size * Math.sqrt(3) * 5;
    const now = coastRings(scene, stroke);
    const far = now.map(r => r.filter(p => Math.hypot(p.x - at.x, p.y - at.y) >= radius)).filter(r => r.length);
    const still = farthest(far, previous), apart = farthest(far, coastRings(fresh, stroke));
    assert.ok(still <= size * 0.12, `edit at ${hex}: the far coast moved ${still.toFixed(2)} px`);
    assert.ok(apart <= size * 0.6, `edit at ${hex}: the far coast is ${apart.toFixed(2)} px from a fresh build's`);
    previous = now;
  }
});
