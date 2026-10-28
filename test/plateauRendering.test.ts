import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';
import { escarpment, plateauRimVertex, samplePoints, smoothPlateauRims } from '../src/render/symbols.ts';
import type { Prim } from '../src/render/prims.ts';

test('a multi-hex plateau has a joined rim, including inward corners, without interior cliffs', () => {
  const map = createMapState('Joined plateau', 7, 7);
  map.id = 'joined-plateau';
  map.layers.base.data = Array(49).fill('Land');
  map.layers.elevation.data = Array(49).fill('Lowland');
  for (const i of [16, 17, 23, 24, 25, 30, 31]) map.layers.elevation.data![i] = 'Plateau';
  const opts = { size: 40, labels: false, visible: { ...defaultVisibility(), elevation: true },
    style: resolveStyle({ preset: 'parchment', overrides: { grid: 'none', grain: false } }) };
  const scene = buildScene(map, opts);
  const rims = scene.prims.filter((p): p is Extract<Prim, { kind: 'path' }> =>
    p.kind === 'path' && !!p.stroke && !p.fill && p.d.filter(c => c[0] === 'M').length >= 5);
  assert.ok(rims.length > 6);
  const degree = new Map<string, number>();
  for (const rim of rims) {
    for (const cmd of [rim.d[0]!, rim.d[rim.d.findIndex((cmd, i) => i > 0 && cmd[0] === 'M') - 1]!]) {
      const key = `${Number(cmd[1]).toFixed(5)},${Number(cmd[2]).toFixed(5)}`;
      degree.set(key, (degree.get(key) ?? 0) + 1);
    }
  }
  assert.ok([...degree.values()].every(n => n === 2), 'Each rim end must meet exactly one other edge');
  assert.deepEqual(buildScene(map, opts).prims, scene.prims, 'Weathering must stay deterministic');
});

test('shared plateau corners do not depend on the order of their hexes', () => {
  const vertex = { x: 0, y: 0 };
  const centres = [{ x: 0, y: 40 }, { x: 34.641016, y: -20 }];
  assert.deepEqual(plateauRimVertex(vertex, centres, 40), plateauRimVertex(vertex, [...centres].reverse(), 40));
});

test('cliff face and hachures stay between the lip and the foot of the escarpment', () => {
  const scarp = escarpment({ x: 0, y: -20 }, { x: 40, y: -20 }, { x: 20, y: 20 }, 40,
    { ground: '#cbab74', ink: '#443322' }, () => 0.5);
  assert.ok(scarp.prims.some(p => p.kind === 'path' && p.fill));
  assert.ok(samplePoints(scarp).every(p => p.y >= -20 && p.y < -14));
});


test('smoothing removes the repeated hex zigzag while keeping open ends fixed', () => {
  const corners = Array.from({ length: 7 }, (_, k) => ({ x: k * 40, y: k % 2 * 20 }));
  const rims = smoothPlateauRims(corners.slice(1).map((p, k) => [corners[k]!, p]));
  assert.deepEqual(rims[0]![0], corners[0]);
  assert.deepEqual(rims.at(-1)!.at(-1), corners.at(-1));
  assert.ok(rims.slice(2, 4).flat().every(p => Math.abs(p.y - 10) < 1),
    'The middle of the cliff should follow a broad contour, rather than round each tooth');
  for (let k = 1; k < rims.length; k++) assert.deepEqual(rims[k - 1]!.at(-1), rims[k]![0]);
});

test('contour shaping breaks long straight runs at terrain scale and preserves open ends', () => {
  const corners = Array.from({ length: 9 }, (_, k) => ({ x: k * 40, y: 0 }));
  const input: Array<[typeof corners[number], typeof corners[number]]> = corners.slice(1).map((p, k) => [corners[k]!, p]);
  const options = { size: 40, seed: 0.17 };
  const shaped = smoothPlateauRims(input, options);
  const y = shaped.flat().map(p => p.y);
  assert.ok(Math.max(...y) - Math.min(...y) > 8, 'The silhouette must change substantially, rather than add tiny edge noise');
  assert.deepEqual(shaped[0]![0], corners[0]);
  assert.deepEqual(shaped.at(-1)!.at(-1), corners.at(-1));
  for (let k = 1; k < shaped.length; k++) {
    const a = shaped[k - 1]!.at(-1)!, b = shaped[k]![0]!;
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-7);
  }
  assert.deepEqual(smoothPlateauRims(input, options), shaped);
  assert.notDeepEqual(smoothPlateauRims(input, { ...options, seed: 0.71 }), shaped);
});

test('reshaping small mesas does not fold the contour into loops', () => {
  const corners = Array.from({ length: 6 }, (_, k) => ({ x: 100 + Math.cos(k*Math.PI/3)*40, y: 100 + Math.sin(k*Math.PI/3)*40 }));
  const edges: Array<[typeof corners[number], typeof corners[number]]> = corners.map((p, k) => [p, corners[(k+1)%6]!]);
  const cross = (a: {x: number; y: number}, b: {x: number; y: number}, c: {x: number; y: number}) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  for (const seed of [0, 0.17, 0.28, 0.5, 0.71, 0.95]) {
    const points = smoothPlateauRims(edges, { size: 40, seed }).flatMap(r => r.slice(0, -1));
    for (let i = 0; i < points.length; i++) for (let j = i+2; j < points.length; j++) {
      if (i === 0 && j === points.length-1) continue;
      const a = points[i]!, b = points[(i+1)%points.length]!, c = points[j]!, d = points[(j+1)%points.length]!;
      assert.ok(!(cross(a,b,c)*cross(a,b,d) < -1e-8 && cross(c,d,a)*cross(c,d,b) < -1e-8), `Crossing in mesa contour for seed ${seed}`);
    }
  }
});
