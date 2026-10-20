import assert from 'node:assert/strict';
import test from 'node:test';
import { lakeStraitFixture, LAKE_STRAIT_CASES } from './fixtures/lakeStrait.ts';
import { buildScene, defaultVisibility, landTestOf } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';
import { pathPolylines } from '../src/render/ice.ts';
import { lakeStraitFrame, areaCoverage } from '../src/render/footprint.ts';
import { evenOddTest } from '../src/render/coast.ts';
import { hexCenter, hexCorners } from '../shared/hex.ts';
import type { ChannelWidth, Irregularity, MapState } from '../shared/types.ts';
const size = 30, cols = 7, centre = 24, hexArea = 1.5 * Math.sqrt(3) * size * size;
const style = resolveStyle({ preset: 'parchment', overrides: { water: 'flat', grain: false, grid: 'none', land: 'uniform' } });

/** A lake between a northern shore and a southwestern peninsula, as reported. */
function fixture(width: ChannelWidth = 'Normal', side?: number, land?: number, irregular: Irregularity = 'Ragged'): MapState {
  return lakeStraitFixture({ width, side, land, irregular });
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
/** Measure opposing banks in the final water outline, rather than filtering pairs by arc length. */
function throat(draw: ReturnType<typeof render>, extent = 1) {
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
  const narrow = render(fixture('Narrow')), normal = render(fixture('Normal'));
  assert.ok(throat(normal).distance > throat(narrow).distance + size * 0.1);
  for (const [draw, fraction] of [[narrow, 0.15], [normal, 0.3]] as const) {
    const actual = throat(draw).distance, expected = fraction * Math.sqrt(3) * size;
    assert.ok(Math.abs(actual - expected) < size * 0.04, `painted shore width ${actual} must match requested ${expected}`);
  }
});
test('west and east lake junction selections move the rendered passage', () => {
  const west = render(fixture('Normal', 3)), east = render(fixture('Normal', 0));
  assert.notDeepEqual(west.rings, east.rings, 'junction setting must affect final lake shore');
  const c = hexCenter(3, 3, size);
  const westThroat = throat(west), eastThroat = throat(east);
  assert.ok(westThroat.x < c.x - size * 0.4, 'western selection puts the constriction west of centre');
  assert.ok(eastThroat.x > c.x + size * 0.4, 'eastern selection puts the constriction east of centre');
  assert.ok(eastThroat.x - westThroat.x > size * 0.8, 'the constriction follows the selected side');
  // The banks are non-opposite: compare the route's position, not vertical
  // mouth widths (which also depend on the channel's angle).
  assert.ok(west.water(westThroat), 'western junction lies in water');
  assert.ok(east.water(eastThroat), 'eastern junction lies in water');
  assert.equal(landTestOf(west.scene)?.({ x: c.x, y: c.y - size * 0.75 }), true, 'expanded lake bank is available for land placement');
  assert.equal(landTestOf(east.scene)?.(eastThroat), false, 'moved channel is water for placement too');
  assert.ok(connected(west)); assert.ok(connected(east));
});
test('lake straits report land shares without sacrificing their headland shape to high targets', () => {
  const low = render(fixture('Narrow', undefined, 30));
  const middle = render(fixture('Narrow', undefined, 50));
  assert.ok(Math.abs(low.share() - 0.3) < 0.01, `30% request rendered ${low.share()}`);
  assert.ok(Math.abs(middle.share() - 0.5) < 0.01, `50% request rendered ${middle.share()}`);
  const natural = render(fixture('Narrow'));
  const eighty = render(fixture('Narrow', undefined, 80));
  assert.deepEqual(eighty.rings, natural.rings, '80% must not flatten the headlands to force a land-area target');
  const note = eighty.scene.compromises?.find(c => c.hexes.includes(centre));
  assert.ok(note, 'the ignored high target must be reported');
  assert.ok(Math.abs(Number(note.what.match(/^(\d+)%/)?.[1]) / 100 - eighty.share()) < 0.01);
});

test('natural lake straits are short gaps between tips, opening rapidly on both sides', () => {
  const c = hexCenter(3, 3, size), corners = hexCorners(3, 3, size);
  for (const irregular of ['Smooth', 'Ragged', 'Fractured'] as const) {
    const draw = render(fixture('Narrow', undefined, undefined, irregular));
    const frame = lakeStraitFrame(corners, c, [2, 4, 5], .15 * Math.sqrt(3) * size)!;
    const normal = frame.normal, tangent = { x: normal.y, y: -normal.x };
    const gap = (u: number) => {
      const at = (v: number) => ({ x: frame.centre.x + tangent.x * u + normal.x * v,
        y: frame.centre.y + tangent.y * u + normal.y * v });
      assert.ok(draw.water(at(0)), 'the short throat must connect to both wider water bodies');
      let width = 0;
      for (const side of [-1, 1]) for (let v = .1; v < size * 1.5; v += .1) {
        if (!draw.water(at(v * side))) break;
        width += .1;
      }
      return width;
    };
    const neck = gap(0);
    for (const side of [-1, 1]) assert.ok(gap(side * size * .4) > neck + size * .25,
      `${irregular}: banks must recede within 0.4 radii of the tips, not form a long canal`);
  }
});
test('lake shores adjoining a strait retain their own land-share controls', () => {
  const map = fixture();
  map.hexShapes!['25'] = { type: 'Lake', land: 30 };
  const draw = render(map);
  assert.ok(Math.abs(draw.share(25) - 0.3) < 0.01, `adjoining lake land share: ${draw.share(25)}`);
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

for (const [index, example] of LAKE_STRAIT_CASES.entries()) {
  test(`representative lake strait ${index + 1}: ${example.width}, side=${example.side ?? 'middle'}, land=${example.land ?? 'natural'}, ${example.irregular}`, () => {
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
  });
}

test('editing a passage preserves the distant shore of the same lake', () => {
  const narrow = render(fixture('Narrow')), normal = render(fixture('Normal'));
  const c = hexCenter(3, 3, size);
  const distanceTo = (p: {x:number;y:number}, rings: typeof normal.rings) => {
    let best = Infinity;
    for (const ring of rings) for (let k = 1; k < ring.length; k++) {
      const a = ring[k-1]!, b = ring[k]!, dx = b.x-a.x, dy = b.y-a.y;
      const t = Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));
      best = Math.min(best,Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy));
    }
    return best;
  };
  let checked = 0;
  for (const p of narrow.rings.flat()) if (Math.hypot(p.x-c.x,p.y-c.y) > size*2.6) {
    assert.ok(distanceTo(p,normal.rings) < size*0.006, 'changing width must not redraw the distant lake shore');
    checked++;
  }
  assert.ok(checked > 20);
});
