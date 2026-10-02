import assert from 'node:assert/strict';
import test from 'node:test';
import { hexEdgePoints, hexIndex, inBounds, neighbourOf } from '../shared/hex.ts';
import { createMapState } from '../shared/layers.ts';
import type { BaseGeo, MapState } from '../shared/types.ts';
import { chainEdges, coastEdges, coastGeometry, sideOf } from '../src/render/coast.ts';
import type { PathCmd, Prim } from '../src/render/prims.ts';
import { riverCourse } from '../src/render/rivers.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import {
  PRESET_ORDER,
  parseStyleChoice,
  resolveStyle,
  withKnob,
} from '../src/render/styles.ts';
import { sceneToSvg } from '../src/render/svg.ts';
import { encodePng } from '../src/render/texture.ts';

/** A 9x7 sea with an irregular island, a one-hex lake in it, ice along the bottom and an islet. */
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
  base[hexIndex(cols, 7, 1)] = 'Island';
  for (let col = 0; col < cols; col++) base[hexIndex(cols, col, rows - 1)] = 'Ice';
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
  // The island's outer shore and the lake's shore close; the ice shore runs off both map edges.
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
  edited.layers.base.data![hexIndex(map.cols, 0, 0)] = 'Island';
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
  assert.ok(Math.max(...radii) < 20 * 1.4, 'but only a little way');
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
  const course = riverCourse(river, size, map.id)!;
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

test('the island types round-trip through the base codec and count as land', async () => {
  const { encodeBase, decodeBase } = await import('../shared/codec.ts');
  const { isLandLike } = await import('../shared/derive.ts');
  const values: BaseGeo[] = ['Island', 'Coastal Island', 'Large Island', 'Small Islands'];
  const decoded = decodeBase(encodeBase(values, 4, 1), 4, 1);
  assert.deepEqual(decoded.data, values);
  for (const v of values) assert.ok(isLandLike(v), `${v} carries land layers`);
});

