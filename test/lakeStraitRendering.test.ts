import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from './seededMap.ts';
import { buildScene, defaultVisibility, landTestOf } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';
import { pathPolylines } from '../src/render/ice.ts';
import { areaCoverage } from '../src/render/footprint.ts';
import { evenOddTest } from '../src/render/coast.ts';
import { hexCenter, hexCorners, neighbourOf } from '../shared/hex.ts';
import type { ChannelWidth, Irregularity, MapState } from '../shared/types.ts';
const size = 30, cols = 7, centre = 24, hexArea = 1.5 * Math.sqrt(3) * size * size;
const style = resolveStyle({ preset: 'parchment', overrides: { water: 'flat', grain: false, grid: 'none', land: 'uniform' } });

/** A lake between a northern shore and a southwestern peninsula, as reported. */
function fixture(width: ChannelWidth = 'Normal', side?: number, land?: number, irregular: Irregularity = 'Ragged'): MapState {
  const map = createMapState('Lake strait regression', cols, cols);
  map.id = 'lake-strait';
  const base = map.layers.base.data = Array(49).fill('Land');
  for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) base[y * cols + x] = 'Lake';
  base[centre] = 'Strait';
  for (const e of [2, 4, 5]) {
    const n = neighbourOf(3, 3, e), n2 = neighbourOf(n.col, n.row, e);
    base[n.row * cols + n.col] = 'Land';
    base[n2.row * cols + n2.col] = 'Land';
  }
  map.hexShapes = { [centre]: { type: 'Strait', width, straitJunctionSide: side, land, irregular } };
  map.defaultLakeIrregularity = irregular;
  return map;
}
function render(map: MapState) {
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
function gapAt(draw: ReturnType<typeof render>, x: number) {
  const c = hexCenter(3, 3, size);
  let count = 0, ySum = 0;
  const inHex = evenOddTest([hexCorners(3, 3, size)], size / 8);
  for (let y = c.y - size; y <= c.y + size; y += 0.1) {
    if (inHex({ x, y }) && draw.water({ x, y })) { count++; ySum += y; }
  }
  return { width: count * 0.1, y: ySum / count };
}
/** Closest opposing shore points inside the hex, excluding nearby points along the same bank. */
function throat(draw: ReturnType<typeof render>) {
  const inside = evenOddTest([hexCorners(3, 3, size)], size / 8);
  let best = { distance: Infinity, x: 0, y: 0 };
  for (const ring of draw.rings) {
    let arc = 0;
    const points: Array<{ x: number; y: number; arc: number }> = [];
    for (let k = 1; k < ring.length; k++) {
      const a = ring[k - 1]!, b = ring[k]!, length = Math.hypot(b.x - a.x, b.y - a.y);
      const count = Math.max(1, Math.ceil(length / 0.2));
      for (let j = 0; j < count; j++) {
        const t = j / count, p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, arc: arc + length * t };
        if (inside(p)) points.push(p);
      }
      arc += length;
    }
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      const a = points[i]!, b = points[j]!, gap = Math.abs(b.arc - a.arc);
      if (Math.min(gap, arc - gap) < size * 2) continue;
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (distance < best.distance) best = { distance, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }
  }
  return best;
}

