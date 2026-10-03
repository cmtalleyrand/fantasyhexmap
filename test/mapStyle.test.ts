import assert from 'node:assert/strict';
import test from 'node:test';
import { hexCenter, hexEdgePoints, hexIndex, inBounds, neighbourOf } from '../shared/hex.ts';
import { createMapState } from '../shared/layers.ts';
import type { BaseGeo, MapState } from '../shared/types.ts';
import { alike, chainEdges, coastEdges, coastGeometry, coastKey, drawnLand, raggedEdge, sideOf } from '../src/render/coast.ts';
import type { PathCmd, Prim } from '../src/render/prims.ts';
import { riverCourse } from '../src/render/rivers.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import {
  KNOB_OPTIONS,
  PRESETS,
  PRESET_ORDER,
  elevationStyleOf,
  parseStyleChoice,
  resolveStyle,
  withKnob,
} from '../src/render/styles.ts';
import { sceneToSvg } from '../src/render/svg.ts';
import { encodePng } from '../src/render/texture.ts';

/** A 9x7 sea with an irregular island, a one-hex lake in it, glacier along the bottom and an islet. */
function islandMap(): MapState {
  const cols = 9;
  const rows = 7;
  const map = createMapState('Coast test', cols, rows);
  const base: BaseGeo[] = Array(cols * rows).fill('Sea');
  const land = [
    [2, 1], [3, 1], [4, 1], [2, 2], [3, 2], [4, 2], [5, 2], [1, 3], [2, 3], [4, 3], [5, 3],
    [2, 4], [3, 4], [4, 4],
  ];
  for (const [col, row] of land) base[hexIndex(cols, col!, row!)] = 'Land';
  base[hexIndex(cols, 3, 3)] = 'Lake';
  base[hexIndex(cols, 7, 1)] = 'Islands';
  for (let col = 0; col < cols; col++) base[hexIndex(cols, col, rows - 1)] = 'Glacier';
  map.layers.base.data = base;
  map.layers.rivers.data = {
    rivers: [{
      id: 'r', name: 'Wend', terminus: 'Sea',
      segments: [
        { col: 3, row: 2, entryEdge: null, exitEdge: 3, navigable: false },
        { col: 2, row: 2, entryEdge: 0, exitEdge: 2, navigable: true },
        { col: 1, row: 3, entryEdge: 5, exitEdge: 3, navigable: true },
      ],
    }],
  };
  return map;
}

const allLayers = () => {
  const v = defaultVisibility();
  v.rivers = true;
  return v;
};

test('every land/water edge lies on exactly one coast chain, and chains join end to start', () => {
  const map = islandMap();
  const base = map.layers.base.data!;
  const size = 10;
  const edges = coastEdges(base, map.cols, map.rows, size);
  let expected = 0;
  for (let row = 0; row < map.rows; row++) {
    for (let col = 0; col < map.cols; col++) {
      if (sideOf(base[hexIndex(map.cols, col, row)]) !== 'land') continue;
      for (let e = 0; e < 6; e++) {
        const n = neighbourOf(col, row, e);
        if (inBounds(map.cols, map.rows, n.col, n.row) && sideOf(base[hexIndex(map.cols, n.col, n.row)]) === 'water') expected++;
      }
    }
  }
  assert.equal(edges.length, expected);
  const chains = chainEdges(edges);
  assert.equal(chains.reduce((sum, c) => sum + c.edges.length, 0), expected, 'no edge lost or repeated');
  const close = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
  for (const chain of chains) {
    for (let k = 0; k + 1 < chain.edges.length; k++) assert.ok(close(chain.edges[k]!.to, chain.edges[k + 1]!.from));
    if (chain.closed) assert.ok(close(chain.edges.at(-1)!.to, chain.edges[0]!.from));
  }
  // The island's outer shore and the lake's shore close; the glacier shore runs off both map edges.
  assert.equal(chains.filter((c) => c.closed).length, 2);
  assert.equal(chains.filter((c) => !c.closed).length, 1);
});

test('the smoothed coast passes through every coast edge midpoint and stays within an eighth of a hex', () => {
  const map = islandMap();
  const size = 10;
  const geometry = coastGeometry(map.layers.base.data!, map.cols, map.rows, size, true);
  for (const [k, chain] of geometry.chains.entries()) {
    const d = geometry.paths[k]!;
    const ends = d.filter((c) => c[0] === 'Q').map((c) => ({ x: c[3] as number, y: c[4] as number }));
    for (const edge of chain.edges) {
      const m = { x: (edge.from.x + edge.to.x) / 2, y: (edge.from.y + edge.to.y) / 2 };
      const onCurve = ends.some((p) => Math.hypot(p.x - m.x, p.y - m.y) < 1e-6)
        || d.some((c) => c[0] !== 'Z' && Math.hypot((c.at(-2) as number) - m.x, (c.at(-1) as number) - m.y) < 1e-6);
      assert.ok(onCurve, 'curve passes through each edge midpoint');
    }
    // A quadratic segment's furthest point from its control corner is at t = 0.5.
    let start = { x: 0, y: 0 };
    for (const c of d) {
      if (c[0] === 'Q') {
        const [, cx, cy, x, y] = c;
        const midX = 0.25 * start.x + 0.5 * cx + 0.25 * x;
        const midY = 0.25 * start.y + 0.5 * cy + 0.25 * y;
        assert.ok(Math.hypot(midX - cx, midY - cy) <= size / 8 + 1e-6);
      }
      if (c[0] !== 'Z') start = { x: c.at(-2) as number, y: c.at(-1) as number };
    }
  }
  assert.ok(geometry.toWater.length > 0 && geometry.toLand.length > 0, 'both kinds of corner are corrected');
});

test('hex-edge coast follows the hex edges exactly', () => {
  const map = islandMap();
  const size = 10;
  const geometry = coastGeometry(map.layers.base.data!, map.cols, map.rows, size, false);
  assert.equal(geometry.toWater.length + geometry.toLand.length, 0);
  const corners = new Set<string>();
  for (let i = 0; i < map.cols * map.rows; i++) {
    for (let e = 0; e < 6; e++) {
      const [a] = hexEdgePoints(i % map.cols, Math.floor(i / map.cols), e, size);
      corners.add(`${a.x.toFixed(4)},${a.y.toFixed(4)}`);
    }
  }
  for (const d of geometry.paths) {
    for (const c of d) {
      if (c[0] === 'Z') continue;
      assert.ok(corners.has(`${(c[1] as number).toFixed(4)},${(c[2] as number).toFixed(4)}`), 'every vertex is a hex corner');
    }
  }
});

test('stored style choices are validated knob by knob', () => {
  assert.deepEqual(parseStyleChoice(null), { preset: 'classic', overrides: {} });
  assert.deepEqual(parseStyleChoice({ preset: 'nonsense' }), { preset: 'classic', overrides: {} });
  assert.deepEqual(
    parseStyleChoice({ preset: 'parchment', overrides: { grid: 'all', water: 'lava', grain: 'yes', rivers: 'classic' } }),
    { preset: 'parchment', overrides: { grid: 'all', rivers: 'classic' } },
  );
  const parchment = resolveStyle({ preset: 'parchment', overrides: { grid: 'all' } });
  assert.equal(parchment.knobs.grid, 'all');
  assert.equal(parchment.knobs.coast, 'smooth', 'unchanged knobs come from the preset');
  // Choosing the preset's own value removes the override rather than storing it.
  const back = withKnob({ preset: 'parchment', overrides: { grid: 'all' } }, 'grid', 'land');
  assert.deepEqual(back.overrides, {});
});

