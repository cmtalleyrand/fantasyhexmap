import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { landFraction, normaliseHexDimensions, politySurfaceAreas } from '../shared/surfaceArea.ts';
import { DEFAULT_HEX_DIMENSIONS, hexShapeFor, type BaseGeo, type MapState } from '../shared/types.ts';
import { reducer } from '../src/state/store.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';
import { coastGeometryOf, coastEdges } from '../src/render/coast.ts';
import type { PathCmd, Prim } from '../src/render/prims.ts';

const dims = DEFAULT_HEX_DIMENSIONS;

test('each shaped type has its default land share', () => {
  const share = (v: BaseGeo, spec?: { large: number; small: number }) => landFraction(v, spec, dims);
  assert.equal(share('Land'), 1);
  assert.equal(share('Coastal Land'), 0.9);
  assert.equal(share('Isthmus'), 0.3);
  assert.equal(share('Strait'), 0.4);
  assert.equal(share('Glacier'), 1);
  assert.equal(share('Sea Ice'), 0);
  assert.equal(share('Sea'), 0);
  // Small islands take 10% each, large ones 20% each.
  assert.equal(share('Islands', { large: 0, small: 1 }), 0.1);
  assert.equal(share('Islands', { large: 1, small: 0 }), 0.2);
  assert.equal(Number(share('Islands', { large: 2, small: 5 }).toFixed(10)), 0.9);
  // Any mainland takes 30% before its islands are added.
  assert.equal(share('Mainland and islands', { large: 0, small: 2 }), 0.5);
  assert.equal(share('Mainland and islands', { large: 1, small: 1 }), 0.6);
});

test('a hex that sets its own land share takes it, within 0 to 100', () => {
  const own = (land: number) => landFraction('Coastal Land', undefined, dims, { type: 'Coastal Land', land });
  assert.equal(own(55), 0.55);
  assert.equal(own(250), 1);
  assert.equal(own(-5), 0);
  // An island hex's own share replaces the sum of its islands.
  assert.equal(landFraction('Islands', { large: 2, small: 0 }, dims, { type: 'Islands', land: 25 }), 0.25);
  // Settings made for another type are ignored once the hex changes.
  assert.equal(landFraction('Strait', undefined, dims, { type: 'Coastal Land', land: 55 }), 0.4);
  // Sea ice has no land share to set.
  assert.equal(landFraction('Sea Ice', undefined, dims, { type: 'Sea Ice', land: 80 }), 0);
});

test('irregularity defaults keep the old drawing and ignore settings for another type', () => {
  assert.equal(hexShapeFor('Coastal Land', undefined).irregular, 'Smooth');
  assert.equal(hexShapeFor('Islands', undefined).irregular, 'Wavy');
  assert.equal(hexShapeFor('Glacier', undefined).irregular, 'Wavy');
  assert.equal(hexShapeFor('Coastal Land', { type: 'Coastal Land', irregular: 'Fractured' }).irregular, 'Fractured');
  assert.equal(hexShapeFor('Strait', { type: 'Coastal Land', irregular: 'Fractured' }).irregular, 'Smooth');
  // A value that is not one of the four falls back to the type's default.
  assert.equal(hexShapeFor('Coastal Land', { type: 'Coastal Land', irregular: 'Wild' as never }).irregular, 'Smooth');
});

test('polity areas count each hex by its land share', () => {
  const areas = politySurfaceAreas(
    ['Coastal Land', 'Strait', 'Coastal Land'],
    { polities: [{ id: 'r', name: 'R', colour: '#123456' }], owner: ['r', 'r', 'r'] },
    { ...dims, width: 10, height: 6 / 0.75 / 10 * 10 },
    undefined,
    { '2': { type: 'Coastal Land', land: 50 } },
  );
  // Hex area is 10 * 8 * 0.75 = 60: 0.9 + 0.4 + 0.5 of it.
  assert.equal(areas.get('r'), 60 * 1.8);
});

