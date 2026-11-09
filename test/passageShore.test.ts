/** Straits and isthmuses in the full scene: a short narrows of the set width between rounded tips. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildScene, defaultVisibility, landTestOf } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';
import { lakeStraitFrame } from '../src/render/footprint.ts';
import { pathPolylines } from '../src/render/ice.ts';
import { evenOddTest } from '../src/render/coast.ts';
import { hexCenter, hexCorners, neighbourOf } from '../shared/hex.ts';
import { validateHexDefinitions } from '../shared/hexValidation.ts';
import { CHANNEL_WIDTH_PERCENT, type BaseGeo, type ChannelWidth, type MapState } from '../shared/types.ts';
import { createMapState } from './seededMap.ts';
import { lakeStraitFixture } from './fixtures/lakeStrait.ts';

const size = 30, cols = 9, rows = 9, centre = 4 * cols + 4;
const style = resolveStyle({ preset: 'parchment', overrides: { water: 'flat', grain: false, grid: 'none', land: 'uniform' } });
const middle = hexCenter(4, 4, size), corners = hexCorners(4, 4, size);
/** Land neighbours by edge: opposite banks, and three land sides in two groups. */
const OPPOSITE = 0b001001, TWO_APART = 0b000101, THREE = 0b001011, THREE_AND_ONE = 0b101011;

/**
 * Two land masses and two waters, each filling the wedge of the map behind one neighbour of the
 * middle hex, as real ones would: every map here has exactly two land and two water groups round it.
 */
function passage(type: 'Strait' | 'Isthmus', width: ChannelWidth, mask: number, water: BaseGeo = 'Sea', land?: number): MapState {
  const map = createMapState('Passage fixture', cols, rows);
  const base: BaseGeo[] = Array(cols * rows).fill(water);
  const dirs = [0, 1, 2, 3, 4, 5].map(e => {
    const n = neighbourOf(4, 4, e), q = hexCenter(n.col, n.row, size);
    return Math.atan2(q.y - middle.y, q.x - middle.x);
  });
  for (let i = 0; i < base.length; i++) {
    if (i === centre) continue;
    const q = hexCenter(i % cols, Math.floor(i / cols), size), a = Math.atan2(q.y - middle.y, q.x - middle.x);
    let best = 0, gap = 9;
    for (let e = 0; e < 6; e++) {
      const d = Math.abs(Math.atan2(Math.sin(a - dirs[e]!), Math.cos(a - dirs[e]!)));
      if (d < gap - 1e-9) { gap = d; best = e; }
    }
    if (mask & (1 << best)) base[i] = 'Land';
  }
  base[centre] = type;
  map.layers.base.data = base;
  map.hexShapes = { [centre]: { type, width, ...(land === undefined ? {} : { land }) } };
  assert.deepEqual(validateHexDefinitions(map), [], 'fixtures must be possible maps');
  return map;
}

function draw(map: MapState) {
  const scene = buildScene(map, { size, visible: defaultVisibility(), labels: false, style });
  return { scene, land: landTestOf(scene)! };
}

/** The passing kind's extent across the passage at `u` along it, from the frame the drawing uses. */
function gauge(type: 'Strait' | 'Isthmus', width: ChannelWidth, mask: number, land: (p: { x: number; y: number }) => boolean) {
  const held = [0, 1, 2, 3, 4, 5].filter(e => ((mask >> e) & 1) === (type === 'Strait' ? 1 : 0));
  const frame = lakeStraitFrame(corners, middle, held, CHANNEL_WIDTH_PERCENT[width] / 100 * Math.sqrt(3) * size)!;
  const normal = frame.normal, tangent = { x: normal.y, y: -normal.x };
  const passing = (p: { x: number; y: number }) => land(p) === (type === 'Isthmus');
  return (u: number) => {
    const at = (v: number) => ({ x: frame.centre.x + tangent.x * u + normal.x * v, y: frame.centre.y + tangent.y * u + normal.y * v });
    if (!passing(at(0))) return 0;
    let extent = 0;
    for (const side of [-1, 1]) for (let v = .1; v < size * 1.5 && passing(at(v * side)); v += .1) extent += .1;
    return extent;
  };
}