test('a saved "all land one colour" setting survives as a style override', async () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as { window?: unknown }).window = { localStorage: storage, sessionStorage: storage };
  try {
    const { loadPrefs } = await import('../src/api/settings.ts');
    store.set('fantasyhexmap.prefs', JSON.stringify({ uniformLand: true, defaultsVersion: 3 }));
    const migrated = loadPrefs();
    assert.deepEqual(migrated.mapStyle, { preset: 'classic', overrides: { land: 'uniform' } });
    assert.equal('uniformLand' in migrated, false);
    store.set('fantasyhexmap.prefs', JSON.stringify({ uniformLand: false, defaultsVersion: 3 }));
    assert.deepEqual(loadPrefs().mapStyle, { preset: 'classic', overrides: {} });
    store.set('fantasyhexmap.prefs', JSON.stringify({ mapStyle: { preset: 'parchment', overrides: {} } }));
    assert.equal(loadPrefs().mapStyle.preset, 'parchment');
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test('the classic style without overrides draws exactly what the default scene draws', () => {
  const map = islandMap();
  const plain = buildScene(map, { size: 20, visible: allLayers(), labels: true });
  const classic = buildScene(map, { size: 20, visible: allLayers(), labels: true, style: resolveStyle({ preset: 'classic', overrides: {} }) });
  assert.deepEqual(classic, plain);
  // The background is the sea, so the ragged half-hex edges read as sea.
  assert.equal(plain.background, '#1d3b57');
});

test('every preset builds a deterministic scene and a well-formed SVG', () => {
  for (const preset of PRESET_ORDER) {
    const style = resolveStyle({ preset, overrides: {} });
    // Decoration is seeded by the map's id, so determinism is per map.
    const mapA = islandMap();
    const once = buildScene(mapA, { size: 20, visible: allLayers(), labels: true, riverNames: true, style });
    const twice = buildScene(mapA, { size: 20, visible: allLayers(), labels: true, riverNames: true, style });
    assert.deepEqual(once, twice, `${preset}: same map, same picture`);
    const svg = sceneToSvg(once, preset);
    assert.ok(svg.startsWith('<?xml'));
    const opened = (svg.match(/<g\b/g) ?? []).length;
    const closed = (svg.match(/<\/g>/g) ?? []).length;
    assert.equal(opened, closed, `${preset}: groups balance`);
    for (const ref of svg.match(/url\(#([^)]+)\)/g) ?? []) {
      const id = ref.slice(5, -1);
      assert.ok(svg.includes(`id="${id}"`), `${preset}: ${id} is defined`);
    }
  }
});

test('the parchment draft turns on every phase-one treatment', () => {
  const map = islandMap();
  const style = resolveStyle({ preset: 'parchment', overrides: {} });
  const prims = buildScene(map, { size: 20, visible: allLayers(), labels: false, style }).prims;
  const kinds = (list: Prim[]): string[] => list.flatMap((p) => (p.kind === 'group' ? ['group', ...kinds(p.prims)] : [p.kind]));
  const all = kinds(prims);
  assert.ok(all.includes('group'), 'ripples are clipped to the water');
  assert.ok(all.includes('texture'), 'paper grain');
  assert.ok(!prims.some((p) => p.kind === 'circle'), 'islets replace island dots');
  assert.ok(!prims.some((p) => p.kind === 'polyline' && p.smooth), 'the river is a filled outline, not a stroke');
  // The grid is land-only: no grid edge touches a sea hex centre's surroundings far from land.
  const grid = prims.find((p): p is Extract<Prim, { kind: 'path' }> => p.kind === 'path' && p.stroke === style.palette.grid);
  assert.ok(grid);
});

test('editing one hex leaves the decoration of distant hexes unchanged', () => {
  const map = islandMap();
  const style = resolveStyle({ preset: 'parchment', overrides: { water: 'flat' } });
  const before = buildScene(map, { size: 20, visible: defaultVisibility(), labels: false, style });
  const edited = structuredClone(map);
  edited.layers.base.data![hexIndex(map.cols, 0, 0)] = 'Islands';
  const after = buildScene(edited, { size: 20, visible: defaultVisibility(), labels: false, style });
  const islet = (scene: typeof before, c: { x: number; y: number }) =>
    scene.prims.filter((p) => p.kind === 'path' && p.fill === style.palette.island)
      .map((p) => JSON.stringify((p as { d: PathCmd[] }).d))
      .filter((d) => {
        const first = JSON.parse(d)[0] as [string, number, number];
        return Math.hypot(first[1] - c.x, first[2] - c.y) < 20;
      });
  // The existing islet at (7, 1) keeps its exact outline.
  const centre = { x: 20 * Math.sqrt(3) * 7.5 + 20 * Math.sqrt(3) / 2, y: 20 * 1.5 + 20 };
  assert.deepEqual(islet(after, centre), islet(before, centre));
});

test('a tapered river widens downstream, flares at its mouth and keeps to its hexes', () => {
  const map = islandMap();
  const size = 20;
  const course = riverCourse(map.layers.rivers.data!.rivers[0]!, size, map.id)!;
  assert.ok(course);
  const { widths } = course;
  assert.ok(widths[0]! < widths[Math.floor(widths.length / 2)]!, 'narrow at the source');
  assert.ok(widths.at(-1)! > widths.at(-8)!, 'flared at the mouth');
  assert.ok(Math.max(...widths) <= size * 0.3 * 1.9 + 1e-9);
});

test('a tapered river is slender, eases into navigable water and starts as a thread', () => {
  const size = 20;
  const segs = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((col) => ({ col, row: 2, entryEdge: col === 0 ? null : 3, exitEdge: 0, navigable: col >= 5 }));
  const river = { id: 'e', name: 'Ease', terminus: 'OffMap' as const, segments: segs };
  const { widths } = riverCourse(river, size, 'seed')!;
  let jump = 0;
  for (let i = 1; i < widths.length; i++) jump = Math.max(jump, Math.abs(widths[i]! - widths[i - 1]!));
  assert.ok(jump < size * 0.01, `width changes by ${jump.toFixed(3)} between samples`);
  assert.ok(Math.max(...widths) <= size * 0.17 + 1e-9, 'no wider than a fifth of a hex or so');
  assert.ok(widths[0]! < widths[Math.round(4 * 8 / 2)]! * 0.5, 'a thread at its spring');
});

test('a tapered river wanders the same way every time, and a different way for another seed', () => {
  const size = 20;
  const segs = [0, 1, 2, 3, 4, 5].map((col) => ({ col, row: 2, entryEdge: col === 0 ? null : 3, exitEdge: 0, navigable: false }));
  const river = { id: 'w', name: 'Wander', terminus: 'OffMap' as const, segments: segs };
  const a = riverCourse(river, size, 'one')!.centreline;
  const b = riverCourse(river, size, 'one')!.centreline;
  const c = riverCourse(river, size, 'two')!.centreline;
  assert.deepEqual(a, b);
  assert.ok(a.some((p, i) => Math.hypot(p.x - c[i]!.x, p.y - c[i]!.y) > 0.5));
});

test('a river leaving a lake has an open bank at its start, and a spring has a closed one', async () => {
  const size = 20;
  const segs = [0, 1, 2, 3].map((col) => ({ col, row: 2, entryEdge: col === 0 ? null : 3, exitEdge: 0, navigable: false }));
  const river = { id: 'b', name: 'Bank', terminus: 'OffMap' as const, segments: segs };
  assert.equal(riverCourse(river, size, 'seed')!.bank.length, 1);
  assert.equal(riverCourse(river, size, 'seed', { before: { x: 0, y: 2 * 30 + 20 }, inWater: () => false })!.bank.length, 2);
});

test('a wider river carries a slightly larger name', async () => {
  const { placeRiverLabels } = await import('../src/render/featureLabels.ts');
  const size = 20;
  const rivers = [1, 2].map((k) => ({
    id: `r${k}`, name: `Name${k}`, terminus: 'OffMap' as const,
    segments: [0, 1, 2, 3, 4, 5, 6, 7].map((col) => ({ col, row: k * 2, entryEdge: col === 0 ? null : 3, exitEdge: 0, navigable: false })),
  }));
  const labels = placeRiverLabels(rivers, size, undefined, undefined, [], (id) => (id === 'r2' ? size * 0.17 : size * 0.03));
  assert.equal(labels.length, 2);
  const ratio = labels[1]!.size / labels[0]!.size;
  assert.ok(ratio > 1.05 && ratio < 1.12, `ratio ${ratio.toFixed(3)}`);
});

test('a meandering river never folds back on itself, even through tight bends', async () => {
  const { neighbourOf: nb } = await import('../shared/hex.ts');
  let state = 12345;
  const rnd = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
  let sharp = 0;
  const runs = 400;
  for (let n = 0; n < runs; n++) {
    const len = 3 + Math.floor(rnd() * 5);
    const segs: Array<{ col: number; row: number; entryEdge: number | null; exitEdge: number | null; navigable: boolean }> = [];
    let at = { col: 5, row: 5 };
    let prev: number | null = null;
    for (let k = 0; k < len; k++) {
      let d = Math.floor(rnd() * 6);
      if (prev !== null && d === (prev + 3) % 6) d = (d + 1) % 6;
      segs.push({ col: at.col, row: at.row, entryEdge: prev === null ? null : (prev + 3) % 6, exitEdge: k === len - 1 ? null : d, navigable: false });
      at = nb(at.col, at.row, d);
      prev = d;
    }
    const line = riverCourse({ id: 'f', name: 'f', terminus: 'Unresolved', segments: segs }, 40, `s${n}`, { wander: 'gentle' })!.centreline;
    for (let i = 2; i < line.length; i++) {
      const [a, b, c] = [line[i - 2]!, line[i - 1]!, line[i]!];
      let t = Math.abs(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x));
      if (t > Math.PI) t = 2 * Math.PI - t;
      assert.ok(t < (2 * Math.PI) / 3, `run ${n} turns ${(t * 180 / Math.PI).toFixed(0)} degrees at sample ${i}`);
      if (t > Math.PI / 4) sharp++;
    }
  }
  assert.ok(sharp < runs * 0.2, `${sharp} sharp turns in ${runs} rivers`);
});

test('a river that rises at a city comes out from under its icon, and one that runs out at a city stops under it', () => {
  const size = 40;
  const segs = [0, 1, 2, 3, 4, 5].map((col) => ({ col, row: 2, entryEdge: col === 0 ? null : 3, exitEdge: col === 5 ? null : 0, navigable: false }));
  const river = { id: 'c', name: 'City', terminus: 'Unresolved' as const, segments: segs };
  const centre = (col: number) => ({ x: size * Math.sqrt(3) * col + (size * Math.sqrt(3)) / 2, y: 2 * 1.5 * size + size });
  const bare = riverCourse(river, size, 'seed')!;
  const cities = [{ at: centre(0), radius: 8 }, { at: centre(5), radius: 8 }];
  const withCities = riverCourse(river, size, 'seed', { cities })!;
  const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(near(withCities.centreline[0]!, centre(0)) < 8 * 1.2, 'starts under the icon');
  assert.ok(near(withCities.centreline.at(-1)!, centre(5)) < 8 * 1.2, 'ends under the icon');
  assert.ok(withCities.widths[0]! > bare.widths[0]! * 2, 'full width where it leaves the icon');
});

test('a river name goes on the slimmer stretch of a river that widens', async () => {
  const { placeRiverLabels } = await import('../src/render/featureLabels.ts');
  const size = 40;
  const river = {
    id: 'w', name: 'Widening', terminus: 'OffMap' as const,
    segments: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((col) => ({ col, row: 2, entryEdge: col === 0 ? null : 3, exitEdge: 0, navigable: false })),
  };
  const line = riverCourse(river, size, 'seed')!.centreline;
  // Wide at the downstream end, slim at the head.
  const profile = line.map((_, i) => 2 + (12 * i) / line.length);
  const label = placeRiverLabels([river], size, () => line, undefined, [], undefined, undefined, () => profile)[0]!;
  const mid = label.glyphs![Math.floor(label.glyphs!.length / 2)]!;
  assert.ok(mid.x < line[Math.floor(line.length / 2)]!.x, 'set in the upstream half');
});

test('river names keep off lakes, city markers, other rivers and each other', async () => {
  const { placeRiverLabels } = await import('../src/render/featureLabels.ts');
  const size = 40;
  const mk = (id: string, row: number) => ({
    id, name: `River${id}`, terminus: 'OffMap' as const,
    segments: [0, 1, 2, 3, 4, 5, 6].map((col) => ({ col, row, entryEdge: col === 0 ? null : 3, exitEdge: 0, navigable: false })),
  });
  const rivers = [mk('a', 2), mk('b', 3)];
  // Two rivers a hex apart: their names must not sit on one another.
  const plain = placeRiverLabels(rivers, size);
  const boxes = (l: (typeof plain)[number]) => (l.glyphs ?? []).map((g) => ({ x: g.x, y: g.y }));
  const clash = boxes(plain[0]!).some((p) => boxes(plain[1]!).some((q) => Math.hypot(p.x - q.x, p.y - q.y) < size * 0.3));
  assert.ok(!clash, 'two names do not overlap');
  // A lake over the middle of the first river: its name moves clear.
  const middle = plain[0]!.glyphs![Math.floor(plain[0]!.glyphs!.length / 2)]!;
  const lake = (p: { x: number; y: number }) => Math.hypot(p.x - middle.x, p.y - middle.y) < size * 0.6;
  const moved = placeRiverLabels(rivers, size, undefined, undefined, [], undefined, lake);
  assert.ok(moved[0]!.glyphs!.every((g) => !lake(g)), 'no letter of the name is set over the lake');
  // A city marker over the middle of the first river's name: likewise.
  const marker = { cx: middle.x, cy: middle.y, halfW: size * 0.5, halfH: size * 0.5, rotation: 0 };
  const dodged = placeRiverLabels(rivers, size, undefined, undefined, [marker]);
  assert.ok(dodged[0]!.glyphs!.every((g) => Math.hypot(g.x - middle.x, g.y - middle.y) > size * 0.4), 'the name keeps off the marker');
});

test('a tributary joins its host at an acute angle, leaning downstream, rather than square on', async () => {
  const { riverCourses } = await import('../src/render/rivers.ts');
  const size = 40;
  const main = { id: 'main', name: 'Main', terminus: 'OffMap' as const, segments: [0, 1, 2, 3, 4, 5, 6].map((col) => ({ col, row: 4, entryEdge: col === 0 ? null : 3, exitEdge: 0, navigable: true })) };
  const trib = {
    id: 'n', name: 'N', terminus: 'River' as const, joins: 'main',
    segments: [
      { col: 3, row: 0, entryEdge: null, exitEdge: 1, navigable: false },
      { col: 3, row: 1, entryEdge: 4, exitEdge: 2, navigable: false },
      { col: 3, row: 2, entryEdge: 5, exitEdge: 1, navigable: false },
      { col: 3, row: 3, entryEdge: 4, exitEdge: 2, navigable: false },
      { col: 3, row: 4, entryEdge: 5, exitEdge: null, navigable: false },
    ],
  };
  const courses = riverCourses([main, trib], size, 'seed');
  const t = courses.get('n')!.centreline;
  const h = courses.get('main')!.centreline;
  const end = t.at(-1)!;
  const i = h.findIndex((q) => Math.hypot(q.x - end.x, q.y - end.y) < 1e-9);
  assert.ok(i >= 2 && i < h.length - 2);
  const host = Math.atan2(h[i + 2]!.y - h[i - 2]!.y, h[i + 2]!.x - h[i - 2]!.x);
  const own = Math.atan2(end.y - t.at(-4)!.y, end.x - t.at(-4)!.x);
  let angle = Math.abs(host - own);
  if (angle > Math.PI) angle = 2 * Math.PI - angle;
  assert.ok(angle < Math.PI / 3, `joins at ${(angle * 180 / Math.PI).toFixed(0)} degrees`);
});

test('the PNG encoder writes a valid signature and chunk layout', () => {
  const png = encodePng(2, 2, new Uint8ClampedArray(16).fill(200));
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const text = String.fromCharCode(...png);
  assert.ok(text.includes('IHDR') && text.includes('IDAT') && text.endsWith('IEND' + text.slice(-4)));
});

test('a one-hex lake is drawn as an irregular body, not traced from its hex edges', () => {
  const map = islandMap();
  const style = resolveStyle({ preset: 'parchment', overrides: {} });
  const prims = buildScene(map, { size: 20, visible: defaultVisibility(), labels: false, style }).prims;
  const lakeHexes = prims.filter((p) => p.kind === 'polygon' && p.fill === style.palette.lake);
  assert.equal(lakeHexes.length, 0, 'the lake hex is drawn as land under the body');
  const bodies = prims.filter((p) => p.kind === 'path' && p.fill === style.palette.lake);
  assert.equal(bodies.length, 1);
  // The body is irregular, and reaches past its own hex's edges into the neighbours.
  const d = (bodies[0] as { d: PathCmd[] }).d.filter((c) => c[0] === 'M' || c[0] === 'L');
  const centre = { x: 20 * Math.sqrt(3) * 3.5 + 20 * Math.sqrt(3) / 2, y: 20 * 1.5 * 3 + 20 };
  const radii = d.map((c) => Math.hypot((c[1] as number) - centre.x, (c[2] as number) - centre.y));
  assert.ok(Math.max(...radii) - Math.min(...radii) > 1, 'not a circle');
  assert.ok(Math.max(...radii) > 20 * (Math.sqrt(3) / 2), 'reaches into a neighbouring hex');
  assert.ok(Math.max(...radii) < 20 * 1.6, 'but only a little way');
});

test('a crossing point is the same seen from either side of its edge', async () => {
  const { edgeCrossing } = await import('../src/render/rivers.ts');
  const { neighbourOf: nb, oppositeEdge } = await import('../shared/hex.ts');
  for (const [col, row] of [[2, 2], [3, 3], [4, 1]]) {
    for (let e = 0; e < 6; e++) {
      const n = nb(col!, row!, e);
      const a = edgeCrossing(col!, row!, e, 20, 'seed');
      const b = edgeCrossing(n.col, n.row, oppositeEdge(e), 20, 'seed');
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-9);
    }
  }
});

test('a tapered river stays in its own hexes and never turns sharply between samples', async () => {
  const { pixelToOffset } = await import('../shared/hex.ts');
  const size = 20;
  const cols = 10;
  const rows = 8;
  const map = createMapState('River shape', cols, rows);
  // A winding river with 60-degree turns, the case that used to hook back.
  const { neighbourOf: nb } = await import('../shared/hex.ts');
  const dirs = [0, 1, 0, 1, 2, 1, 0, 0, 5, 0];
  const segs: Array<{ col: number; row: number; entryEdge: number | null; exitEdge: number | null; navigable: boolean }> = [];
  let at = { col: 1, row: 1 };
  dirs.forEach((d, k) => {
    segs.push({ col: at.col, row: at.row, entryEdge: k === 0 ? null : (dirs[k - 1]! + 3) % 6, exitEdge: d, navigable: k > 4 });
    at = nb(at.col, at.row, d);
  });
  const river = { id: 'w', name: 'Wend', terminus: 'OffMap' as const, segments: segs };
  // At the smoother levels; the sharper ones trade this for deeper bends (see the levels test).
  const course = riverCourse(river, size, map.id, { wander: 'gentle' })!;
  const hexes = new Set(segs.map((s) => `${s.col},${s.row}`));
  for (const p of course.centreline) {
    const { col, row } = pixelToOffset(p.x, p.y, size);
    // A sample exactly on an edge may round either way.
    const near = [0, 1, 2, 3, 4, 5].some((k) => {
      const q = pixelToOffset(p.x + Math.cos(k) * size * 0.04, p.y + Math.sin(k) * size * 0.04, size);
      return hexes.has(`${q.col},${q.row}`);
    });
    assert.ok(hexes.has(`${col},${row}`) || near, `sample at ${p.x.toFixed(1)},${p.y.toFixed(1)} left the river's hexes`);
  }
  let maxTurn = 0;
  for (let i = 2; i < course.centreline.length; i++) {
    const [a, b, c] = [course.centreline[i - 2]!, course.centreline[i - 1]!, course.centreline[i]!];
    const t1 = Math.atan2(b.y - a.y, b.x - a.x);
    const t2 = Math.atan2(c.y - b.y, c.x - b.x);
    let d = Math.abs(t2 - t1);
    if (d > Math.PI) d = 2 * Math.PI - d;
    maxTurn = Math.max(maxTurn, d);
  }
  assert.ok(maxTurn < Math.PI / 4, `largest turn between samples was ${(maxTurn * 180 / Math.PI).toFixed(0)} degrees`);
});

test('a tributary ends on its parent river and a distributary starts on it', async () => {
  const { riverCourses } = await import('../src/render/rivers.ts');
  const size = 20;
  const main = {
    id: 'main', name: 'Main', terminus: 'OffMap' as const,
    segments: [0, 1, 2, 3, 4].map((col) => ({ col, row: 2, entryEdge: col === 0 ? null : 3, exitEdge: 0, navigable: true })),
  };
  const trib = {
    id: 'trib', name: 'Trib', terminus: 'Unresolved' as const,
    segments: [
      { col: 2, row: 0, entryEdge: null, exitEdge: 1, navigable: false },
      { col: 2, row: 1, entryEdge: 4, exitEdge: 2, navigable: false },
      { col: 2, row: 2, entryEdge: 5, exitEdge: null, navigable: false },
    ],
  };
  const branch = {
    id: 'branch', name: 'Branch', terminus: 'OffMap' as const, branchOf: 'main',
    segments: [
      { col: 3, row: 2, entryEdge: null, exitEdge: 1, navigable: true },
      { col: 3, row: 3, entryEdge: 4, exitEdge: 1, navigable: true },
    ],
  };
  // Listed tributary first, so the layout has to wait for its host.
  const courses = riverCourses([trib, branch, main], size, 'seed');
  const line = courses.get('main')!.centreline;
  const onLine = (p: { x: number; y: number }) => line.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 1e-9);
  assert.ok(onLine(courses.get('trib')!.centreline.at(-1)!), 'the tributary meets the main river');
  assert.ok(onLine(courses.get('branch')!.centreline[0]!), 'the distributary leaves the main river');
});