test('dimensions saved with the old defaults take the new ones, and a chosen island share keeps its ratio', () => {
  const old = { width: 10, height: 11.5, unit: 'km', coastalLandPercent: 60, islandLandPercent: 40, areaRounding: 100, lengthRounding: 10 };
  const migrated = normaliseHexDimensions(old);
  assert.equal(migrated.coastalLandPercent, 90);
  assert.equal(migrated.smallIslandPercent, 10);
  assert.equal(migrated.largeIslandPercent, 20);
  assert.ok(!('islandLandPercent' in migrated));
  const chosen = normaliseHexDimensions({ ...old, coastalLandPercent: 50, islandLandPercent: 60 });
  assert.equal(chosen.coastalLandPercent, 50, 'a share someone chose is kept');
  assert.equal(chosen.smallIslandPercent, 15);
  assert.equal(chosen.largeIslandPercent, 30);
  // Dimensions that already carry the new fields are left alone.
  assert.equal(normaliseHexDimensions({ ...dims, coastalLandPercent: 70 }).coastalLandPercent, 70);
});

function mapWith(base: BaseGeo[], cols = base.length, rows = 1): MapState {
  const map = createMapState('Shapes', cols, rows);
  map.layers.base.data = base;
  return map;
}

test('shape settings are applied to shaped hexes only, and can be cleared', () => {
  const map = mapWith(['Land', 'Coastal Land', 'Islands', 'Sea Ice', 'Sea']);
  const set = reducer(map, { type: 'setHexShape', indices: [0, 1, 2, 3, 4], change: { land: 40, irregular: 'Ragged' } });
  assert.deepEqual(set.hexShapes, {
    '1': { type: 'Coastal Land', land: 40, irregular: 'Ragged' },
    '2': { type: 'Islands', land: 40, irregular: 'Ragged' },
    // Sea Ice has irregularity but no land share.
    '3': { type: 'Sea Ice', irregular: 'Ragged' },
  });
  assert.equal(set.journal.at(-1)?.kind, 'manual');

  const partial = reducer(set, { type: 'setHexShape', indices: [1], change: { land: null } });
  assert.deepEqual(partial.hexShapes!['1'], { type: 'Coastal Land', irregular: 'Ragged' });
  const emptied = reducer(partial, { type: 'setHexShape', indices: [1], change: { irregular: null } });
  assert.equal('1' in emptied.hexShapes!, false);

  const reset = reducer(set, { type: 'setHexShape', indices: [1, 2, 3], change: null });
  assert.deepEqual(reset.hexShapes, {});
  // Nothing to change: the same map comes back.
  assert.equal(reducer(reset, { type: 'setHexShape', indices: [1, 2, 3], change: null }), reset);
  assert.equal(reducer(map, { type: 'setHexShape', indices: [0, 4], change: { land: 10 } }), map);
});

test('a hex that changes type stops using the settings made for its old type', () => {
  const map = mapWith(['Coastal Land', 'Sea']);
  const set = reducer(map, { type: 'setHexShape', indices: [0], change: { land: 40 } });
  const changed = { ...set, layers: { ...set.layers, base: { ...set.layers.base, data: ['Strait', 'Sea'] as BaseGeo[] } } };
  assert.equal(landFraction(changed.layers.base.data![0], undefined, dims, changed.hexShapes!['0']), 0.4, 'the strait share, not the 40% set for coastal land');
  // And a change on the new type starts afresh rather than inheriting the old land share.
  const again = reducer(changed, { type: 'setHexShape', indices: [0], change: { irregular: 'Ragged' } });
  assert.deepEqual(again.hexShapes!['0'], { type: 'Strait', irregular: 'Ragged' });
});

/* ------------------------------------------------------------ drawing */

const smooth = resolveStyle({ preset: 'parchment', overrides: { coast: 'smooth' } });

function scene(map: MapState, style = smooth) {
  return buildScene(map, { size: 30, visible: defaultVisibility(), labels: false, style });
}

function commandCount(prims: Prim[]): number {
  return JSON.stringify(prims).length;
}