test('sea straits and isthmuses, and isthmuses in lakes, narrow to their width between rounded tips', () => {
  const cases: Array<['Strait' | 'Isthmus', ChannelWidth, number, BaseGeo]> = [
    ['Strait', 'Narrow', OPPOSITE, 'Sea'], ['Strait', 'Normal', THREE, 'Sea'],
    ['Isthmus', 'Narrow', OPPOSITE, 'Sea'], ['Isthmus', 'Normal', THREE, 'Sea'],
    ['Isthmus', 'Normal', OPPOSITE, 'Lake'],
    // A bank of three edges, and banks two apart, at the narrowest width.
    ['Strait', 'Very narrow', THREE_AND_ONE, 'Sea'], ['Isthmus', 'Very narrow', TWO_APART, 'Sea'],
  ];
  for (const [type, width, mask, water] of cases) {
    const label = `${water} ${type}, ${width}, mask ${mask}`;
    const gap = gauge(type, width, mask, draw(passage(type, width, mask, water)).land);
    const throat = gap(0), wanted = CHANNEL_WIDTH_PERCENT[width] / 100 * Math.sqrt(3) * size;
    assert.ok(Math.abs(throat - wanted) < size * .08, `${label}: throat ${throat.toFixed(1)}, set ${wanted.toFixed(1)}`);
    for (const side of [-1, 1]) assert.ok(gap(side * size * .4) > throat + size * .25,
      `${label}: the shores must part within 0.4 radii of the throat, not run on as a canal`);
  }
});

test('a passage share within reach is drawn; one beyond it is reported, not drawn as a canal', () => {
  const met = draw(passage('Strait', 'Normal', OPPOSITE, 'Sea', 30));
  assert.equal(met.scene.compromises?.find(c => c.hexes.includes(centre)), undefined, '30% fits a Normal strait');
  const isthmus = draw(passage('Isthmus', 'Normal', OPPOSITE, 'Sea', 70));
  assert.equal(isthmus.scene.compromises?.find(c => c.hexes.includes(centre)), undefined, '70% fits a Normal isthmus');
  // 55% is within a Normal strait's range, but more than banks opposite each other can hold as a narrows.
  const far = draw(passage('Strait', 'Normal', OPPOSITE, 'Sea', 55));
  assert.ok(far.scene.compromises?.find(c => c.hexes.includes(centre)), 'opposite banks cannot hold 55% land round a Normal strait');
  const gap = gauge('Strait', 'Normal', OPPOSITE, far.land);
  for (const side of [-1, 1]) assert.ok(gap(side * size * .4) > gap(0) + size * .25, 'still a short narrows');
});

test('an isthmus in a lake is painted as land across its neck, with no lake fill left inside it', () => {
  const { scene, land } = draw(passage('Isthmus', 'Wide', OPPOSITE, 'Lake'));
  const held = [1, 2, 4, 5];
  const frame = lakeStraitFrame(corners, middle, held, .5 * Math.sqrt(3) * size)!;
  // Inside the neck, beside the throat, where the hex's water sectors lay before it was reshaped.
  const probes = [-1, 1].map(s => ({ x: frame.centre.x + frame.normal.x * size * .3 * s, y: frame.centre.y + frame.normal.y * size * .3 * s }));
  for (const p of probes) assert.ok(land(p), 'the neck is land');
  const lakeFills: Array<{ x: number; y: number }[][]> = [];
  const walk = (prims: typeof scene.prims) => {
    for (const prim of prims) {
      if (prim.kind === 'group') walk(prim.prims);
      else if (prim.kind === 'polygon' && prim.fill === style.palette.lake) lakeFills.push([prim.points]);
      else if (prim.kind === 'path' && prim.fill === style.palette.lake) lakeFills.push(pathPolylines(prim.d, 6));
    }
  };
  walk(scene.prims);
  for (const rings of lakeFills) for (const p of probes) assert.ok(!evenOddTest(rings, size / 8)(p), 'no lake paint over the neck');
});

test('a strait in a sea one hex wide keeps its banks where the old coast only grazes the reshaped area', () => {
  // The drawing investigation's strait: rows offset so that each bank meets the hex on two edges.
  for (const width of ['Very narrow', 'Normal'] as const) {
    const map = createMapState('Strait ink', 7, 7);
    map.layers.base.data = Array.from({ length: 49 }, (_, i) => i % 7 === 3 ? 'Sea' : 'Land');
    map.layers.base.data[24] = 'Strait';
    map.hexShapes = { '24': { type: 'Strait', width } };
    assert.deepEqual(validateHexDefinitions(map), []);
    const { scene, land } = draw(map);
    const c = hexCenter(3, 3, size), inside = evenOddTest([hexCorners(3, 3, size)], size / 8);
    let n = 0, dry = 0;
    for (let x = c.x - size; x <= c.x + size; x += 1) for (let y = c.y - size; y <= c.y + size; y += 1)
      if (inside({ x, y })) { n++; if (land({ x, y })) dry++; }
    assert.ok(dry / n > .25, `${width}: the banks must be drawn, not opened into sea (${(100 * dry / n).toFixed(1)}% land)`);
    assert.ok(scene.prims.length > 0);
  }
});

