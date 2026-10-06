import assert from 'node:assert/strict';
import test from 'node:test';
import { gridPixelSize, hexCorners, SQRT3 } from '../shared/hex.js';
import type { PathCmd } from '../src/render/prims.js';

function area(points: Array<{ x: number; y: number }>): number {
  let sum = 0;
  points.forEach((p, k) => {
    const q = points[(k + 1) % points.length]!;
    sum += p.x * q.y - q.x * p.y;
  });
  return Math.abs(sum) / 2;
}

test('the notches a hex grid leaves at the page edge are given to the border hexes beside them', async () => {
  const { rimPieces } = await import('../src/render/rim.js');
  for (const [cols, rows] of [[4, 3], [5, 4], [3, 1], [1, 3]] as const) {
    const size = 10;
    const bounds = gridPixelSize(cols, rows, size);
    let covered = 0;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        covered += area(hexCorners(col, row, size));
        for (const piece of rimPieces(cols, rows, size, col, row, bounds)) covered += area(piece.points);
      }
    }
    assert.ok(Math.abs(covered - bounds.width * bounds.height) < 1e-6 * bounds.width * bounds.height, `${cols}x${rows}: hexes and rim pieces fill the page (${covered} of ${bounds.width * bounds.height})`);
  }
  assert.ok(SQRT3 > 1);
});

test('a coast carried to the page edge leaves junctions inside the map alone', async () => {
  const { extendToRim } = await import('../src/render/rim.js');
  const bounds = { width: 100, height: 100 };
  const path: PathCmd[] = [['M', 5, 40], ['L', 50, 50]];
  const out = extendToRim(path, false, bounds, 10);
  // The first end is 5 from the left edge, so it runs out to it; the second is mid-map and stays.
  assert.deepEqual(out[0], ['M', 0, 40]);
  assert.deepEqual(out[out.length - 1], ['L', 50, 50]);
  assert.deepEqual(path, [['M', 5, 40], ['L', 50, 50]], 'the input is not changed');
  assert.equal(extendToRim(path, true, bounds, 10), path, 'closed paths are as they were');
});

test('pack ice reaches the page edge across the rim notches', async () => {
  const { createMapState } = await import('../shared/layers.js');
  const { buildScene, defaultVisibility } = await import('../src/render/scene.js');
  const { resolveStyle } = await import('../src/render/styles.js');
  const map = createMapState('Pack', 3, 2);
  map.layers.base.data = ['Sea Ice', 'Sea Ice', 'Sea Ice', 'Sea Ice', 'Sea Ice', 'Sea Ice'];
  const style = resolveStyle({ preset: 'parchment', overrides: {} });
  const prims = buildScene(map, { size: 20, visible: defaultVisibility(), labels: false, style }).prims;
  // The notch beside the first hex of the odd row (centre y = 50 at size 20) runs out to the page edge at y = 40 and 60.
  const clip = prims
    .flatMap((p) => (p.kind === 'group' && p.clip ? [p.clip] : []))
    .find((c) => c.some((cmd) => cmd[0] !== 'Z' && cmd.at(-2) === 0 && cmd.at(-1) === 40));
  assert.ok(clip, 'the frozen sea is clipped to water that includes the notches at the edge');
});

test('where a glacier ends on land its edge is its own line, shaded by the height it climbs', async () => {
  const { createMapState } = await import('../shared/layers.js');
  const { buildScene, defaultVisibility } = await import('../src/render/scene.js');
  const { resolveStyle } = await import('../src/render/styles.js');
  const style = resolveStyle({ preset: 'parchment', overrides: {} });
  const build = (ground: 'Lowland' | 'Mountains') => {
    const map = createMapState('Margin', 6, 3);
    map.id = 'glacier-margin-ground'; // Compare ground height with the same noise realization.
    map.layers.base.data = Array.from({ length: 18 }, (_, i) => (i % 6 < 3 ? 'Glacier' : 'Land'));
    map.layers.elevation.data = Array.from({ length: 18 }, (_, i) => (i % 6 < 3 ? 'Hills' : ground));
    const visible = { ...defaultVisibility(), elevation: true };
    return buildScene(map, { size: 20, visible, labels: false, style }).prims;
  };
  const marginOf = (prims: ReturnType<typeof build>) =>
    prims.find((p) => p.kind === 'group' && p.clipRule === 'evenodd' && p.prims.some((q) => q.kind === 'path' && q.strokeWidth !== undefined && q.round));
  assert.ok(marginOf(build('Lowland')), 'the ice margin is drawn as a line of its own');
  // Ice that climbs onto higher ground reaches further out than ice held back by lower ground.
  const reach = (prims: ReturnType<typeof build>): number => {
    const group = marginOf(prims);
    assert.ok(group && group.kind === 'group');
    const line = group.prims.filter((q) => q.kind === 'path').at(-1);
    assert.ok(line && line.kind === 'path');
    const xs = line.d.flatMap((c) => (c[0] === 'M' || c[0] === 'L' ? [c[1]] : c[0] === 'Q' ? [c[3]] : []));
    return Math.max(...xs);
  };
  assert.ok(reach(build('Mountains')) > reach(build('Lowland')), 'ice climbs onto high ground and holds back on low ground');
});