test('a smooth coast is drawn exactly as it was before irregularity existed', () => {
  const base: BaseGeo[] = ['Sea', 'Coastal Land', 'Land', 'Coastal Land', 'Sea', 'Sea', 'Coastal Land', 'Land', 'Coastal Land', 'Sea'];
  const plain = mapWith(base, 5, 2);
  const explicit = { ...plain, hexShapes: Object.fromEntries(base.map((v, i) => [String(i), { type: v, irregular: 'Smooth' as const }]).filter(([, s]) => (s as { type: string }).type === 'Coastal Land')) };
  assert.equal(commandCount(scene(explicit).prims), commandCount(scene(plain).prims));
  const rough = { ...plain, hexShapes: Object.fromEntries(base.map((v, i) => [String(i), { type: v, irregular: 'Fractured' as const }]).filter(([, s]) => (s as { type: string }).type === 'Coastal Land')) };
  assert.notEqual(commandCount(scene(rough).prims), commandCount(scene(plain).prims));
});

test('the map default irregularity applies to hexes with none of their own, and to nothing unshaped', () => {
  assert.equal(hexShapeFor('Coastal Land', undefined, 'Ragged').irregular, 'Ragged');
  assert.equal(hexShapeFor('Islands', undefined, 'Smooth').irregular, 'Smooth');
  assert.equal(hexShapeFor('Coastal Land', { type: 'Coastal Land', land: 50 }, 'Ragged').irregular, 'Ragged');
  // A hex's own setting wins, as does nothing for a stale one set for another type.
  assert.equal(hexShapeFor('Coastal Land', { type: 'Coastal Land', irregular: 'Smooth' }, 'Ragged').irregular, 'Smooth');
  assert.equal(hexShapeFor('Strait', { type: 'Coastal Land', irregular: 'Smooth' }, 'Ragged').irregular, 'Ragged');
  assert.equal(hexShapeFor('Land', undefined, 'Ragged').irregular, 'Smooth');
  assert.equal(hexShapeFor('Coastal Land', undefined, null).irregular, 'Smooth');
});

test('changing the default irregularity redraws default hexes only', () => {
  const base: BaseGeo[] = ['Sea', 'Coastal Land', 'Land', 'Coastal Land', 'Sea', 'Sea', 'Coastal Land', 'Land', 'Coastal Land', 'Sea'];
  const plain = mapWith(base, 5, 2);
  const rough = reducer(plain, { type: 'setDefaultIrregularity', irregular: 'Fractured' });
  assert.equal(rough.defaultIrregularity, 'Fractured');
  assert.notEqual(commandCount(scene(rough).prims), commandCount(scene(plain).prims));
  // Every coast hex pinned to Smooth by hand ignores the default.
  const pinned = { ...rough, hexShapes: Object.fromEntries(base.map((v, i) => [String(i), { type: v, irregular: 'Smooth' as const }]).filter(([, s]) => (s as { type: string }).type === 'Coastal Land')) };
  assert.equal(commandCount(scene(pinned).prims), commandCount(scene(plain).prims));
  const back = reducer(rough, { type: 'setDefaultIrregularity', irregular: null });
  assert.equal('defaultIrregularity' in back, false);
  assert.equal(commandCount(scene(back).prims), commandCount(scene(plain).prims));
});