test('the new base types round-trip through the codec, and old island types migrate to Islands', async () => {
  const { encodeBase, decodeBase } = await import('../shared/codec.ts');
  const { isLandLike, isWater } = await import('../shared/derive.ts');
  const { migrateLegacyIslands } = await import('../shared/islandMigration.ts');
  const values: BaseGeo[] = ['Islands', 'Mainland and islands', 'Isthmus', 'Strait'];
  assert.deepEqual(decodeBase(encodeBase(values, 4, 1), 4, 1).data, values);
  for (const v of ['Islands', 'Mainland and islands', 'Isthmus'] as BaseGeo[]) assert.ok(isLandLike(v), `${v} carries land layers`);
  assert.ok(isWater('Strait') && !isLandLike('Strait'));
  // The retired codec characters still read, as Islands.
  assert.deepEqual(decodeBase(['ab'], 2, 1).data, ['Islands', 'Islands']);
  // A saved map with the four old types, one with a stored side.
  const map = createMapState('Old', 4, 1);
  map.layers.base.data = ['Island', 'Coastal Island', 'Large Island', 'Small Islands'] as unknown as BaseGeo[];
  map.islandSides = { '1': 4 };
  const migrated = migrateLegacyIslands(map);
  assert.deepEqual(migrated.layers.base.data, ['Islands', 'Islands', 'Islands', 'Islands']);
  assert.deepEqual(migrated.islandSpecs, {
    '0': { large: 0, small: 1 },
    '1': { large: 1, small: 0, coastal: { large: true }, side: 4 },
    '2': { large: 1, small: 0 },
    '3': { large: 0, small: 3 },
  });
  assert.equal(migrated.islandSides, undefined);
  assert.equal(migrateLegacyIslands(migrated), migrated, 'a current map is left alone');
});

test('an Islands hex draws the islands its spec asks for, inside its hex, coastal ones toward land', async () => {
  const { hexCenter, pixelToOffset } = await import('../shared/hex.ts');
  const size = 20;
  const specs = [
    { large: 1, small: 0 },
    { large: 2, small: 0 },
    { large: 0, small: 5 },
    { large: 1, small: 3 },
    { large: 2, small: 2, coastal: { large: true } },
    { large: 0, small: 4, coastal: { small: true } },
  ];
  for (const spec of specs) {
    const map = createMapState('Islands', 3, 3);
    // Ragged islands shed skerries, which are shapes of their own; Wavy ones do not.
    map.defaultIrregularity = 'Wavy';
    map.layers.base.data = ['Land', 'Sea', 'Sea', 'Land', 'Islands', 'Sea', 'Sea', 'Sea', 'Sea'];
    map.islandSpecs = { '4': spec };
    for (const preset of PRESET_ORDER) {
      const style = resolveStyle({ preset, overrides: {} });
      const prims = buildScene(map, { size, visible: defaultVisibility(), labels: false, style }).prims;
      const land = prims.filter((p): p is Extract<Prim, { kind: 'path' }> => p.kind === 'path' && p.fill === style.palette.island);
      assert.equal(land.length, 1, `${JSON.stringify(spec)} (${preset}) draws its islands as one shape`);
      const subpaths = land[0]!.d.filter((c) => c[0] === 'M').length;
      assert.equal(subpaths, spec.large + spec.small, `${JSON.stringify(spec)} (${preset}) island count`);
      const pts = land[0]!.d.filter((c) => c[0] !== 'Z').map((c) => ({ x: c.at(-2) as number, y: c.at(-1) as number }));
      for (const q of pts) {
        const { col, row } = pixelToOffset(q.x, q.y, size);
        assert.deepEqual([col, row], [1, 1], `${JSON.stringify(spec)} (${preset}) stays in its hex`);
      }
      if (spec.coastal) {
        // The land lies west; a coastal group's islands sit on the west side of the hex.
        // Each island counts by the area of its bounding box, as the land it draws.
        const c = hexCenter(1, 1, size);
        const islands: Array<{ area: number; x: number }> = [];
        let current: typeof pts = [];
        for (const cmd of land[0]!.d) {
          if (cmd[0] === 'M') current = [];
          if (cmd[0] !== 'Z') current.push({ x: cmd.at(-2) as number, y: cmd.at(-1) as number });
          else {
            const xs = current.map((q) => q.x);
            const ys = current.map((q) => q.y);
            islands.push({ area: (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)), x: (Math.max(...xs) + Math.min(...xs)) / 2 });
          }
        }
        // The group is the large islands (the largest drawn) or the small ones (the rest); the other group lies where it likes.
        const bySize = [...islands].sort((a, b) => b.area - a.area);
        const group = spec.coastal.large ? bySize.slice(0, spec.large) : bySize.slice(spec.large);
        const weight = group.reduce((sum, isle) => sum + isle.area, 0);
        const moment = group.reduce((sum, isle) => sum + isle.area * isle.x, 0);
        assert.ok(moment / weight < c.x, `${JSON.stringify(spec)} (${preset}) lies toward the land`);
      }
    }
  }
});

test('an isthmus is a neck of land, a strait a channel of water, and a mainland coast keeps its islands offshore', async () => {
  const { surfaceMap, surfaceEdges, CORE } = await import('../src/render/coast.ts');
  const { hexCenter } = await import('../shared/hex.ts');
  const size = 20;
  // West-east: land, the split hex, land (or sea), with sea (or land) north and south.
  const row = (top: BaseGeo, middle: BaseGeo[], bottom: BaseGeo): BaseGeo[] => [top, top, top, ...middle, bottom, bottom, bottom];
  const isthmus = surfaceMap(row('Sea', ['Land', 'Isthmus', 'Land'], 'Sea'), 3, 3);
  const neck = isthmus.split.get(4)!;
  assert.ok(neck.sides.slice(0, 6).every((s) => s === 'land'), 'the centre of an isthmus is land');
  assert.equal(neck.sides[6], 'land', 'it reaches the land to the east');
  assert.equal(neck.sides[9], 'land', 'and to the west');
  assert.ok(neck.sides.slice(6).filter((s) => s === 'sea').length >= 2, 'with sea on its other sides');
  // The coast runs through the hex, within the inner corners' reach of its centre.
  const c = hexCenter(1, 1, size);
  const inner = surfaceEdges(isthmus, size, (s) => s === 'land').filter((e) => Math.hypot(e.from.x - c.x, e.from.y - c.y) < size * CORE + 1e-6);
  assert.ok(inner.length > 0, 'the coast passes inside the isthmus hex');

  const strait = surfaceMap(row('Land', ['Sea', 'Strait', 'Sea'], 'Land'), 3, 3);
  const channel = strait.split.get(4)!;
  assert.ok(channel.sides.slice(0, 6).every((s) => s === 'sea'), 'the centre of a strait is water');
  assert.equal(channel.sides[6], 'sea');
  assert.equal(channel.sides[9], 'sea');
  // Banks take the colours of the land they face.
  channel.sides.forEach((side, p) => {
    if (side === 'land') assert.notEqual(channel.donors[p], 4, 'a bank borrows its neighbour');
  });

  // A mainland coast with islands: land to the west, sea elsewhere.
  const map = createMapState('Coast', 3, 3);
  map.defaultIrregularity = 'Wavy';
  map.layers.base.data = ['Sea', 'Sea', 'Sea', 'Land', 'Mainland and islands', 'Sea', 'Sea', 'Sea', 'Sea'];
  map.islandSpecs = { '4': { large: 1, small: 2 } };
  const style = resolveStyle({ preset: 'parchment', overrides: {} });
  const prims = buildScene(map, { size, visible: defaultVisibility(), labels: false, style }).prims;
  // The islands are one unstroked shape; land a hex has grown over the water is stroked, in the same colour.
  const isles = prims.filter((p): p is Extract<Prim, { kind: 'path' }> => p.kind === 'path' && p.fill === style.palette.island && p.stroke === undefined);
  const pts = isles[0]!.d.filter((q) => q[0] === 'M').map((q) => ({ x: q[1] as number, y: q[2] as number }));
  assert.equal(pts.length, 3);
  for (const q of pts) assert.ok(q.x > c.x - size * 0.2, 'the islands lie off the mainland, in the water');
});

test('a city is drawn at its site: centre, river, or toward its chosen coast', async () => {
  const { citySite, resolvedSite } = await import('../src/render/sites.ts');
  const { hexCenter } = await import('../shared/hex.ts');
  const size = 20;
  const base: BaseGeo[] = Array(9).fill('Land');
  const city = {
    id: 'c', col: 1, row: 1, name: 'Port', population: 20_000,
    onRiver: true, riverId: 'r', coastal: true, coastalEdges: [0, 1],
  };
  const centre = hexCenter(1, 1, size);
  const line = [{ x: centre.x - 30, y: centre.y + 6 }, { x: centre.x, y: centre.y + 6 }, { x: centre.x + 30, y: centre.y + 6 }];
  const ctx = { size, base, cols: 3, riverLine: () => line };
  assert.deepEqual(citySite({ ...city, site: 'inland' }, ctx), centre);
  assert.deepEqual(citySite({ ...city, site: 'river' }, ctx), line[1]);
  assert.deepEqual(citySite(city, ctx), line[1], 'auto prefers the river');
  const east = citySite({ ...city, site: { coast: 0 } }, ctx);
  assert.ok(east.x > centre.x + size * 0.5 && Math.abs(east.y - centre.y) < 1e-9, 'toward the east edge');
  assert.equal(resolvedSite({ ...city, site: { coast: 3 } }).kind, 'coast', 'an edge that is not coastal falls back to the coast');
  assert.equal(resolvedSite({ ...city, onRiver: false, coastalEdges: [], site: 'river' }).kind, 'inland');
});

