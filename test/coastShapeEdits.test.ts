import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStaticScene, type Scene } from '../src/render/scene.ts';
import { pathPolylines } from '../src/render/ice.ts';
import type { Prim } from '../src/render/prims.ts';
import { editOptions } from '../scripts/render-edit-fixtures.ts';
import { hexCenter, type Point } from '../shared/hex.ts';
import type { HexShape, MapState } from '../shared/types.ts';
import { createMapState } from './seededMap.ts';

/** Every coastline the scene strokes, as polylines. */
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

/** The farthest any point of `rings` within `reach` of `at` lies from the coast `other`. */
function farthestNear(rings: Point[][], other: Point[][], at: Point, reach: number): number {
  let worst = 0;
  for (const ring of rings) for (const p of ring) {
    if (Math.hypot(p.x - at.x, p.y - at.y) > reach) continue;
    let best = Infinity;
    for (const q of other) for (let k = 0; k + 1 < q.length; k++) {
      const u = q[k]!, v = q[k + 1]!, dx = v.x - u.x, dy = v.y - u.y, l = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - u.x) * dx + (p.y - u.y) * dy) / l));
      best = Math.min(best, Math.hypot(p.x - u.x - t * dx, p.y - u.y - t * dy));
    }
    worst = Math.max(worst, best);
  }
  return worst;
}

// An incremental build keeps the previous coast wherever nothing changed. An edit to a hex's shape
// alone (its roughness or concentration) changes no land share, but must still redraw its coast
// (DECISIONS §94, §100, §103).
test('an incremental build redraws the coast for edits to roughness and concentration alone', () => {
  const options = { ...editOptions(), incrementalCoast: true }, stroke = options.style.palette.coast, { size } = options;
  const map = createMapState('Shape edits', 12, 10);
  map.layers.base.data = Array.from({ length: 120 }, (_, i) => i % 12 < 6 ? 'Land' : 'Sea');
  map.defaultIrregularity = 'Ragged';
  buildStaticScene(map, options);

  // A map-wide setting changes every hex: the coast is refitted whole, as a fresh build fits it.
  const rougher: MapState = { ...map, defaultIrregularity: 'Fractured' };
  const before = coastRings(buildStaticScene(rougher, options), stroke);
  assert.deepEqual(before, coastRings(buildStaticScene(rougher, { ...options, cache: 'off' }), stroke));

  // One hex's settings: its coast moves, as a fresh build moves it (the rest may keep its history).
  const at = hexCenter(5, 5, size), reach = size * 1.2;
  let previous = before, current = rougher;
  const shapes: Array<[string, HexShape]> = [
    ['concentration', { type: 'Land', land: 60, concentration: 80, concentrationSide: 0 }],
    ['irregularity', { type: 'Land', land: 60, concentration: 80, concentrationSide: 0, irregular: 'Smooth' }],
  ];
  for (const [what, shape] of shapes) {
    current = { ...current, hexShapes: { ...current.hexShapes, '65': shape } };
    const scene = buildStaticScene(current, options), incremental = coastRings(scene, stroke);
    const fresh = buildStaticScene(current, { ...options, cache: 'off' });
    assert.ok(farthestNear(incremental, previous, at, reach) > size * 0.15, `${what}: the coast at the hex moved`);
    // The coast round the edit is redrawn afresh (DECISIONS §103), so its features need not be a
    // fresh build's; the shares must hold wherever a fresh build holds them.
    const misses = (s: Scene) => new Set((s.compromises ?? []).filter(c => c.what.includes('land drawn')).map(c => c.hexes[0]));
    const freshMisses = misses(fresh);
    for (const h of misses(scene)) assert.ok(freshMisses.has(h), `${what}: hex ${h} misses its share only incrementally`);
    previous = incremental;
  }
});