test('a roughened coast still passes through the midpoint of every coast edge, and corrects the fills it crosses', () => {
  const base: BaseGeo[] = Array.from({ length: 36 }, (_, i) => ((i % 6) < 3 ? 'Coastal Land' : 'Sea'));
  const size = 30;
  const edges = coastEdges(base, 6, 6, size);
  const noise = (x: number, y: number, k: number) => ((Math.sin(x * 12.9898 + y * 78.233 + k * 3.1) * 43758.5453) % 1 + 1) % 1;
  const plain = coastGeometryOf(edges, true);
  const rough = coastGeometryOf(edges, true, { size, noise, amplitude: () => 0.2 });
  assert.equal(plain.chains.length, rough.chains.length);
  const points = (d: PathCmd[]) => d.flatMap((c) => (c[0] === 'L' || c[0] === 'M' ? [[c[1], c[2]]] : c[0] === 'Q' ? [[c[3], c[4]]] : []));
  const near = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!) < 1e-6;
  rough.chains.forEach((chain, c) => {
    const onPath = points(rough.paths[c]!);
    for (const edge of chain.edges) {
      const mid = [(edge.from.x + edge.to.x) / 2, (edge.from.y + edge.to.y) / 2];
      assert.ok(onPath.some((p) => near(p, mid)), 'the coast keeps the midpoint of each edge');
    }
  });
  // The roughened coast strays further, so more of the map's fill needs correcting.
  const area = (slivers: Array<{ d: PathCmd[] }>) => slivers.reduce((sum, s) => sum + s.d.length, 0);
  assert.ok(area(rough.toLand) + area(rough.toWater) > area(plain.toLand) + area(plain.toWater));
});

test('irregularity changes how islands are drawn and a land share changes how big they are', () => {
  const base: BaseGeo[] = ['Sea', 'Islands', 'Sea'];
  const map = mapWith(base);
  const spans = (m: MapState) => {
    const prims = scene(m).prims;
    const xs: number[] = [];
    const walk = (list: Prim[]) => {
      for (const p of list) {
        if (p.kind === 'group') walk(p.prims);
        else if (p.kind === 'path' && p.fill === smooth.palette.island) for (const c of p.d) if (c[0] !== 'Z') xs.push(c[c.length - 2] as number);
      }
    };
    walk(prims);
    return Math.max(...xs) - Math.min(...xs);
  };
  const usual = spans(map);
  const bigger = spans({ ...map, hexShapes: { '1': { type: 'Islands', land: 40 } } });
  const smaller = spans({ ...map, hexShapes: { '1': { type: 'Islands', land: 8 } } });
  assert.ok(bigger > usual, 'a larger share draws larger islands');
  assert.ok(smaller < usual, 'a smaller share draws smaller ones');
  const fractured = scene({ ...map, hexShapes: { '1': { type: 'Islands', irregular: 'Fractured' } } }).prims;
  assert.notEqual(commandCount(fractured), commandCount(scene(map).prims));
});

test('sea ice is one organic body that follows the hex edges only in a hex-edged coast style', () => {
  const base: BaseGeo[] = ['Sea Ice', 'Sea Ice', 'Sea Ice', 'Sea', 'Sea', 'Sea'];
  const map = mapWith(base, 3, 2);
  const body = (style: typeof smooth) => {
    const prims = scene(map, style).prims;
    const group = prims.find((p) => p.kind === 'group' && p.prims.some((q) => q.kind === 'path' && q.fill === style.palette.seaIce)) as Extract<Prim, { kind: 'group' }>;
    assert.ok(group, 'the pack is drawn');
    return (group.prims.find((q) => q.kind === 'path' && q.fill === style.palette.seaIce) as Extract<Prim, { kind: 'path' }>).d;
  };
  const curved = body(smooth);
  assert.ok(curved.some((c) => c[0] === 'Q' || c[0] === 'L'), 'has an outline');
  const hexy = body(resolveStyle({ preset: 'parchment', overrides: { coast: 'hex' } }));
  assert.ok(hexy.every((c) => c[0] !== 'Q'), 'a hex-edged coast keeps the pack on the hex edges');
  // Ice at the map's edge runs right out to it: the outline is a closed loop.
  assert.ok(curved.filter((c) => c[0] === 'Z').length >= 1);
});