test('changing where a city is drawn marks nothing stale', async () => {
  const { reducer } = await import('../src/state/store.ts');
  const map = createMapState('Sites', 3, 1);
  map.layers.base.data = ['Land', 'Land', 'Sea'];
  const city = { id: 'c', col: 1, row: 0, name: 'Port', population: 5_000, onRiver: false, riverId: null, coastal: true, coastalEdges: [0] };
  const added = reducer(map, { type: 'upsertCity', city });
  const moved = reducer(added, { type: 'upsertCity', city: { ...added.layers.cities.data!.cities[0]!, site: { coast: 0 } } });
  assert.equal(moved.layers.cities.version, added.layers.cities.version);
  assert.deepEqual(moved.layers.cities.data!.cities[0]!.site, { coast: 0 });
  const undone = reducer(moved, { type: 'undo', layer: 'cities' });
  assert.equal(undone.layers.cities.data!.cities[0]!.site, undefined);
});

test('city names take free slots around their markers and never overlap each other when room exists', async () => {
  const { placeCityNames } = await import('../src/render/labels.ts');
  const cities = [
    { id: 'a', name: 'Alderholt', at: { x: 100, y: 100 }, r: 6, population: 50_000 },
    { id: 'b', name: 'Brackwater', at: { x: 135, y: 100 }, r: 6, population: 20_000 },
    { id: 'c', name: 'Cray', at: { x: 100, y: 125 }, r: 4, population: 5_000 },
  ];
  const realm = { cx: 160, cy: 70, halfW: 40, halfH: 10, rotation: 0 };
  const out = placeCityNames(cities, 10, (t) => t.length * 6, [realm], { width: 400, height: 400 });
  const box = (p: typeof out[number]) => {
    const w = cities.find((c) => c.id === p.id)!.name.length * 6;
    const left = p.anchor === 'start' ? p.at.x : p.anchor === 'end' ? p.at.x - w : p.at.x - w / 2;
    return { left, right: left + w, top: p.at.y - 5, bottom: p.at.y + 5 };
  };
  const boxes = out.map(box);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [p, q] = [boxes[i]!, boxes[j]!];
      assert.ok(p.right <= q.left || q.right <= p.left || p.bottom <= q.top || q.bottom <= p.top, 'names overlap');
    }
    const p = boxes[i]!;
    const r = { left: realm.cx - realm.halfW, right: realm.cx + realm.halfW, top: realm.cy - realm.halfH, bottom: realm.cy + realm.halfH };
    assert.ok(p.right <= r.left || r.right <= p.left || p.bottom <= r.top || r.bottom <= p.top, 'a city name covers the realm name');
  }
  assert.ok(out.every((p) => !p.crowded));
});

test('river names are set glyph by glyph along the river, larger than before', () => {
  const map = islandMap();
  const style = resolveStyle({ preset: 'parchment', overrides: {} });
  const prims = buildScene(map, { size: 32, visible: allLayers(), labels: false, riverNames: true, style }).prims;
  const name = prims.find((p): p is Extract<Prim, { kind: 'text' }> => p.kind === 'text' && p.text === 'Wend');
  assert.ok(name?.glyphs, 'the name is a glyph run');
  assert.equal(name.glyphs.map((g) => g.ch).join(''), 'Wend');
  assert.ok(name.size >= 32 * 0.3);
});

test('seas are named, renamed and removed, and their names are drawn when asked for', async () => {
  const { reducer } = await import('../src/state/store.ts');
  const { prepareLoadedMap } = await import('../src/state/import.ts');
  let map = islandMap();
  const sea = [0, 1, 2, 9, 10, 18, 27, 36];
  map = reducer(map, { type: 'nameGeo', id: 'w1', kind: 'sea', name: 'The Narrows', indices: [...sea, 20] });
  assert.deepEqual(map.geoNames?.[0]?.hexes, sea, 'land hexes are left out');
  map = reducer(map, { type: 'renameGeo', id: 'w1', name: 'The Sound' });
  assert.equal(map.geoNames?.[0]?.name, 'The Sound');
  const style = resolveStyle({ preset: 'parchment', overrides: {} });
  const text = (seaNames: boolean) =>
    buildScene(map, { size: 20, visible: defaultVisibility(), labels: false, seaNames, style }).prims
      .flatMap((p) => (p.kind === 'text' ? [p.text] : []));
  assert.deepEqual(text(false), []);
  assert.deepEqual(text(true), ['THE SOUND']);
  map = reducer(map, { type: 'removeGeo', id: 'w1' });
  assert.deepEqual(map.geoNames, []);
  const old = structuredClone(map);
  delete old.geoNames;
  assert.deepEqual(prepareLoadedMap(old).geoNames, []);
  const legacy = structuredClone(map);
  delete legacy.geoNames;
  legacy.waterNames = [{ id: 'w', name: 'Old Sea', hexes: sea }, { id: 'l', name: 'Old Lake', hexes: [30] }];
  const loaded = prepareLoadedMap(legacy);
  assert.deepEqual(loaded.geoNames?.map((n) => n.kind), ['sea', 'lake']);
  assert.equal(loaded.waterNames, undefined);
});

test('polity parents that name nothing, name themselves or close a loop are dropped', async () => {
  const { withValidParents, topLevelOf } = await import('../shared/polityTree.ts');
  const base = { colour: '#336699' };
  const { polities, dropped } = withValidParents([
    { id: 'k', name: 'Kingdom', ...base },
    { id: 'd', name: 'Duchy', parentId: 'k', ...base },
    { id: 'c', name: 'County', parentId: 'd', ...base },
    { id: 'x', name: 'Ghost', parentId: 'nobody', ...base },
    { id: 's', name: 'Self', parentId: 's', ...base },
    { id: 'a', name: 'A', parentId: 'b', ...base },
    { id: 'b', name: 'B', parentId: 'a', ...base },
  ]);
  assert.equal(dropped, 3);
  assert.equal(topLevelOf(polities, 'c'), 'k');
  assert.equal(polities.find((p) => p.id === 'x')!.parentId, undefined);
  assert.equal(polities.find((p) => p.id === 's')!.parentId, undefined);
  assert.equal(polities.filter((p) => (p.id === 'a' || p.id === 'b') && p.parentId).length, 1, 'one link of the loop survives');
});

test('a generated roster names parents, which decode into parent ids', async () => {
  const { decodeLayer } = await import('../core/decode.ts');
  const ctx = {
    description: '', cols: 3, rows: 1, base: ['Land', 'Land', 'Land'] as BaseGeo[],
    elevation: null, climate: null, vegetation: null, rivers: null, cities: null, polities: null, population: null,
  };
  const out = decodeLayer('polities', {
    polities: [
      { key: 'A', name: 'High Kingdom', colour: '#aa3333' },
      { key: 'B', name: 'March of Ost', parent: 'High Kingdom', colour: '#3333aa' },
      { key: 'C', name: 'Duchy of West', parent: 'high kingdom', colour: '#33aa33' },
      { key: 'D', name: 'Free City', parent: 'Nowhere', colour: '#777777' },
    ],
    rows: ['BCD'],
    notes: '',
  }, ctx as never);
  const data = out.data as { polities: Array<{ id: string; name: string; parentId?: string }> };
  const king = data.polities.find((p) => p.name === 'High Kingdom')!;
  assert.equal(data.polities.find((p) => p.name === 'March of Ost')!.parentId, king.id);
  assert.equal(data.polities.find((p) => p.name === 'Duchy of West')!.parentId, king.id, 'parent names match regardless of case');
  assert.equal(data.polities.find((p) => p.name === 'Free City')!.parentId, undefined);
  assert.ok(out.warnings.some((w) => w.includes('Nowhere')));
});

/** Every primitive in a scene, however deeply the clip groups nest them. */
function flatPrims(prims: Prim[]): Prim[] {
  return prims.flatMap((p) => (p.kind === 'group' ? [p, ...flatPrims(p.prims)] : [p]));
}

test('a realm is named across all its parts, its parts smaller, with a dashed line between them', () => {
  const cols = 8;
  const rows = 4;
  const map = createMapState('Realm', cols, rows);
  map.layers.base.data = Array(cols * rows).fill('Land');
  map.layers.polities.data = {
    polities: [
      { id: 'k', name: 'Valdoria', colour: '#aa3333' },
      { id: 'w', name: 'Westmark', colour: '#3366aa', parentId: 'k' },
      { id: 'e', name: 'Eastmark', colour: '#33aa66', parentId: 'k' },
    ],
    owner: Array.from({ length: cols * rows }, (_, i) => (i % cols < cols / 2 ? 'w' : 'e')),
  };
  const visible = defaultVisibility();
  visible.polities = true;
  const style = resolveStyle({ preset: 'parchment', overrides: {} });
  const prims = buildScene(map, { size: 20, visible, labels: true, polityNames: 0, style }).prims;
  const texts = prims.filter((p): p is Extract<Prim, { kind: 'text' }> => p.kind === 'text' && Boolean(p.fantasy));
  const realm = texts.find((t) => t.text === 'VALDORIA');
  assert.ok(realm, 'the realm, which owns no hexes itself, is named');
  for (const part of texts.filter((t) => t.text !== 'VALDORIA')) assert.ok(part.size < realm.size, `${part.text} is set smaller`);
  assert.ok(flatPrims(prims).some((p) => p.kind === 'path' && p.dash), 'parts are divided by a dashed line');
  // With tints, the parts are drawn as shades of the realm's colour, not their own.
  const fills = new Set(prims.filter((p) => p.kind === 'polygon').map((p) => p.fill));
  assert.ok(!fills.has('#3366aa') && !fills.has('#33aa66'));
});

test('the legend lists a realm with its parts indented under it', async () => {
  const { legendSections, DEFAULT_LEGEND_OPTIONS } = await import('../src/render/legend.ts');
  const map = createMapState('Realm', 2, 1);
  map.layers.base.data = ['Land', 'Land'];
  map.layers.polities.data = {
    polities: [
      { id: 'w', name: 'Westmark', colour: '#3366aa', parentId: 'k' },
      { id: 'k', name: 'Valdoria', colour: '#aa3333' },
    ],
    owner: ['w', 'w'],
  };
  const visible = defaultVisibility();
  visible.polities = true;
  const section = legendSections(map, visible, 'colour', DEFAULT_LEGEND_OPTIONS).find((s) => s.id === 'polities')!;
  assert.deepEqual(section.entries.map((e) => [e.label, e.indent]), [['Valdoria', 0], ['Westmark', 1]]);
});