/** Every filled primitive whose fill covers `p`, in paint order, within the clips it is drawn in. */
function paintAt(prims: ReturnType<typeof draw>['scene']['prims'], p: { x: number; y: number }): string[] {
  const out: string[] = [];
  const walk = (list: typeof prims) => {
    for (const prim of list) {
      if (prim.kind === 'group') {
        if (prim.clip && !evenOddTest(pathPolylines(prim.clip, 6), size / 8)(p)) continue;
        walk(prim.prims);
      } else if (prim.kind === 'polygon' && prim.fill && evenOddTest([prim.points], size / 8)(p)) out.push(prim.fill);
      else if (prim.kind === 'path' && prim.fill && evenOddTest(pathPolylines(prim.d, 6), size / 8)(p)) out.push(prim.fill);
    }
  };
  walk(prims);
  return out;
}
const opaque = (fill: string) => /^#[0-9a-f]{6}$/i.test(fill);

test('a reshaped isthmus keeps its own colours across its neck', () => {
  // A mountain isthmus between lowlands, coloured by elevation: its neck is mountain-coloured, not lowland.
  const map = passage('Isthmus', 'Wide', OPPOSITE, 'Sea');
  map.layers.elevation.data = map.layers.base.data!.map((v, i) => i === centre ? 'Mountains' : v === 'Land' ? 'Lowland' : null);
  const style = resolveStyle({ preset: 'parchment', overrides: { water: 'flat', grain: false, grid: 'none', land: 'uniform', relief: 'colour' } });
  const scene = buildScene(map, { size, visible: { ...defaultVisibility(), elevation: true }, labels: false, style });
  assert.ok(landTestOf(scene)!(middle), 'the neck is land');
  const neck = paintAt(scene.prims, middle).filter(opaque).at(-1);
  const n = neighbourOf(4, 4, 0), lowland = paintAt(scene.prims, hexCenter(n.col, n.row, size)).filter(opaque).at(-1);
  assert.ok(neck && lowland && neck !== lowland, `the neck is painted ${neck}, the lowland beside it ${lowland}`);
});

test('hill shading still shows on land repainted round a reshaped passage', () => {
  const map = passage('Isthmus', 'Normal', OPPOSITE, 'Sea');
  const n = neighbourOf(4, 4, 0), hill = n.row * cols + n.col;
  map.layers.elevation.data = map.layers.base.data!.map((v, i) => i === hill ? 'Mountains' : v === 'Land' || i === centre ? 'Lowland' : null);
  const style = resolveStyle({ preset: 'parchment', overrides: { water: 'flat', grain: false, grid: 'none', land: 'uniform', relief: 'hillshade' } });
  const scene = buildScene(map, { size, visible: { ...defaultVisibility(), elevation: true }, labels: false, style });
  // In the mountain hex beside the isthmus, inside the repainted circle.
  const c = hexCenter(n.col, n.row, size), p = { x: middle.x + (c.x - middle.x) * .7, y: middle.y + (c.y - middle.y) * .7 };
  assert.ok(landTestOf(scene)!(p), 'the point is on land');
  const fills = paintAt(scene.prims, p);
  const lastGround = fills.map(opaque).lastIndexOf(true);
  assert.ok(lastGround >= 0 && fills.slice(lastGround + 1).some(f => !opaque(f)), `shading must lie over the last ground fill: ${fills.join(' ')}`);
});

// A passage with no roughness of its own inherits it as the shore round it does: the map's default
// for a sea strait or isthmus, the lakes' default for a strait in a lake (review of PR #185).
test('a passage without its own roughness draws its banks with the default the shore round it uses', () => {
  const sample = (map: MapState) => {
    const land = draw(map).land, out: boolean[] = [];
    for (let x = middle.x - size * 2; x <= middle.x + size * 2; x += size / 10)
      for (let y = middle.y - size * 2; y <= middle.y + size * 2; y += size / 10) out.push(land({ x, y }));
    return out;
  };
  for (const type of ['Strait', 'Isthmus'] as const) {
    const inherited = passage(type, 'Normal', OPPOSITE);
    inherited.defaultIrregularity = 'Smooth';
    const own = structuredClone(inherited);
    own.hexShapes = { [centre]: { ...own.hexShapes![centre]!, irregular: 'Smooth' } };
    assert.deepEqual(sample(inherited), sample(own), `sea ${type}: the map's Smooth, inherited, is drawn as its own Smooth`);
  }
  const lake = lakeStraitFixture({ width: 'Normal', irregular: 'Smooth' });
  delete lake.hexShapes!['24']!.irregular;
  const own = lakeStraitFixture({ width: 'Normal', irregular: 'Smooth' });
  const lakeLand = (map: MapState) => {
    const scene = buildScene(map, { size, visible: defaultVisibility(), labels: false, style });
    const land = landTestOf(scene)!, c = hexCenter(24 % 7, Math.floor(24 / 7), size), out: boolean[] = [];
    for (let x = c.x - size * 2; x <= c.x + size * 2; x += size / 10) for (let y = c.y - size * 2; y <= c.y + size * 2; y += size / 10) out.push(land({ x, y }));
    return out;
  };
  assert.deepEqual(lakeLand(lake), lakeLand(own), "lake strait: the lakes' Smooth, inherited, is drawn as its own Smooth");
});