test('a glacier that is Smooth sheds no icebergs and a Fractured one does', () => {
  const base: BaseGeo[] = ['Glacier', 'Glacier', 'Glacier', 'Sea', 'Sea', 'Sea'];
  const map = mapWith(base, 3, 2);
  const style = resolveStyle({ preset: 'parchment', overrides: { coast: 'smooth', ice: 'glacier' } });
  const floes = (m: MapState) => {
    const count = (list: Prim[]): number => list.reduce((n, p) => n + (p.kind === 'group' ? count(p.prims) : p.kind === 'polygon' && p.points.length >= 5 && p.points.length <= 7 && p.stroke !== undefined ? 1 : 0), 0);
    return count(scene(m, style).prims);
  };
  const calm = floes({ ...map, hexShapes: Object.fromEntries([0, 1, 2].map((i) => [String(i), { type: 'Glacier' as const, irregular: 'Smooth' as const }])) });
  const broken = floes({ ...map, hexShapes: Object.fromEntries([0, 1, 2].map((i) => [String(i), { type: 'Glacier' as const, irregular: 'Fractured' as const }])) });
  assert.ok(broken > calm, `fractured ice sheds bergs (${broken} against ${calm})`);
});

test('resizing the map moves shape settings with their hexes', () => {
  const base: BaseGeo[] = ['Sea', 'Sea', 'Coastal Land', 'Sea'];
  const map = { ...mapWith(base, 2, 2), hexShapes: { '2': { type: 'Coastal Land' as const, land: 70 } } };
  const grown = reducer(map, { type: 'growMap', amounts: { right: 1 } });
  // Hex (0, 1) was index 2 on a 2-wide grid and is index 3 on a 3-wide one.
  assert.deepEqual(grown.hexShapes, { '3': { type: 'Coastal Land', land: 70 } });
});

test('a lake shore is drawn ragged by default, follows its own map default, and honours a hex set by hand', () => {
  const base: BaseGeo[] = Array.from({ length: 25 }, (_, i) => (i === 12 ? 'Lake' : 'Land'));
  const plain = mapWith(base, 5, 5);
  assert.equal(plain.defaultLakeIrregularity, undefined);
  const lakeShape = (map: MapState) => JSON.stringify(scene(map).prims.filter((p) => p.kind === 'path' && p.fill === smooth.palette.lake));
  const ragged = lakeShape(plain);
  const asRagged = lakeShape(reducer(plain, { type: 'setDefaultLakeIrregularity', irregular: 'Ragged' }));
  assert.equal(asRagged, ragged, 'Ragged is the usual lake default');
  const smoothLake = reducer(plain, { type: 'setDefaultLakeIrregularity', irregular: 'Smooth' });
  assert.equal(smoothLake.defaultLakeIrregularity, 'Smooth');
  assert.notEqual(lakeShape(smoothLake), ragged);
  assert.notEqual(lakeShape(reducer(plain, { type: 'setDefaultLakeIrregularity', irregular: 'Fractured' })), ragged);
  // The sea coast default does not move a lake's shore.
  assert.equal(lakeShape(reducer(plain, { type: 'setDefaultIrregularity', irregular: 'Fractured' })), ragged);
  // Land set to Smooth by hand on every side of the lake overrides the lake default.
  const around = [6, 7, 8, 11, 13, 16, 17, 18];
  const pinned = { ...plain, hexShapes: Object.fromEntries(around.map((i) => [String(i), { type: 'Land' as const, irregular: 'Smooth' as const }])) };
  assert.equal(lakeShape(pinned), ragged, 'Land is not a shaped type, so a stored setting is ignored');
  const coastal = mapWith(base.map((v) => (v === 'Land' ? 'Coastal Land' : v)), 5, 5);
  const coastalPinned = { ...coastal, hexShapes: Object.fromEntries(around.map((i) => [String(i), { type: 'Coastal Land' as const, irregular: 'Smooth' as const }])) };
  assert.equal(lakeShape(coastalPinned), lakeShape(reducer(coastal, { type: 'setDefaultLakeIrregularity', irregular: 'Smooth' })));
  assert.notEqual(lakeShape(coastalPinned), lakeShape(coastal));
  const back = reducer(smoothLake, { type: 'setDefaultLakeIrregularity', irregular: null });
  assert.equal('defaultLakeIrregularity' in back, false);
  assert.equal(lakeShape(back), ragged);
});