test('relief: drawn symbols for illustrated, shading for hillshade, and old terrain marks migrate', async () => {
  const map = createMapState('Relief', 4, 3);
  map.layers.base.data = Array(12).fill('Land');
  map.layers.elevation.data = ['Lowland', 'Hills', 'Mountains', 'Mountains', 'Lowland', 'Rolling', 'Highland', 'Mountains', 'Lowland', 'Lowland', 'Plateau', 'Hills'];
  const visible = defaultVisibility();
  visible.elevation = true;
  const scene = (relief: 'colour' | 'marks' | 'illustrated' | 'hillshade') =>
    buildScene(map, { size: 20, visible, labels: false, style: resolveStyle({ preset: 'classic', overrides: { relief } }) }).prims;
  const ink = resolveStyle({ preset: 'classic', overrides: {} }).palette.ink;
  assert.ok(scene('illustrated').some((p) => p.kind === 'path' && p.stroke === ink), 'peaks and hills are drawn');
  assert.ok(scene('hillshade').some((p) => p.kind === 'polygon' && typeof p.fill === 'string' && p.fill.startsWith('rgba(')), 'slopes are shaded');
  assert.ok(scene('marks').some((p) => p.kind === 'polyline'), 'marks are drawn');
  // Colour relief tints the hexes by height.
  assert.ok(scene('colour').some((p) => p.kind === 'polygon' && p.fill === '#7d6d59'));

  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  (globalThis as { window?: unknown }).window = { localStorage: storage, sessionStorage: storage };
  try {
    const { loadPrefs } = await import('../src/api/settings.ts');
    store.set('fantasyhexmap.prefs', JSON.stringify({ elevationStyle: 'contours', mapStyle: { preset: 'parchment', overrides: {} } }));
    assert.deepEqual(loadPrefs().mapStyle, { preset: 'parchment', overrides: { relief: 'marks' } });
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

test('realms can be filled, washed along their borders, or outlined, and islet hexes get no hex ring', () => {
  const cols = 6;
  const rows = 3;
  const map = createMapState('Modes', cols, rows);
  const base: BaseGeo[] = Array(cols * rows).fill('Land');
  base[5] = 'Islands';
  map.layers.base.data = base;
  map.layers.polities.data = {
    polities: [{ id: 'a', name: 'Avel', colour: '#aa3333' }, { id: 'b', name: 'Brin', colour: '#3355aa' }],
    owner: Array.from({ length: cols * rows }, (_, i) => (i === 5 ? 'b' : i % cols < 3 ? 'a' : 'b')),
  };
  const visible = defaultVisibility();
  visible.polities = true;
  const prims = (polityStyle: 'fill' | 'wash' | 'outline') =>
    buildScene(map, { size: 20, visible, labels: false, style: resolveStyle({ preset: 'classic', overrides: { polityStyle } }) }).prims;
  const solidFills = (list: Prim[]) => list.filter((p) => p.kind === 'polygon' && (p.fill === '#aa3333' || p.fill === '#3355aa'));
  assert.ok(solidFills(prims('fill')).length > 0, 'filled realms paint their hexes');
  for (const mode of ['wash', 'outline'] as const) {
    const list = prims(mode);
    assert.equal(solidFills(list).length, 0, `${mode} leaves the hexes unpainted`);
    assert.ok(list.some((p) => p.kind === 'group'), `${mode} draws a band inside each realm`);
    assert.ok(list.some((p) => p.kind === 'path' && p.stroke?.startsWith('rgba(') && p.strokeWidth! < 2), `${mode} draws a frontier line`);
  }
  // The islet hex (index 5) is not part of any realm's band region.
  const bands = prims('fill').filter((p): p is Extract<Prim, { kind: 'group' }> => p.kind === 'group');
  const islet = { x: 20 * Math.sqrt(3) * 5 + 20 * Math.sqrt(3) / 2, y: 20 };
  for (const g of bands) {
    // Each clip hexagon is six corners then Z; check where each one is centred.
    const corners = (g.clip ?? []).filter((c) => c[0] !== 'Z').map((c) => ({ x: c[1] as number, y: c[2] as number }));
    for (let k = 0; k + 6 <= corners.length; k += 6) {
      const hexPts = corners.slice(k, k + 6);
      const cx = hexPts.reduce((t, q) => t + q.x, 0) / 6;
      const cy = hexPts.reduce((t, q) => t + q.y, 0) / 6;
      assert.ok(Math.hypot(cx - islet.x, cy - islet.y) > 1, 'no band clip around the islet hex');
    }
  }
});

test('every preset names in its own ink, and dark styles stay legible', () => {
  const map = islandMap();
  map.layers.cities.data = {
    cities: [{ id: 'c', col: 3, row: 2, name: 'Harrow', population: 30_000, onRiver: false, riverId: null, coastal: false, coastalEdges: [] }],
  };
  const visible = { ...allLayers(), cities: true };
  for (const preset of PRESET_ORDER) {
    const style = resolveStyle({ preset, overrides: {} });
    const prims = buildScene(map, { size: 20, visible, labels: true, style }).prims;
    const name = prims.find((p): p is Extract<Prim, { kind: 'text' }> => p.kind === 'text' && p.text === 'Harrow');
    assert.equal(name?.fill, style.palette.label, `${preset}: city name ink`);
    // The marker is in the preset's city ink, whichever marker set it uses.
    const marker = prims.find((p) =>
      (p.kind === 'city' || p.kind === 'circle' || p.kind === 'path') && 'fill' in p && p.fill === style.palette.cityFill,
    );
    assert.ok(marker, `${preset}: marker colour`);
  }
  // On the dark preset the names are light.
  const night = resolveStyle({ preset: 'night', overrides: {} }).palette;
  const lum = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
  assert.ok(lum(night.label) > lum(night.land) + 300);
});

test('boundary chains close only when they return to their start, even where edges share a start point', () => {
  const P = (x: number, y: number) => ({ x, y });
  const [A, B, C, D, E, F] = [P(0, 0), P(10, 0), P(20, 0), P(10, 10), P(30, 0), P(40, 0)];
  const edge = (from: { x: number; y: number }, to: { x: number; y: number }) => ({ from, to, land: 0, water: 0 });
  // A loop A-B-D-A, and a branch B-C-E-F leaving the same vertex B.
  const edges = [edge(A, B), edge(B, C), edge(B, D), edge(D, A), edge(C, E), edge(E, F)];
  const chains = chainEdges(edges);
  assert.equal(chains.reduce((n, c) => n + c.edges.length, 0), edges.length, 'every edge used once');
  for (const c of chains) {
    if (c.closed) {
      const last = c.edges.at(-1)!.to;
      assert.deepEqual(last, c.edges[0]!.from, 'a closed chain returns to its start');
    }
  }
});

test('a river city on the coast stands where its river meets the shore', async () => {
  const { citySite, resolvedSite } = await import('../src/render/sites.ts');
  const { hexCenter } = await import('../shared/hex.ts');
  const size = 20;
  const centre = hexCenter(1, 1, size);
  // The river runs west to east across the hex; the coast is the east edge.
  const line = Array.from({ length: 21 }, (_, k) => ({ x: centre.x - 20 + k * 2, y: centre.y + 2 }));
  const city = {
    id: 'c', col: 1, row: 1, name: 'Mouth', population: 20_000,
    onRiver: true, riverId: 'r', coastal: true, coastalEdges: [0],
  };
  const ctx = { size, base: Array(9).fill('Land') as BaseGeo[], cols: 3, riverLine: () => line };
  assert.equal(resolvedSite(city).kind, 'port', 'auto makes a river city on the coast a port');
  const auto = citySite(city, ctx);
  assert.ok(auto.x > centre.x + size * 0.4 && Math.abs(auto.y - (centre.y + 2)) < 1e-9, 'on the river, toward the east shore');
  assert.deepEqual(citySite({ ...city, site: { coast: 0, river: true } }, ctx), auto);
  assert.equal(resolvedSite({ ...city, site: { coast: 0 } }).kind, 'coast', 'coast alone still leaves the river');
});

test('a lake is treated as sea by realms: its shore carries the band and no realm colour reaches its water', () => {
  const cols = 7;
  const rows = 5;
  const map = createMapState('Lake realm', cols, rows);
  const base: BaseGeo[] = Array(cols * rows).fill('Land');
  // A three-hex lake with an islet in it, all inside one realm, which also claims the lake.
  for (const i of [2 * cols + 2, 2 * cols + 4, 1 * cols + 3]) base[i] = 'Lake';
  base[2 * cols + 3] = 'Islands';
  map.layers.base.data = base;
  map.layers.polities.data = {
    polities: [{ id: 'r', name: 'Realm', colour: '#aa3333' }],
    owner: base.map(() => 'r'),
  };
  const visible = defaultVisibility();
  visible.polities = true;
  for (const polityStyle of ['wash', 'fill'] as const) {
    const style = resolveStyle({ preset: 'parchment', overrides: { polityStyle } });
    const prims = buildScene(map, { size: 20, visible, labels: false, style }).prims;
    assert.ok(!prims.some((p) => p.kind === 'polygon' && p.fill === style.palette.sea), 'no sea under the lake islet');
    const bodies = prims.filter((p): p is Extract<Prim, { kind: 'path' }> => p.kind === 'path' && p.fill === style.palette.lake);
    assert.equal(bodies.length, 1, 'one lake body');
    const body = bodies[0]!.d;
    const bodyIndex = prims.indexOf(bodies[0]!);
    // No realm-coloured hex or sector is painted over the lake body (its islet is land, and may be).
    prims.slice(bodyIndex + 1).forEach((p) => {
      if (p.kind === 'polygon') assert.ok(!String(p.fill).includes('170, 51, 51') && p.fill !== '#aa3333', 'realm colour over the lake');
    });
    if (polityStyle === 'wash') {
      // The band strokes the drawn shore, inside a mask that cuts the lake out.
      const masks = flatPrims(prims).filter((p): p is Extract<Prim, { kind: 'group' }> => p.kind === 'group' && p.clipRule === 'evenodd' && JSON.stringify(p.clip).includes(JSON.stringify(body[0])));
      assert.equal(masks.length, 1);
      const stroke = flatPrims(masks[0]!.prims).find((p) => p.kind === 'path') as Extract<Prim, { kind: 'path' }>;
      assert.ok(JSON.stringify(stroke.d).includes(JSON.stringify(body[0])), 'the band follows the lake shore');
      assert.ok(JSON.stringify(masks[0]!.clip).includes(JSON.stringify(body[0])), 'the lake is cut out of the band');
    }
  }
});

test('the land a lake hex leaves uncovered takes the colour of the realm it faces', () => {
  const cols = 6;
  const rows = 4;
  const map = createMapState('Shared lake', cols, rows);
  const base: BaseGeo[] = Array(cols * rows).fill('Land');
  base[1 * cols + 2] = 'Lake';
  map.layers.base.data = base;
  map.layers.polities.data = {
    polities: [{ id: 'w', name: 'West', colour: '#aa3333' }, { id: 'e', name: 'East', colour: '#3333aa' }],
    owner: base.map((v, i) => (v === 'Lake' ? 'w' : i % cols <= 2 ? 'w' : 'e')),
  };
  const visible = defaultVisibility();
  visible.polities = true;
  const style = resolveStyle({ preset: 'classic', overrides: {} });
  const prims = buildScene(map, { size: 20, visible, labels: false, style }).prims;
  const triangles = prims.filter((p): p is Extract<Prim, { kind: 'polygon' }> => p.kind === 'polygon' && p.points.length === 3);
  const fills = new Set(triangles.map((t) => t.fill));
  assert.ok(fills.has('#aa3333') && fills.has('#3333aa'), 'sectors facing each realm take its colour');
});

test('automatic colours contrast neighbouring realms and shade each realm’s parts from it', async () => {
  const { contrastingRealmColours } = await import('../src/render/hierarchy.ts');
  const polities = [
    { id: 'k', name: 'Kingdom', colour: '#000000' },
    { id: 'd1', name: 'Duchy One', colour: '#000000', parentId: 'k' },
    { id: 'd2', name: 'Duchy Two', colour: '#000000', parentId: 'k' },
    { id: 'n', name: 'Neighbour', colour: '#000000' },
  ];
  const owner = ['d1', 'd1', 'd2', 'd2', 'n', 'n'];
  const colours = contrastingRealmColours(polities, owner, 6, 1);
  assert.equal(colours.size, 4);
  assert.notEqual(colours.get('k'), colours.get('n'));
  const { toLab } = await import('../src/render/palette.ts');
  const dist = (a: string, b: string) => Math.hypot(...toLab(a).map((v, i) => v - toLab(b)[i]!));
  // Parts are near their realm's colour and far from the neighbour's.
  for (const part of ['d1', 'd2']) {
    assert.ok(dist(colours.get(part)!, colours.get('k')!) < dist(colours.get(part)!, colours.get('n')!), `${part} reads as part of the kingdom`);
  }
  assert.notEqual(colours.get('d1'), colours.get('d2'));
});

test('the frontier line can be switched off, and is drawn in filled mode when on', () => {
  const map = createMapState('Front', 4, 1);
  map.layers.base.data = Array(4).fill('Land');
  map.layers.polities.data = { polities: [{ id: 'a', name: 'A', colour: '#aa3333' }, { id: 'b', name: 'B', colour: '#3355aa' }], owner: ['a', 'a', 'b', 'b'] };
  const visible = defaultVisibility();
  visible.polities = true;
  const lines = (frontier: 'none' | 'solid') => {
    const style = resolveStyle({ preset: 'classic', overrides: { frontier } });
    return flatPrims(buildScene(map, { size: 20, visible, labels: false, style }).prims).filter((p) => p.kind === 'path' && p.stroke === style.palette.frontier).length;
  };
  assert.equal(lines('none'), 0);
  assert.equal(lines('solid'), 1);
});

test('city names can prefer the place below their marker', async () => {
  const { placeCityNames } = await import('../src/render/labels.ts');
  const city = [{ id: 'a', name: 'Alder', at: { x: 100, y: 100 }, r: 5, population: 10_000 }];
  const beside = placeCityNames(city, 10, (t) => t.length * 6, [], { width: 400, height: 400 });
  const below = placeCityNames(city, 10, (t) => t.length * 6, [], { width: 400, height: 400 }, 'below');
  assert.equal(beside[0]!.anchor, 'start');
  assert.equal(below[0]!.anchor, 'middle');
  assert.ok(below[0]!.at.y > 100);
});

test('a plateau is drawn as an escarpment where it falls to lower ground, not as a symbol in every hex', () => {
  const map = createMapState('Plateau', 4, 1);
  map.layers.base.data = Array(4).fill('Land');
  map.layers.elevation.data = ['Lowland', 'Plateau', 'Plateau', 'Mountains'];
  const visible = defaultVisibility();
  visible.elevation = true;
  const style = resolveStyle({ preset: 'parchment', overrides: {} });
  const ink = style.palette.ink;
  const prims = buildScene(map, { size: 20, visible, labels: false, style }).prims;
  const escarpments = prims.filter((p): p is Extract<Prim, { kind: 'path' }> =>
    p.kind === 'path' && Boolean(p.stroke) && !p.fill && p.d.filter((c) => c[0] === 'M').length >= 4);
  // Only the edge between the Lowland hex and the plateau carries one; the plateau-to-mountain edge does not.
  assert.equal(escarpments.length, 1);
  assert.ok(ink);
});

test('names are set in the style’s lettering, tracked realm names letter by letter', async () => {
  const { LETTERINGS, LETTERING_ORDER } = await import('../src/render/lettering.ts');
  const cols = 8;
  const rows = 4;
  const map = createMapState('Lettering', cols, rows);
  map.layers.base.data = Array(cols * rows).fill('Land');
  map.layers.polities.data = {
    polities: [{ id: 'k', name: 'Valdoria', colour: '#aa3333' }],
    owner: Array(cols * rows).fill('k'),
  };
  map.layers.cities.data = {
    cities: [{ id: 'c', name: 'Alder', col: 2, row: 1, population: 20_000, polityId: 'k', coastalEdges: [], onRiver: false } as never],
  };
  const visible = defaultVisibility();
  visible.polities = true;
  visible.cities = true;
  for (const id of LETTERING_ORDER) {
    const style = resolveStyle({ preset: 'parchment', overrides: { lettering: id } });
    const prims = buildScene(map, { size: 24, visible, labels: true, polityNames: 0, style }).prims;
    const texts = prims.filter((p): p is Extract<Prim, { kind: 'text' }> => p.kind === 'text');
    const realm = texts.find((t) => t.text === 'VALDORIA');
    const city = texts.find((t) => t.text === 'Alder');
    assert.ok(realm && city, `${id}: realm and city are named`);
    assert.equal(realm.font, LETTERINGS[id].realm.family);
    assert.equal(realm.weight, LETTERINGS[id].realm.weight);
    assert.equal(city.font, LETTERINGS[id].city.family);
    if (LETTERINGS[id].realm.tracking > 0) assert.equal(realm.glyphs?.length, 'VALDORIA'.length, `${id}: tracked`);
    else assert.equal(realm.glyphs, undefined);
  }
});

test('every bundled pairing has a real face for each kind of name', async () => {
  const { LETTERINGS, LETTERING_ORDER, letteringFaces } = await import('../src/render/lettering.ts');
  for (const id of LETTERING_ORDER.filter((l) => l !== 'classic')) {
    const faces = letteringFaces(id);
    const l = LETTERINGS[id];
    for (const role of [l.realm, l.water, l.river, l.city, l.range]) {
      assert.ok(
        faces.some((f) => role.family.startsWith(`"${f.family}"`) && f.weight === role.weight && f.italic === role.italic),
        `${id}: ${role.family} ${role.weight}${role.italic ? ' italic' : ''} is bundled`,
      );
    }
  }
  assert.deepEqual(letteringFaces('classic'), []);
  assert.equal(parseStyleChoice({ preset: 'parchment', overrides: { lettering: 'comic' } }).overrides.lettering, undefined);
  assert.equal(resolveStyle({ preset: 'atlas', overrides: {} }).knobs.lettering, 'chancery');
  // The retired Alegreya pairing falls back to the preset's own.
  assert.equal(parseStyleChoice({ preset: 'atlas', overrides: { lettering: 'atlas' } }).overrides.lettering, undefined);
});

test('the political atlas shows no elevation and gives sub-polities their own colours', () => {
  const { knobs } = resolveStyle({ preset: 'atlas', overrides: {} });
  assert.equal(knobs.relief, 'none');
  assert.equal(knobs.subPolities, 'own');
  assert.equal(knobs.polityStyle, 'fill');
  assert.equal(elevationStyleOf(resolveStyle({ preset: 'atlas', overrides: {} })), 'none');
});

test('an SVG carries the font rules it is given, and measurements can be thrown away', async () => {
  const fonts = await import('../src/render/fonts.ts');
  const scene = { width: 10, height: 10, background: '#fff', prims: [] };
  const css = '@font-face{font-family:"HexMap Cinzel";src:url(data:font/woff2;base64,AAAA)}';
  assert.ok(sceneToSvg(scene, 't', css).includes(`<style>${css}</style>`));
  assert.ok(!sceneToSvg(scene, 't').includes('<style>'));
  const before = fonts.measureEpoch;
  fonts.invalidateTextMeasures();
  assert.equal(fonts.measureEpoch, before + 1);
});

test('a river name moves along its river to keep clear of a realm name', async () => {
  const { placeRiverLabels } = await import('../src/render/featureLabels.ts');
  const river = { id: 'r', name: 'Wend', terminus: 'Sea', segments: [] } as never;
  const line = Array.from({ length: 41 }, (_, i) => ({ x: i * 10, y: 100 }));
  const free = placeRiverLabels([river], 20, () => line)[0]!;
  assert.ok(Math.abs(free.at.x - 200) < 30, 'unobstructed, the name sits mid-river');
  const realm = { cx: 200, cy: 95, halfW: 70, halfH: 12, rotation: 0 };
  const moved = placeRiverLabels([river], 20, () => line, undefined, [realm])[0]!;
  for (const g of moved.glyphs!) assert.ok(Math.abs(g.x - 200) > 70, `glyph ${g.ch} clears the realm name`);
});

/** A 9x5 land map with a lake at (1,2) and sea down the east edge, for the river-network tests. */
function riverNetworkMap(): MapState {
  const cols = 9;
  const rows = 5;
  const map = createMapState('Rivers', cols, rows);
  const base: BaseGeo[] = Array(cols * rows).fill('Land');
  base[hexIndex(cols, 1, 2)] = 'Lake';
  for (let row = 0; row < rows; row++) base[hexIndex(cols, 8, row)] = 'Sea';
  map.layers.base.data = base;
  return map;
}

/** A path from `start` stepping across the given edges. */
function stepPath(start: { col: number; row: number }, edges: number[]) {
  const path = [start];
  for (const e of edges) path.push(neighbourOf(path.at(-1)!.col, path.at(-1)!.row, e));
  return path;
}

test('a river can flow out of a lake, and a tributary ends on the river it joins', async () => {
  const { buildRiverFromPath, validateRivers } = await import('../shared/validate.ts');
  const map = riverNetworkMap();
  const base = map.layers.base.data!;
  const warnings: string[] = [];
  // East from the lake to the sea.
  const trunk = buildRiverFromPath({ name: 'Trunk', path: stepPath({ col: 1, row: 2 }, [0, 0, 0, 0, 0, 0, 0]) }, 't', base, null, 9, 5, warnings)!;
  assert.equal(trunk.fromLake, true);
  assert.equal(trunk.segments[0]!.col, 2, 'the lake hex is not a segment');
  assert.equal(trunk.segments[0]!.entryEdge, 3, 'it enters from the lake');
  assert.equal(trunk.terminus, 'Sea');
  // From the north, down onto the trunk at (4,2).
  const tribPath = [{ col: 4, row: 0 }, { col: 4, row: 1 }, { col: 4, row: 2 }];
  const trib = buildRiverFromPath({ name: 'Trib', path: tribPath, joins: 't' }, 'b', base, null, 9, 5, warnings, [trunk])!;
  assert.equal(trib.terminus, 'River');
  assert.equal(trib.joins, 't');
  assert.equal(trib.segments.at(-1)!.exitEdge, null);
  // Validation keeps a sound link and cuts one that no longer reaches its river.
  assert.equal(validateRivers([trunk, trib], base, 9, 5).data[1]!.joins, 't');
  const moved = { ...trunk, segments: trunk.segments.filter((s) => s.col !== 4) };
  const checked = validateRivers([moved, trib], base, 9, 5).data[1]!;
  assert.equal(checked.joins, undefined);
  assert.equal(checked.terminus, 'Unresolved');
});

test('editing keeps a lake source and can run a river into a lake upstream or into another river', async () => {
  const { buildRiverFromPath } = await import('../shared/validate.ts');
  const { extendRiver, moveRiverSegment, detachOrphanBranches } = await import('../shared/riverEdit.ts');
  const map = riverNetworkMap();
  const base = map.layers.base.data!;
  const trunk = buildRiverFromPath({ name: 'Trunk', path: stepPath({ col: 1, row: 2 }, [0, 0, 0, 0, 0, 0, 0]) }, 't', base, null, 9, 5, [])!;
  // Moving a middle hex keeps the lake source, and the edges either side of it.
  const moved = moveRiverSegment(trunk, 3, { col: 5, row: 1 }, base, null, 9, 5, []);
  assert.ok(!('error' in moved), 'error' in moved ? moved.error : '');
  assert.equal(moved.river.fromLake, true);
  assert.equal(moved.river.segments[0]!.col, 2);
  // A short river from (3,0) east; extend its source back west into... land, then a tributary by extension.
  const short = buildRiverFromPath({ name: 'Short', path: [{ col: 2, row: 0 }, { col: 3, row: 0 }] }, 's', base, null, 9, 5, [])!;
  const joined = extendRiver(short, { col: 3, row: 2 }, base, null, 9, 5, [trunk]);
  assert.ok(!('error' in joined));
  assert.equal(joined.river.joins, 't');
  assert.equal(joined.river.terminus, 'River');
  // Up into the lake: the river then flows out of it.
  const fromShore = buildRiverFromPath({ name: 'Shore', path: [{ col: 2, row: 1 }, { col: 3, row: 1 }] }, 'u', base, null, 9, 5, [])!;
  const intoLake = extendRiver(fromShore, { col: 1, row: 2 }, base, null, 9, 5, []);
  assert.ok(!('error' in intoLake));
  assert.equal(intoLake.river.fromLake, true);
  // A tributary whose river is gone ends inland.
  const [orphan] = detachOrphanBranches([joined.river]);
  assert.equal(orphan!.joins, undefined);
  assert.equal(orphan!.terminus, 'Unresolved');
});

test('rivers start and stop on a lake’s drawn shore, and a river widens below a confluence', async () => {
  const { buildRiverFromPath } = await import('../shared/validate.ts');
  const map = riverNetworkMap();
  const base = map.layers.base.data!;
  base[hexIndex(9, 6, 0)] = 'Lake';
  const trunk = buildRiverFromPath({ name: 'Trunk', path: stepPath({ col: 1, row: 2 }, [0, 0, 0, 0, 0, 0, 0]) }, 't', base, null, 9, 5, [])!;
  const trib = buildRiverFromPath({ name: 'Trib', path: [{ col: 4, row: 0 }, { col: 4, row: 1 }, { col: 4, row: 2 }] }, 'b', base, null, 9, 5, [], [trunk])!;
  const intoLake = buildRiverFromPath({ name: 'Mere', path: [{ col: 3, row: 4 }, { col: 4, row: 4 }, { col: 5, row: 4 }, { col: 5, row: 3 }, { col: 6, row: 2 }, { col: 6, row: 1 }, { col: 6, row: 0 }] }, 'm', base, null, 9, 5, [])!;
  assert.equal(intoLake.terminus, 'Lake');
  map.layers.rivers.data = { rivers: [trunk, trib, intoLake] };
  const visible = defaultVisibility();
  visible.rivers = true;
  const style = resolveStyle({ preset: 'parchment', overrides: {} });
  const scene = buildScene(map, { size: 20, visible, labels: false, style });
  const lakeBodies = scene.prims.filter((p): p is Extract<Prim, { kind: 'path' }> => p.kind === 'path' && p.fill === style.palette.lake);
  const rings = lakeBodies.map((b) => b.d.filter((c) => c[0] !== 'Z').map((c) => ({ x: c[1] as number, y: c[2] as number })));
  const distToShore = (p: { x: number; y: number }) => Math.min(...rings.flatMap((ring) => ring.map((q) => Math.hypot(q.x - p.x, q.y - p.y))));
  // Rivers are clipped to the land, so they may sit inside a group.
  const flat = (list: Prim[]): Prim[] => list.flatMap((p) => (p.kind === 'group' ? flat(p.prims) : [p]));
  const rivers = flat(scene.prims).filter((p): p is Extract<Prim, { kind: 'path' }> => p.kind === 'path' && p.fill === style.palette.river);
  assert.equal(rivers.length, 3);
  const [trunkPrim, , merePrim] = rivers;
  // The trunk leaves the lake at its shore.
  const first = trunkPrim!.d[0]!;
  assert.ok(distToShore({ x: first[1] as number, y: first[2] as number }) < 20 * 0.15, 'the trunk starts on the lake shore');
  // The mere runs on a little way into the lake it empties into, but only a little.
  const inside = (p: { x: number; y: number }, ring: Array<{ x: number; y: number }>) => {
    let in_ = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i]!;
      const b = ring[j]!;
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) in_ = !in_;
    }
    return in_;
  };
  const mere = merePrim!.d.filter((c) => c[0] !== 'Z').map((c) => ({ x: c[1] as number, y: c[2] as number }));
  const depth = Math.max(0, ...mere.filter((p) => rings.some((ring) => inside(p, ring))).map(distToShore));
  assert.ok(depth > 0 && depth < 20 * 0.6, `the mere river reaches into the lake by ${depth.toFixed(1)}`);
  // Width: compare the trunk just above and below the confluence at (4,2).
  const { riverCourse } = await import('../src/render/rivers.ts');
  const plain = riverCourse(trunk, 20, map.id)!;
  const fed = riverCourse(trunk, 20, map.id, { inflows: [{ at: { x: 4.5 * 20 * Math.sqrt(3), y: 20 + 2 * 30 } }] })!;
  assert.ok(fed.widths.at(-10)! > plain.widths.at(-10)!, 'wider below the confluence');
  assert.equal(fed.widths[2], plain.widths[2], 'unchanged above it');
});