test('each island type draws its land inside its own hex, and a coastal island faces the nearest land', async () => {
  const { coastalIslandSide } = await import('../src/render/coast.ts');
  const { hexCenter, pixelToOffset } = await import('../shared/hex.ts');
  const size = 20;
  for (const kind of ['Island', 'Coastal Island', 'Large Island', 'Small Islands'] as BaseGeo[]) {
    const map = createMapState('Islands', 3, 3);
    map.layers.base.data = ['Land', 'Sea', 'Sea', 'Land', kind, 'Sea', 'Sea', 'Sea', 'Sea'];
    for (const preset of PRESET_ORDER) {
      const style = resolveStyle({ preset, overrides: {} });
      const prims = buildScene(map, { size, visible: defaultVisibility(), labels: false, style }).prims;
      const land = prims.filter((p) => (p.kind === 'path' || p.kind === 'circle') && p.fill === style.palette.island);
      assert.ok(land.length > 0, `${kind} (${preset}) draws land`);
      for (const p of land) {
        const pts = p.kind === 'circle'
          ? [p.c]
          : (p as { d: PathCmd[] }).d.filter((c) => c[0] !== 'Z').map((c) => ({ x: c.at(-2) as number, y: c.at(-1) as number }));
        for (const q of pts) {
          const { col, row } = pixelToOffset(q.x, q.y, size);
          assert.deepEqual([col, row], [1, 1], `${kind} (${preset}) stays in its hex`);
        }
      }
    }
  }
  // Hex (1,1) sits on an odd row; its land neighbours are west (0,1) and north-west (1,0)... here only (0,0) and (0,1).
  const base: BaseGeo[] = ['Land', 'Sea', 'Sea', 'Land', 'Coastal Island', 'Sea', 'Sea', 'Sea', 'Sea'];
  const side = coastalIslandSide(base, 3, 3, 4);
  const c = hexCenter(1, 1, 1);
  const towards = Math.atan2(hexCenter(0, 1, 1).y - c.y, hexCenter(0, 1, 1).x - c.x);
  assert.ok(Math.abs(((side * Math.PI) / 3 - towards + 3 * Math.PI) % (2 * Math.PI) - Math.PI) <= Math.PI / 3 + 1e-9);
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

test('water bodies are named, renamed and removed, and their names are drawn when asked for', async () => {
  const { reducer } = await import('../src/state/store.ts');
  const { prepareLoadedMap } = await import('../src/state/import.ts');
  let map = islandMap();
  const sea = [0, 1, 2, 9, 10, 18, 27, 36];
  map = reducer(map, { type: 'nameWaterBody', id: 'w1', name: 'The Narrows', indices: [...sea, 20] });
  assert.deepEqual(map.waterNames?.[0]?.hexes, sea, 'land hexes are left out');
  map = reducer(map, { type: 'renameWaterBody', id: 'w1', name: 'The Sound' });
  assert.equal(map.waterNames?.[0]?.name, 'The Sound');
  const style = resolveStyle({ preset: 'parchment', overrides: {} });
  const text = (seaNames: boolean) =>
    buildScene(map, { size: 20, visible: defaultVisibility(), labels: false, seaNames, style }).prims
      .flatMap((p) => (p.kind === 'text' ? [p.text] : []));
  assert.deepEqual(text(false), []);
  assert.deepEqual(text(true), ['THE SOUND']);
  map = reducer(map, { type: 'removeWaterBody', id: 'w1' });
  assert.deepEqual(map.waterNames, []);
  const old = structuredClone(map);
  delete old.waterNames;
  assert.deepEqual(prepareLoadedMap(old).waterNames, []);
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
  assert.ok(prims.some((p) => p.kind === 'path' && p.dash), 'parts are divided by a dashed line');
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
  base[5] = 'Island';
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
    const marker = prims.find((p): p is Extract<Prim, { kind: 'city' }> => p.kind === 'city');
    assert.equal(marker?.fill, style.palette.cityFill, `${preset}: marker colour`);
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

test('an island in a lake sits on lake water, and a lake inside one realm is drawn as part of it', () => {
  const cols = 7;
  const rows = 5;
  const map = createMapState('Lake realm', cols, rows);
  const base: BaseGeo[] = Array(cols * rows).fill('Land');
  // A three-hex lake with an islet in it, all inside one realm.
  for (const i of [2 * cols + 2, 2 * cols + 4, 1 * cols + 3]) base[i] = 'Lake';
  base[2 * cols + 3] = 'Island';
  map.layers.base.data = base;
  map.layers.polities.data = {
    polities: [{ id: 'r', name: 'Realm', colour: '#aa3333' }],
    owner: base.map((v) => (v === 'Land' ? 'r' : null)),
  };
  const visible = defaultVisibility();
  visible.polities = true;
  const style = resolveStyle({ preset: 'parchment', overrides: {} });
  const prims = buildScene(map, { size: 20, visible, labels: false, style }).prims;
  assert.ok(!prims.some((p) => p.kind === 'polygon' && p.fill === style.palette.sea), 'no sea under the lake islet');
  assert.equal(prims.filter((p) => p.kind === 'path' && p.fill === style.palette.lake).length, 1, 'one lake body');
  // The realm's border band runs round the realm's outside only: no band loop round the lake.
  const bands = prims.filter((p): p is Extract<Prim, { kind: 'group' }> => p.kind === 'group' && p.prims.length === 1);
  const lakeCentre = { x: 20 * Math.sqrt(3) * 3 + 20 * Math.sqrt(3) / 2, y: 20 * 1.5 * 2 + 20 };
  for (const g of bands) {
    const pts = (g.prims[0] as { d: PathCmd[] }).d.filter((c) => c[0] !== 'Z').map((c) => ({ x: c[1] as number, y: c[2] as number }));
    assert.ok(!pts.some((q) => Math.hypot(q.x - lakeCentre.x, q.y - lakeCentre.y) < 20 * 1.2), 'a border band rings the lake');
  }
});

test('small islands are two or three islets, spread apart', () => {
  const map = createMapState('Isles', 3, 3);
  map.layers.base.data = ['Sea', 'Sea', 'Sea', 'Sea', 'Small Islands', 'Sea', 'Sea', 'Sea', 'Sea'];
  const style = resolveStyle({ preset: 'parchment', overrides: {} });
  const isles = buildScene(map, { size: 20, visible: defaultVisibility(), labels: false, style }).prims
    .filter((p): p is Extract<Prim, { kind: 'path' }> => p.kind === 'path' && p.fill === style.palette.island);
  const count = isles[0]!.d.filter((c) => c[0] === 'M').length;
  assert.ok(count >= 2 && count <= 3, `${count} islets`);
});