function connected(draw: ReturnType<typeof render>) {
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

test('narrow lake straits retain a continuous water route after roughening and coastline ink', () => {
  for (const irregular of ['Smooth', 'Ragged', 'Fractured'] as const) for (const width of ['Very narrow', 'Narrow'] as const) {
    const draw = render(fixture(width, undefined, undefined, irregular));
    assert.ok(connected(draw), `${irregular}, ${width}: lake passage pinched shut`);
  }
});
test('lake strait widths alter the rendered constriction', () => {
  const c = hexCenter(3, 3, size);
  const narrow = render(fixture('Narrow')), normal = render(fixture('Normal'));
  assert.ok(gapAt(normal, c.x).width > gapAt(narrow, c.x).width + size * 0.1);
});
test('west and east lake junction selections move the rendered passage', () => {
  const west = render(fixture('Normal', 3)), east = render(fixture('Normal', 0));
  assert.notDeepEqual(west.rings, east.rings, 'junction setting must affect final lake shore');
  const c = hexCenter(3, 3, size), dx = size * 0.6;
  const westThroat = throat(west), eastThroat = throat(east);
  assert.ok(westThroat.x < c.x - size * 0.15, 'western selection puts the constriction west of centre');
  assert.ok(eastThroat.x > c.x + size * 0.15, 'eastern selection puts the constriction east of centre');
  assert.ok(eastThroat.x - westThroat.x > size * 0.5, 'the constriction follows the selected side');
  // The banks are non-opposite: compare the route's position, not vertical
  // mouth widths (which also depend on the channel's angle).
  assert.ok(west.water({ x: c.x - dx, y: c.y }), 'western junction lies in water');
  assert.ok(east.water({ x: c.x + dx, y: c.y }), 'eastern junction lies in water');
  assert.equal(west.water({ x: c.x + dx, y: c.y }), false, 'the eastern junction was land before moving it');
  assert.equal(landTestOf(west.scene)?.({ x: c.x + dx, y: c.y }), true, 'expanded lake bank is available for land placement');
  assert.equal(landTestOf(east.scene)?.({ x: c.x + dx, y: c.y }), false, 'moved channel is water for placement too');
  assert.ok(connected(west)); assert.ok(connected(east));
});
test('lake strait land shares are measured on the drawn bank and unattainable shares are reported', () => {
  const low = render(fixture('Narrow', undefined, 30));
  const middle = render(fixture('Narrow', undefined, 50));
  assert.ok(Math.abs(low.share() - 0.3) < 0.01);
  assert.ok(Math.abs(middle.share() - 0.5) < 0.01);
  const high = render(fixture('Normal', undefined, 80));
  assert.ok(high.share() > middle.share());
  const note = high.scene.compromises?.find(c => c.hexes.includes(centre));
  assert.match(note?.why ?? '', /width/);
  assert.ok(Math.abs(Number(note?.what.match(/^(\d+)%/)?.[1]) / 100 - high.share()) < 0.01);
});
test('lake shores adjoining a strait retain their own land-share controls', () => {
  const map = fixture();
  map.hexShapes!['8'] = { type: 'Lake', land: 30 };
  const draw = render(map);
  assert.ok(Math.abs(draw.share(8) - 0.3) < 0.01);
});

test('a separate lake keeps its existing outline when another lake contains a strait', () => {
  const map = fixture();
  map.layers.base.data![0] = 'Lake';
  const before = render(map).rings[0];
  map.layers.base.data![centre] = 'Lake';
  const after = render(map).rings[0];
  assert.deepEqual(before, after);
});
test('editing a lake junction and undoing it restores the cached rendered shore', () => {
  const map = fixture('Normal', 3);
  const west = render(map).rings;
  map.hexShapes![centre]!.straitJunctionSide = 0;
  const east = render(map).rings;
  assert.notDeepEqual(west, east);
  map.hexShapes![centre]!.straitJunctionSide = 3;
  assert.deepEqual(render(map).rings, west);
  const uncached = buildScene(map, { size, visible: defaultVisibility(), labels: false, style, cache: 'off' });
  assert.deepEqual(uncached.prims, render(map).scene.prims);
});

test('a lake passage reaching the map edge closes its water clip along the page', () => {
  const map = fixture('Narrow');
  for (let x = 0; x < 3; x++) map.layers.base.data![3 * cols + x] = 'Lake';
  const draw = render(map);
  assert.ok(connected(draw));
  assert.equal(draw.water(hexCenter(0, 3, size)), true);
  assert.equal(draw.water(hexCenter(0, 0, size)), false);
  assert.equal(draw.water(hexCenter(6, 6, size)), false);
});