test('city markers come in three sets, each drawing every size of place', async () => {
  const map = islandMap();
  const sizes = [5_000, 30_000, 120_000, 600_000];
  map.layers.cities.data = {
    cities: sizes.map((population, k) => ({ id: `c${k}`, col: 2 + (k % 3), row: 1 + Math.floor(k / 3) * 2, name: `C${k}`, population, onRiver: false, riverId: null, coastal: false, coastalEdges: [] })),
  };
  const visible = { ...allLayers(), cities: true };
  for (const cityMarkers of ['symbols', 'classic', 'illustrated'] as const) {
    const style = resolveStyle({ preset: 'parchment', overrides: { cityMarkers } });
    const prims = buildScene(map, { size: 20, visible, labels: false, style }).prims;
    if (cityMarkers === 'symbols') {
      assert.equal(prims.filter((p) => p.kind === 'city').length, sizes.length);
    } else {
      assert.equal(prims.filter((p) => p.kind === 'city').length, 0);
      const ink = prims.filter((p) => (p.kind === 'circle' || p.kind === 'path') && p.fill === style.palette.cityFill);
      assert.ok(ink.length >= sizes.length, `${cityMarkers}: every place has a marker`);
    }
    // The SVG of each set is well formed.
    assert.ok(sceneToSvg({ width: 100, height: 100, background: '#fff', prims }, 'x').startsWith('<'));
  }
  assert.equal(resolveStyle({ preset: 'parchment', overrides: {} }).knobs.cityMarkers, 'illustrated');
  assert.equal(resolveStyle({ preset: 'classic', overrides: {} }).knobs.cityMarkers, 'symbols');
});

test('the first map loaded, before any map is open, is migrated too', async () => {
  const { appReducer } = await import('../src/state/store.ts');
  const map = createMapState('Old', 2, 1);
  map.layers.base.data = ['Small Islands', 'Land'] as unknown as BaseGeo[];
  const loaded = appReducer(null, { type: 'load', map })!;
  assert.deepEqual(loaded.layers.base.data, ['Islands', 'Land']);
  assert.deepEqual(loaded.islandSpecs, { '0': { large: 0, small: 3 } });
  assert.equal(appReducer(loaded, { type: 'reset' }), null);
});

test('dragging a river’s source onto a lake makes it flow out of the lake; its mouth may be dragged into water', async () => {
  const { buildRiverFromPath } = await import('../shared/validate.ts');
  const { moveRiverSegment } = await import('../shared/riverEdit.ts');
  const map = riverNetworkMap();
  const base = map.layers.base.data!;
  // A river from (3,1) east to the sea.
  const river = buildRiverFromPath({ name: 'R', path: stepPath({ col: 3, row: 2 }, [0, 0, 0, 0, 0]) }, 'r', base, null, 9, 5, [])!;
  const fromLake = moveRiverSegment(river, 0, { col: 1, row: 2 }, base, null, 9, 5, []);
  assert.ok(!('error' in fromLake), 'error' in fromLake ? fromLake.error : '');
  assert.equal(fromLake.river.fromLake, true);
  assert.deepEqual([fromLake.river.segments[0]!.col, fromLake.river.segments[0]!.row], [2, 2]);
  // A middle hex cannot go into water.
  const middle = moveRiverSegment(river, 2, { col: 1, row: 2 }, base, null, 9, 5, []);
  assert.ok('error' in middle);
  // The mouth can: the river then empties into the lake.
  const short = buildRiverFromPath({ name: 'S', path: [{ col: 4, row: 1 }, { col: 3, row: 1 }] }, 's', base, null, 9, 5, [])!;
  const intoLake = moveRiverSegment(short, 1, { col: 1, row: 2 }, base, null, 9, 5, []);
  assert.ok(!('error' in intoLake), 'error' in intoLake ? intoLake.error : '');
  assert.equal(intoLake.river.terminus, 'Lake');
});

test('a city can stand on either bank of a strait', async () => {
  const { citySite, resolvedSite } = await import('../src/render/sites.ts');
  const { hexCenter } = await import('../shared/hex.ts');
  const city = { id: 'c', col: 1, row: 0, name: 'C', population: 100, onRiver: false, riverId: null, coastal: true, coastalEdges: [], site: { bank: 0 } };
  const ctx = { size: 20, base: ['Land', 'Strait', 'Land'] as const, cols: 3 };
  const centre = hexCenter(1, 0, 20);
  assert.equal(resolvedSite(city).kind, 'bank');
  const east = citySite(city, ctx);
  const west = citySite({ ...city, site: { bank: 3 } }, ctx);
  assert.ok(east.x > centre.x + 5 && west.x < centre.x - 5, 'each bank is on its own side of the channel');
});

test('border irregularity: straight keeps hex edges, and both sides of an edge draw the same wandering line', () => {
  const a = { x: 10, y: 10 };
  const b = { x: 30, y: 10 };
  assert.deepEqual(raggedEdge(a, b, 'straight', 's', 20), [b]);
  const there = raggedEdge(a, b, 'ragged', 's', 20);
  const back = raggedEdge(b, a, 'ragged', 's', 20);
  assert.deepEqual(there.slice(0, -1).reverse(), back.slice(0, -1), 'same interior points walked either way');
  assert.deepEqual(there.at(-1), b);
  assert.deepEqual(back.at(-1), a);
  const reach = (level: 'wobbly' | 'ragged' | 'wild') =>
    Math.max(...raggedEdge(a, b, level, 's', 20).map((p) => Math.abs(p.y - 10)));
  assert.ok(reach('wobbly') > 0 && reach('wild') <= 0.19 * 20 + 1e-9);
  assert.ok(reach('wild') >= reach('wobbly'));
  assert.equal(resolveStyle({ preset: 'classic', overrides: {} }).knobs.borders, 'ragged', 'ragged by default');
  assert.equal(parseStyleChoice({ preset: 'classic', overrides: { borders: 'wild' } }).overrides.borders, 'wild');
  assert.equal(parseStyleChoice({ preset: 'classic', overrides: { borders: 'bogus' } }).overrides.borders, undefined);
});

test('a smoothed coast says where it passes each corner, so a border can run out to it; a hex-edge coast does not', () => {
  const map = islandMap();
  const base = map.layers.base.data!;
  const size = 10;
  const smoothed = coastGeometry(base, map.cols, map.rows, size, true);
  const plain = coastGeometry(base, map.cols, map.rows, size, false);
  assert.equal(plain.anchors.size, 0);
  assert.ok(smoothed.anchors.size > 0);
  for (const chain of smoothed.chains) {
    for (const corner of chain.points) {
      const at = smoothed.anchors.get(coastKey(corner));
      if (!at) continue;
      assert.ok(Math.hypot(at.x - corner.x, at.y - corner.y) < size, 'the coast passes within a hex of the corner it rounds');
    }
  }
});

test('outlines used together as a clip are wound alike, so the land they share is kept rather than cancelled', () => {
  const square = (x: number, y: number, clockwise: boolean): PathCmd[] => {
    const pts = [[x, y], [x + 10, y], [x + 10, y + 10], [x, y + 10]] as const;
    const ring = clockwise ? pts : [...pts].reverse();
    return [...ring.map(([px, py], k) => [k === 0 ? 'M' : 'L', px, py] as PathCmd), ['Z']];
  };
  const area = (d: PathCmd[]) => {
    const pts = d.filter((c) => c[0] !== 'Z').map((c) => ({ x: c.at(-2) as number, y: c.at(-1) as number }));
    return pts.reduce((sum, a, k) => sum + a.x * pts[(k + 1) % pts.length]!.y - pts[(k + 1) % pts.length]!.x * a.y, 0);
  };
  const wound = alike([...square(0, 0, true), ...square(5, 5, false), ['M', 30, 0], ['Q', 40, 0, 40, 10], ['Q', 40, 20, 30, 10], ['Z']]);
  const outlines: PathCmd[][] = [];
  for (const c of wound) c[0] === 'M' ? outlines.push([c]) : outlines.at(-1)!.push(c);
  assert.equal(outlines.length, 3);
  const signs = new Set(outlines.map((o) => Math.sign(area(o))));
  assert.equal(signs.size, 1, 'every outline winds the same way');
});

test('a coast that runs off the map is closed round the page on its land side, so it encloses its land', () => {
  const cols = 3;
  const rows = 3;
  const size = 10;
  // Land on the left column only: its coast runs off the top and bottom of the map.
  const base: BaseGeo[] = Array(cols * rows).fill('Sea');
  for (let row = 0; row < rows; row++) base[hexIndex(cols, 0, row)] = 'Land';
  const geometry = coastGeometry(base, cols, rows, size, false);
  const chains = geometry.chains.filter((c) => !c.closed);
  assert.ok(chains.length > 0, 'the coast is open');
  const land = drawnLand(geometry, 100, 100, size);
  const inside = (x: number, y: number) => {
    const pts = land.filter((c) => c[0] !== 'Z').map((c) => ({ x: c.at(-2) as number, y: c.at(-1) as number }));
    let hit = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if ((pts[i]!.y > y) !== (pts[j]!.y > y) && x < ((pts[j]!.x - pts[i]!.x) * (y - pts[i]!.y)) / (pts[j]!.y - pts[i]!.y) + pts[i]!.x) hit = !hit;
    }
    return hit;
  };
  assert.ok(inside(5, 20), 'a point in the land is inside');
  assert.ok(!inside(60, 20), 'a point in the sea is not');
});

test('every map style draws no ripples by default, bar All frills', () => {
  for (const preset of PRESET_ORDER) {
    const ripples = resolveStyle({ preset, overrides: {} }).knobs.ripples;
    assert.equal(ripples, preset === 'frills' ? 3 : 0, preset);
  }
  assert.equal(PRESETS.frills.label, 'All frills');
  assert.ok(KNOB_OPTIONS.ripples.options.some((o) => o.value === 0), 'no ripples can be chosen in settings');
  assert.equal(parseStyleChoice({ preset: 'frills', overrides: { ripples: 0 } }).overrides.ripples, 0);
});

/** An eastward river of `count` hexes along row 2, with the hexes from `navigableFrom` navigable. */
function eastward(count: number, navigableFrom = Infinity, terminus: 'OffMap' | 'Sea' = 'OffMap') {
  const segments = Array.from({ length: count }, (_, col) => ({ col, row: 2, entryEdge: col === 0 ? null : 3, exitEdge: col === count - 1 && terminus !== 'Sea' ? null : 0, navigable: col >= navigableFrom }));
  return { id: 'e', name: 'East', terminus, segments };
}

/** The arc length from the start of a course to each of its samples. */
function arcs(line: Array<{ x: number; y: number }>): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i++) out.push(out[i - 1]! + Math.hypot(line[i]!.x - line[i - 1]!.x, line[i]!.y - line[i - 1]!.y));
  return out;
}

test('a river leaves its source hex half the normal width, and reaches the normal width a hex later', () => {
  const size = 40;
  const normal = size * 0.045;
  // A river much shorter than the longest adds almost nothing for length, so its body is the normal width.
  const { centreline, widths } = riverCourse(eastward(9), size, 'seed', { longest: 1000 * size })!;
  const arc = arcs(centreline);
  const at = (hexes: number) => widths[arc.findIndex((a) => a >= hexes * size)]!;
  assert.ok(widths[0]! < normal * 0.25, 'a thread at its spring');
  assert.ok(Math.abs(at(Math.sqrt(3) / 2) - normal * 0.5) < normal * 0.06, `${at(Math.sqrt(3) / 2) / normal} of normal at the hex edge`);
  assert.ok(Math.abs(at(4) - normal) < normal * 0.04, 'the normal width in the body');
});

test('length, tributaries and navigability each widen a river by their own small share', () => {
  const size = 40;
  const normal = size * 0.045;
  const end = (w: number[]) => w.at(-12)!;
  const short = riverCourse(eastward(9), size, 'seed', { longest: 1000 * size })!;
  // The longest river on the map adds up to a fifth of the normal width at its far end, in proportion to the distance
  // run: a river half as long as the longest adds half as much for the same distance.
  const run = arcs(short.centreline).at(-12)!;
  const longest = riverCourse(eastward(9), size, 'seed', { longest: 9 * Math.sqrt(3) * size })!.widths;
  const expected = (1 + 0.2 * (run / (9 * Math.sqrt(3) * size))) / (1 + 0.2 * (run / (1000 * size)));
  assert.ok(Math.abs(end(longest) / end(short.widths) - expected) < 0.02, `longest river ratio ${end(longest) / end(short.widths)} against ${expected}`);
  assert.ok(expected > 1.1 && expected < 1.2);
  const half = riverCourse(eastward(9), size, 'seed', { longest: 18 * Math.sqrt(3) * size })!.widths;
  assert.ok(Math.abs(end(half) / end(short.widths) - (1 + (expected - 1) / 2)) < 0.02, `half-length river ratio ${end(half) / end(short.widths)}`);
  // Each tributary adds a twentieth of the normal width below its confluence.
  const at = (n: number) => ({ at: { x: size * Math.sqrt(3) * (n + 0.5), y: size + 2 * 1.5 * size } });
  const fed = riverCourse(eastward(9), size, 'seed', { longest: 1000 * size, inflows: [at(2), at(3)] })!.widths;
  assert.ok(Math.abs((end(fed) - end(short.widths)) / normal - 0.1) < 0.012, `two tributaries add ${(end(fed) - end(short.widths)) / normal}`);
  // Navigable water is a tenth wider.
  const navigable = riverCourse(eastward(9, 4), size, 'seed', { longest: 1000 * size })!.widths;
  assert.ok(Math.abs((end(navigable) - end(short.widths)) / normal - 0.1) < 0.012, `navigable adds ${(end(navigable) - end(short.widths)) / normal}`);
  // The widest river of all is still slender.
  const big = riverCourse(eastward(12, 3), size, 'seed', { longest: 12 * Math.sqrt(3) * size, inflows: [at(2), at(4), at(6)] })!.widths;
  assert.ok(Math.max(...big) < size * 0.08, `widest ${Math.max(...big) / size} of a hex`);
});

test('a river into the sea ends at the coast as drawn, wherever that is', () => {
  const size = 40;
  const river = eastward(6, Infinity, 'Sea');
  const shoreAt = size * Math.sqrt(3) * 4.2;
  const course = riverCourse(river, size, 'seed', { onLand: (p) => p.x < shoreAt })!;
  const last = course.centreline.at(-1)!;
  assert.ok(Math.abs(last.x - shoreAt) < 1, `ends ${last.x.toFixed(1)} against a shore at ${shoreAt.toFixed(1)}`);
  // A shore beyond the last hex's own edge is reached too.
  const far = size * Math.sqrt(3) * 6.2;
  const farther = riverCourse(river, size, 'seed', { onLand: (p) => p.x < far })!;
  assert.ok(Math.abs(farther.centreline.at(-1)!.x - far) < 1, 'carried on to a shore beyond the edge');
  // And the river stays on the land: no point of its outline lies past the shore by more than half its width.
  for (const cmd of course.outline) if (cmd[0] === 'L' || cmd[0] === 'M') assert.ok((cmd[1] as number) < shoreAt + size * 0.05);
});

test('the side of the coast line a point falls on says whether it is land', async () => {
  const { landBySide } = await import('../src/render/rivers.ts');
  // A coast running down the page with the land to its right as it travels (the left of the screen).
  const land = landBySide([[{ x: 100, y: 0 }, { x: 100, y: 200 }]], 30, () => true);
  assert.equal(land({ x: 90, y: 100 }), true);
  assert.equal(land({ x: 110, y: 100 }), false);
  // Away from every line it defers to the hexes.
  assert.equal(land({ x: 500, y: 100 }), true);
});

test('the river bows round the icon of a city on its bank, and the icon is pressed against the bowed bank', async () => {
  const { pressPoint, pressIcon, PRESS, SET_IN } = await import('../src/render/riverCity.ts');
  const size = 40;
  const map = islandMap();
  const river = map.layers.rivers.data!.rivers[0]!;
  const bare = riverCourse(river, size, 'seed')!;
  // A city standing in the second hex of the river, with an icon of reach 12.
  const at = hexCenter(river.segments[1]!.col, river.segments[1]!.row, size);
  const reach = 12;
  const cities = (straddle: boolean) => [{ at, radius: 12, id: 'c', icon: { reach, straddle } }];
  const bowed = riverCourse(river, size, 'seed', { cities: cities(false) })!;
  assert.equal(bowed.icons.length, 1, 'the course reports where the icon stands');
  const m = bowed.icons[0]!.at;
  // The course keeps clear of all but a fraction of the icon's reach; without the city it runs through the icon.
  const nearest = (line: Array<{ x: number; y: number }>) => Math.min(...line.map((p) => Math.hypot(p.x - m.x, p.y - m.y)));
  assert.ok(nearest(bowed.centreline) >= reach * (1 - PRESS) - 1e-6, 'the river keeps clear of the icon');
  assert.ok(nearest(bare.centreline) < reach * (1 - PRESS), 'without the city the river would run through the icon');
  assert.ok(bowed.centreline.some((p, i) => Math.hypot(p.x - bare.centreline[i]!.x, p.y - bare.centreline[i]!.y) > 1), 'the river is reshaped');
  // The icon is set into the bank, not on the river.
  assert.ok(Math.hypot(m.x - at.x, m.y - at.y) < size, 'the icon stays in its hex');

  // Pressing: a point in the water goes to the bank, and a disc pressed against a bend follows it.
  const bend = Array.from({ length: 41 }, (_, i) => ({ x: i * 2, y: i < 20 ? 40 : 40 + (i - 20) * 1.6 }));
  const widths = bend.map(() => 4);
  const reachOf = { line: bend, widths };
  const wet = pressPoint(reachOf, { x: 30, y: 41 }, 0.5);
  assert.ok(Math.abs(wet.y - 40) >= 2.5 - 1e-6, 'a point in the river is slid onto its bank');
  assert.deepEqual(pressPoint(reachOf, { x: 30, y: 20 }, 0.5), { x: 30, y: 20 }, 'a point on land is not moved');
  const disc = pressIcon([{ kind: 'circle', c: { x: 40, y: 44 }, r: 12, fill: '#000', stroke: '#fff', strokeWidth: 1 }], reachOf, 0.5, 1);
  assert.equal(disc[0]!.kind, 'polygon', 'a circle becomes a polygon so that it can bend');
  const pts = (disc[0] as { points: Array<{ x: number; y: number }> }).points;
  const dist = (p: { x: number; y: number }) => Math.min(...bend.map((q) => Math.hypot(q.x - p.x, q.y - p.y)));
  assert.ok(pts.every((p) => dist(p) >= 2.5 - 0.7), 'no part of the icon lies in the water');
  assert.ok(pts.filter((p) => dist(p) < 3.5).length >= 4, 'part of its edge lies along the bank');
  // The icon of a city that straddles the river stands on it, and is parted: halves on both banks.
  const split = pressIcon([{ kind: 'circle', c: { x: 40, y: 40 }, r: 12, fill: '#000' }], reachOf, 0.5, 1)[0] as { points: Array<{ x: number; y: number }> };
  assert.ok(split.points.some((p) => p.y < 40 - 2) && split.points.some((p) => p.y > 40 + 2), 'a metropolis is parted along the river');
  assert.ok(split.points.every((p) => Math.abs(p.y - 40) >= 2.5 - 1e-6 || Math.abs(p.x - 40) > 11), 'and none of it lies in the water');
  const straddled = riverCourse(river, size, 'seed', { cities: cities(true) })!;
  assert.deepEqual(straddled.centreline.slice(0, 3), bare.centreline.slice(0, 3), 'a river is not bowed for a city that straddles it');
  assert.equal(SET_IN > 0 && SET_IN < 1, true);

  for (const cityMarkers of ['symbols', 'classic', 'illustrated'] as const) {
    const style = resolveStyle({ preset: 'parchment', overrides: { cityMarkers } });
    const sceneMap = islandMap();
    const visible = { ...allLayers(), cities: true };
    const draw = (population: number, onRiver: boolean) => {
      sceneMap.layers.cities.data = { cities: [{ id: 'a', col: 2, row: 2, name: 'Wet', population, onRiver, riverId: onRiver ? 'r' : null, coastal: false, coastalEdges: [] }] } as never;
      return buildScene(sceneMap, { size: 20, visible, labels: false, style }).prims;
    };
    for (const population of [5_000, 120_000, 1_000_000]) {
      const prims = draw(population, true);
      assert.equal(prims.filter((p) => p.kind === 'circle' && p.fill === style.palette.river && p.stroke === style.palette.cityRing).length, 0, `${cityMarkers}: no disc of water round the marker`);
      assert.ok(prims.some((p) => p.kind === 'polygon' && p.fill === style.palette.cityFill) || prims.some((p) => p.kind === 'path' && p.fill === style.palette.cityFill), `${cityMarkers}: the icon is drawn`);
    }
  }
});

test('a river can be held to come no nearer, and no further, than a set distance from the centre of each hex it runs through', async () => {
  const { pixelToOffset } = await import('../shared/hex.ts');
  const size = 40;
  const apothem = size * Math.sqrt(3) / 2;
  const segs = [0, 1, 2, 3, 4, 5, 6, 7].map((col) => ({ col, row: 3, entryEdge: col === 0 ? null : 3, exitEdge: 0, navigable: false }));
  const river = { id: 'reach', name: 'Reach', terminus: 'OffMap' as const, segments: segs };
  /** The nearest the drawn line comes to each middle hex's centre, as a fraction of the way to the edge. */
  const nearest = (line: Array<{ x: number; y: number }>): number[] =>
    segs.slice(2, 6).map((s) => {
      const c = hexCenter(s.col, s.row, size);
      let best = Infinity;
      for (const p of line) {
        const h = pixelToOffset(p.x, p.y, size);
        if (h.col === s.col && h.row === s.row) best = Math.min(best, Math.hypot(p.x - c.x, p.y - c.y) / apothem);
      }
      return best;
    });
  for (const wander of ['gentle', 'irregular', 'wild'] as const) {
    const free = riverCourse(river, size, 'reach', { wander })!.centreline;
    const loose = riverCourse(river, size, 'reach', { wander, reach: { min: null, max: null } })!.centreline;
    assert.deepEqual(free, loose, 'no bounds changes nothing');
    for (const max of [0, 0.2, 0.5]) {
      const near = nearest(riverCourse(river, size, 'reach', { wander, reach: { min: null, max } })!.centreline);
      for (const d of near) assert.ok(d <= max + 0.06, `${wander}: max ${max}, came no nearer than ${d.toFixed(2)}`);
    }
    for (const min of [0.3, 0.6, 0.9]) {
      const near = nearest(riverCourse(river, size, 'reach', { wander, reach: { min, max: null } })!.centreline);
      for (const d of near) assert.ok(d >= min - 0.06, `${wander}: min ${min}, came as near as ${d.toFixed(2)}`);
    }
    const both = nearest(riverCourse(river, size, 'reach', { wander, reach: { min: 0.4, max: 0.6 } })!.centreline);
    for (const d of both) assert.ok(d >= 0.34 && d <= 0.66, `${wander}: between 0.4 and 0.6, got ${d.toFixed(2)}`);
  }
});

test('the river reach settings offer any distance, or 0 to 90 per cent', () => {
  for (const knob of ['riverMin', 'riverMax'] as const) {
    const values = KNOB_OPTIONS[knob].options.map((o) => o.value);
    assert.deepEqual(values, ['any', 0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    for (const id of PRESET_ORDER) assert.equal(PRESETS[id].knobs[knob], 'any');
    assert.equal(parseStyleChoice({ preset: 'classic', overrides: { [knob]: 40 } }).overrides[knob], 40);
    assert.equal(parseStyleChoice({ preset: 'classic', overrides: { [knob]: 95 } }).overrides[knob], undefined);
  }
});

test('realm borders are cut to the drawn land, the frontier and the dashed part lines included', () => {
  const map = createMapState('Dry', 5, 3);
  map.layers.base.data = ['Sea', 'Land', 'Land', 'Land', 'Sea', 'Sea', 'Land', 'Lake', 'Land', 'Sea', 'Sea', 'Land', 'Land', 'Land', 'Sea'];
  map.layers.polities.data = {
    polities: [{ id: 'k', name: 'K', colour: '#336699' }, { id: 'a', name: 'A', colour: '#aa3333', parentId: 'k' }, { id: 'b', name: 'B', colour: '#3355aa', parentId: 'k' }, { id: 'c', name: 'C', colour: '#33aa55' }],
    owner: [null, 'a', 'a', 'c', null, null, 'a', 'b', 'c', null, null, 'b', 'b', 'c', null],
  };
  const visible = defaultVisibility();
  visible.polities = true;
  const style = resolveStyle({ preset: 'parchment', overrides: { polityStyle: 'wash', frontier: 'solid' } });
  const prims = buildScene(map, { size: 20, visible, labels: false, style }).prims;
  const unclipped = prims.filter((p) => p.kind === 'path' && p.stroke === style.palette.frontier);
  assert.equal(unclipped.length, 0, 'no border line is drawn outside a clip');
  const clipped = flatPrims(prims).filter((p) => p.kind === 'path' && p.stroke === style.palette.frontier);
  assert.ok(clipped.some((p) => p.kind === 'path' && !p.dash), 'the frontier is drawn');
  assert.ok(clipped.some((p) => p.kind === 'path' && p.dash), 'the part line is drawn');
});
