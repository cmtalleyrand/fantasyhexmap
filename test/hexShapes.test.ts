import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { landFraction, normaliseHexDimensions, politySurfaceAreas } from '../shared/surfaceArea.ts';
import { CHANNEL_WIDTH_PERCENT, CHANNEL_WIDTH_VALUES, DEFAULT_HEX_DIMENSIONS, hexShapeFor, type BaseGeo, type ChannelWidth, type MapState } from '../shared/types.ts';
import { reducer } from '../src/state/store.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';
import { coastGeometryOf, coastEdges, landInsetDepth, surfaceMap } from '../src/render/coast.ts';
import { coveredArea, nearestHex, shapeCoast } from '../src/render/footprint.ts';
import { pathPolylines } from '../src/render/ice.ts';
import { hexCenter, hexCorners } from '../shared/hex.ts';
import type { PathCmd, Prim } from '../src/render/prims.ts';

const dims = DEFAULT_HEX_DIMENSIONS;

test('each shaped type has its default land share', () => {
  const share = (v: BaseGeo, spec?: { large: number; small: number }) => landFraction(v, spec, dims);
  assert.equal(share('Land'), 1);
  assert.equal(share('Coastal Land'), 0.9);
  // An isthmus or strait is drawn at a width (30% of the hex's by default), not to a share: it counts
  // the share of a straight neck or channel that wide, 2/sqrt(3) of the width.
  assert.ok(Math.abs(share('Isthmus') - 0.3 * 2 / Math.sqrt(3)) < 1e-12);
  assert.ok(Math.abs(share('Strait') - (1 - 0.3 * 2 / Math.sqrt(3))) < 1e-12);
  assert.equal(share('Glacier'), 1);
  assert.equal(share('Sea Ice'), 0);
  assert.equal(share('Sea'), 0);
  // Small islands take 5% each, large ones 20% each.
  assert.equal(share('Islands', { large: 0, small: 1 }), 0.05);
  assert.equal(share('Islands', { large: 1, small: 0 }), 0.2);
  assert.equal(Number(share('Islands', { large: 2, small: 6 }).toFixed(10)), 0.7);
  // Any mainland takes 30% before its islands are added.
  assert.equal(share('Mainland and islands', { large: 0, small: 2 }), 0.4);
  assert.equal(share('Mainland and islands', { large: 1, small: 1 }), 0.55);
});

test('a hex that sets its own land share takes it, within 0 to 100', () => {
  const own = (land: number) => landFraction('Coastal Land', undefined, dims, { type: 'Coastal Land', land });
  assert.equal(own(55), 0.55);
  assert.equal(own(250), 1);
  assert.equal(own(-5), 0);
  // An island hex's own share replaces the sum of its islands.
  assert.equal(landFraction('Islands', { large: 2, small: 0 }, dims, { type: 'Islands', land: 25 }), 0.25);
  // Settings made for another type are ignored once the hex changes.
  assert.equal(landFraction('Strait', undefined, dims, { type: 'Coastal Land', land: 55 }), landFraction('Strait', undefined, dims));
  // An isthmus or strait has a land share as well as a width: a share set on it is used, and one for another type is not.
  assert.equal(landFraction('Isthmus', undefined, dims, { type: 'Isthmus', land: 55 }), 0.55);
  assert.equal(landFraction('Isthmus', undefined, { ...dims, isthmusPercent: 80 }), 0.8);
  assert.equal(landFraction('Isthmus', undefined, { ...dims, isthmusPercent: 80 }, { type: 'Isthmus', land: 55 }), 0.55);
  // Sea ice has no land share to set.
  assert.equal(landFraction('Sea Ice', undefined, dims, { type: 'Sea Ice', land: 80 }), 0);
});

test('every shaped type is Ragged by default, and settings made for another type are ignored', () => {
  for (const type of ['Coastal Land', 'Islands', 'Mainland and islands', 'Isthmus', 'Strait', 'Glacier', 'Sea Ice'] as BaseGeo[]) {
    assert.equal(hexShapeFor(type, undefined).irregular, 'Ragged', type);
  }
  assert.equal(hexShapeFor('Coastal Land', { type: 'Coastal Land', irregular: 'Fractured' }).irregular, 'Fractured');
  assert.equal(hexShapeFor('Strait', { type: 'Coastal Land', irregular: 'Fractured' }).irregular, 'Ragged');
  // A value that is not one of the four falls back to the type's default.
  assert.equal(hexShapeFor('Coastal Land', { type: 'Coastal Land', irregular: 'Wild' as never }).irregular, 'Ragged');
});

test('polity areas count each hex by its land share', () => {
  const areas = politySurfaceAreas(
    ['Coastal Land', 'Strait', 'Coastal Land'],
    { polities: [{ id: 'r', name: 'R', colour: '#123456' }], owner: ['r', 'r', 'r'] },
    { ...dims, width: 10, height: 6 / 0.75 / 10 * 10 },
    undefined,
    { '2': { type: 'Coastal Land', land: 50 } },
  );
  // Hex area is 10 * 8 * 0.75 = 60: 0.9 + the strait's banks + 0.5 of it.
  assert.ok(Math.abs(areas.get('r')! - 60 * (0.9 + landFraction('Strait', undefined, dims) + 0.5)) < 1e-9);
});

test('dimensions saved with the old defaults take the new ones, and a chosen island share keeps its ratio', () => {
  const old = { width: 10, height: 11.5, unit: 'km', coastalLandPercent: 60, islandLandPercent: 40, areaRounding: 100, lengthRounding: 10 };
  const migrated = normaliseHexDimensions(old);
  assert.equal(migrated.coastalLandPercent, 90);
  assert.equal(migrated.smallIslandPercent, 5);
  assert.equal(migrated.largeIslandPercent, 20);
  assert.ok(!('islandLandPercent' in migrated));
  const chosen = normaliseHexDimensions({ ...old, coastalLandPercent: 50, islandLandPercent: 60 });
  assert.equal(chosen.coastalLandPercent, 50, 'a share someone chose is kept');
  assert.equal(chosen.smallIslandPercent, 15);
  assert.equal(chosen.largeIslandPercent, 30);
  // Dimensions that already carry the new fields are left alone.
  assert.equal(normaliseHexDimensions({ ...dims, coastalLandPercent: 70 }).coastalLandPercent, 70);
  assert.equal(normaliseHexDimensions({ ...dims, smallIslandPercent: 0 }).smallIslandPercent, 2.5, 'a small island is at least 2.5% of a hex');
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

test('coastal, mainland and lake hexes store a bounded directional concentration', () => {
  const map = mapWith(['Coastal Land', 'Mainland and islands', 'Lake', 'Islands', 'Strait']);
  const changed = reducer(map, {
    type: 'setHexShape',
    indices: [0, 1, 2, 3, 4],
    change: { concentrationSide: 2, concentration: 140 },
  });
  assert.deepEqual(changed.hexShapes, {
    '0': { type: 'Coastal Land', concentrationSide: 2, concentration: 100 },
    '1': { type: 'Mainland and islands', concentrationSide: 2, concentration: 100 },
    '2': { type: 'Lake', concentrationSide: 2, concentration: 100 },
  });
  assert.equal(hexShapeFor('Coastal Land', changed.hexShapes?.['0']).concentration, 100);
  const cleared = reducer(changed, { type: 'setHexShape', indices: [0], change: { concentrationSide: null, concentration: null } });
  assert.equal(cleared.hexShapes?.['0'], undefined);
});

test('land concentration changes a lake shore without changing its requested area', () => {
  const base: BaseGeo[] = ['Land', 'Land', 'Land', 'Land', 'Lake', 'Land', 'Land', 'Land', 'Land'];
  const map = mapWith(base, 3, 3);
  const plain = scene({ ...map, hexShapes: { '4': { type: 'Lake', land: 40, irregular: 'Smooth' } } });
  const biasedMap: MapState = { ...map, hexShapes: { '4': { type: 'Lake', land: 40, irregular: 'Smooth', concentrationSide: 0, concentration: 100 } } };
  const biased = scene(biasedMap);
  assert.notDeepEqual(biased.prims, plain.prims);
  assert.equal(landFraction('Lake', undefined, dims, biasedMap.hexShapes?.['4']), 0.4);
});

test('land concentration changes coast geometry without changing its requested area', () => {
  const base: BaseGeo[] = ['Sea', 'Coastal Land', 'Sea', 'Sea', 'Sea', 'Sea', 'Sea', 'Sea', 'Sea'];
  const map = mapWith(base, 3, 3);
  const plain = scene({ ...map, hexShapes: { '1': { type: 'Coastal Land', land: 45 } } });
  const biased = scene({ ...map, hexShapes: { '1': { type: 'Coastal Land', land: 45, concentrationSide: 0, concentration: 100 } } });
  assert.notDeepEqual(biased.prims, plain.prims);
  assert.equal(landFraction('Coastal Land', undefined, dims, { type: 'Coastal Land', land: 45, concentrationSide: 0, concentration: 100 }), 0.45);
});

test('island specs allow six small islands and a new random layout without changing land share', () => {
  const map = mapWith(['Islands']);
  const changed = reducer(map, { type: 'setIslandSpec', indices: [0], change: { large: 0, small: 6, layoutSeed: 12345 } });
  assert.deepEqual(changed.islandSpecs?.['0'], {
    large: 0,
    small: 6,
    coastal: { large: false, small: false },
    layoutSeed: 12345,
  });
  assert.equal(landFraction('Islands', changed.islandSpecs?.['0'], dims), 0.3);
  assert.notDeepEqual(scene(changed).prims, scene({ ...changed, islandSpecs: { '0': { ...changed.islandSpecs!['0']!, layoutSeed: 54321 } } }).prims);
});

test('a hex that changes type stops using the settings made for its old type', () => {
  const map = mapWith(['Coastal Land', 'Sea']);
  const set = reducer(map, { type: 'setHexShape', indices: [0], change: { land: 40 } });
  const changed = { ...set, layers: { ...set.layers, base: { ...set.layers.base, data: ['Strait', 'Sea'] as BaseGeo[] } } };
  assert.equal(landFraction(changed.layers.base.data![0], undefined, dims, changed.hexShapes!['0']), landFraction('Strait', undefined, dims), 'the strait share, not the 40% set for coastal land');
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

test('a coast set to Smooth is drawn plain, and a rough one is not', () => {
  const base: BaseGeo[] = ['Sea', 'Coastal Land', 'Land', 'Coastal Land', 'Sea', 'Sea', 'Coastal Land', 'Land', 'Coastal Land', 'Sea'];
  const plain = { ...mapWith(base, 5, 2), defaultIrregularity: 'Smooth' as const };
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
  assert.equal(hexShapeFor('Coastal Land', undefined, null).irregular, 'Ragged');
});

test('changing the default irregularity redraws default hexes only', () => {
  const base: BaseGeo[] = ['Sea', 'Coastal Land', 'Land', 'Coastal Land', 'Sea', 'Sea', 'Coastal Land', 'Land', 'Coastal Land', 'Sea'];
  const plain = { ...mapWith(base, 5, 2), defaultIrregularity: 'Smooth' as const };
  const rough = reducer(plain, { type: 'setDefaultIrregularity', irregular: 'Fractured' });
  assert.equal(rough.defaultIrregularity, 'Fractured');
  assert.notEqual(commandCount(scene(rough).prims), commandCount(scene(plain).prims));
  // Every coast hex pinned to Smooth by hand ignores the default.
  const pinned = { ...rough, hexShapes: Object.fromEntries(base.map((v, i) => [String(i), { type: v, irregular: 'Smooth' as const }]).filter(([, s]) => (s as { type: string }).type === 'Coastal Land')) };
  assert.equal(commandCount(scene(pinned).prims), commandCount(scene({ ...pinned, defaultIrregularity: 'Smooth' }).prims));
  const back = reducer(rough, { type: 'setDefaultIrregularity', irregular: null });
  assert.equal('defaultIrregularity' in back, false);
  assert.equal(commandCount(scene(back).prims), commandCount(scene(reducer(plain, { type: 'setDefaultIrregularity', irregular: null })).prims));
});

test('a roughened coast varies its anchors along coast edges, and corrects the fills it crosses', () => {
  const base: BaseGeo[] = Array.from({ length: 36 }, (_, i) => ((i % 6) < 3 ? 'Coastal Land' : 'Sea'));
  const size = 30;
  const edges = coastEdges(base, 6, 6, size);
  const noise = (x: number, y: number, k: number) => ((Math.sin(x * 12.9898 + y * 78.233 + k * 3.1) * 43758.5453) % 1 + 1) % 1;
  const plain = coastGeometryOf(edges, true);
  const rough = coastGeometryOf(edges, true, { size, noise, amplitude: () => 0.2 });
  assert.equal(plain.chains.length, rough.chains.length);
  const points = (d: PathCmd[]) => d.flatMap((c) => (c[0] === 'L' || c[0] === 'M' ? [[c[1], c[2]]] : c[0] === 'Q' ? [[c[3], c[4]]] : []));
  let shifted = 0;
  rough.chains.forEach((chain, c) => {
    const onPath = points(rough.paths[c]!);
    for (const edge of chain.edges) {
      const mid = [(edge.from.x + edge.to.x) / 2, (edge.from.y + edge.to.y) / 2];
      const dx = edge.to.x - edge.from.x;
      const dy = edge.to.y - edge.from.y;
      const anchor = onPath.find((p) => {
        const cross = dx * (p[1]! - edge.from.y) - dy * (p[0]! - edge.from.x);
        const dot = (p[0]! - edge.from.x) * dx + (p[1]! - edge.from.y) * dy;
        return Math.abs(cross) < 1e-6 && dot > 0 && dot < dx * dx + dy * dy;
      });
      assert.ok(anchor, 'the coast keeps an interior anchor on every crossed edge');
      if (Math.hypot(anchor[0]! - mid[0]!, anchor[1]! - mid[1]!) > size * 0.01) shifted++;
    }
  });
  assert.ok(shifted > edges.length / 2, 'edge anchors do not repeat the hex midpoint rhythm');
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

/**
 * The share of hex 0 that its drawn islands visibly take: their land and the outer half of the coast's ink round
 * it, found by testing a grid of points rather than by the renderer's own area estimate.
 */
function visibleIslandPercent(map: MapState, size: number, style: ReturnType<typeof resolveStyle>): number {
  const paths: PathCmd[] = [];
  const collect = (prims: Prim[]) => {
    for (const prim of prims) {
      if (prim.kind === 'group') collect(prim.prims);
      else if (prim.kind === 'path' && prim.fill === style.palette.island) paths.push(...prim.d);
    }
  };
  collect(buildScene(map, { size, visible: defaultVisibility(), labels: false, style }).prims);
  const rings = pathPolylines(paths, 12);
  const reach = style.knobs.coast === 'none' ? 0 : Math.max(0.8, size * style.palette.coastWidth) / 2;
  const corners = hexCorners(0, 0, size);
  const xs = corners.map((q) => q.x);
  const ys = corners.map((q) => q.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const inHex = (px: number, py: number) => corners.every((a, k) => {
    const b = corners[(k + 1) % 6]!;
    return (b.x - a.x) * (py - a.y) - (b.y - a.y) * (px - a.x) >= 0;
  });
  const within = (px: number, py: number) => {
    for (const ring of rings) {
      let inside = false;
      let near = false;
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k]!;
        const b = ring[(k + 1) % ring.length]!;
        if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
        if (reach > 0 && !near) {
          const len2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2 || 1;
          const t = Math.max(0, Math.min(1, ((px - a.x) * (b.x - a.x) + (py - a.y) * (b.y - a.y)) / len2));
          near = Math.hypot(px - (a.x + t * (b.x - a.x)), py - (a.y + t * (b.y - a.y))) <= reach;
        }
      }
      if (inside || near) return true;
    }
    return false;
  };
  const n = 220;
  let hexPoints = 0;
  let covered = 0;
  for (let a = 0; a < n; a++) {
    for (let b = 0; b < n; b++) {
      const px = x0 + ((a + 0.5) / n) * (x1 - x0);
      const py = y0 + ((b + 0.5) / n) * (y1 - y0);
      if (!inHex(px, py)) continue;
      hexPoints++;
      if (within(px, py)) covered++;
    }
  }
  return (covered / hexPoints) * 100;
}

test('an island hex visibly occupies the selected percentage of its hex, outline included', () => {
  for (const [land, small] of [[5, 1], [15, 4], [30, 6], [35, 6]]) {
    const map = mapWith(['Islands']);
    map.islandSpecs = { '0': { large: small === 0 ? 1 : 0, small } };
    map.hexShapes = { '0': { type: 'Islands', land } };
    const shown = visibleIslandPercent(map, 30, smooth);
    assert.ok(Math.abs(shown - land) < 0.6, `${small} small island(s) visibly cover ${land}% with their outline, not ${shown.toFixed(2)}%`);
  }
});

test('islands are drawn smaller when the coastline has ink, so the outline is inside their share', () => {
  const map = mapWith(['Islands']);
  map.islandSpecs = { '0': { large: 0, small: 3 } };
  const inked = resolveStyle({ preset: 'parchment', overrides: { coast: 'smooth' } });
  const bare = resolveStyle({ preset: 'parchment', overrides: { coast: 'none' } });
  const fillOf = (style: typeof inked) => {
    const paths: PathCmd[] = [];
    const collect = (prims: Prim[]) => prims.forEach((p) => (p.kind === 'group' ? collect(p.prims) : p.kind === 'path' && p.fill === style.palette.island ? paths.push(...p.d) : undefined));
    collect(buildScene(map, { size: 30, visible: defaultVisibility(), labels: false, style }).prims);
    return coveredArea(pathPolylines(paths, 12), hexCorners(0, 0, 30), 300);
  };
  assert.ok(fillOf(inked) < fillOf(bare), 'the land inside the ink is less than the land of an uninked island');
});

test('every arrangement keeps its islands in the hex, at the selected share, and differs from the scattered layout', () => {
  const scattered = mapWith(['Islands']);
  scattered.islandSpecs = { '0': { large: 0, small: 4 } };
  const plain = JSON.stringify(scene(scattered).prims);
  for (const arrangement of ['chain', 'arc', 'barrier', 'ring'] as const) {
    const map = { ...scattered, islandSpecs: { '0': { large: 0, small: 4, arrangement } } };
    assert.notEqual(JSON.stringify(scene(map).prims), plain, `${arrangement} lays islands out differently`);
    const want = landFraction('Islands', map.islandSpecs['0'], dims) * 100;
    const shown = visibleIslandPercent(map, 30, smooth);
    // Crowded islands are drawn smaller, never larger, than their share.
    assert.ok(shown <= want + 3 && shown > want * 0.5, `${arrangement}: ${shown.toFixed(1)}% shown for a ${want}% share`);
  }
});

test('islands in a scattered group share one grain, and a chain runs with the coast when asked', () => {
  // Land to the west of a sea hex: the coast runs north-south, so "along" is vertical.
  const base: BaseGeo[] = ['Land', 'Islands'];
  const centres = (spec: { large: number; small: number; arrangement?: 'chain'; orientation?: 'along' | 'across' }) => {
    const map = { ...mapWith(base, 2, 1), islandSpecs: { '1': spec } };
    const found: Array<{ x: number; y: number }> = [];
    const collect = (prims: Prim[]) => {
      for (const p of prims) {
        if (p.kind === 'group') collect(p.prims);
        else if (p.kind === 'path' && p.fill === smooth.palette.island) {
          for (const ring of pathPolylines(p.d, 6)) {
            found.push({ x: ring.reduce((a, q) => a + q.x, 0) / ring.length, y: ring.reduce((a, q) => a + q.y, 0) / ring.length });
          }
        }
      }
    };
    collect(buildScene(map, { size: 30, visible: defaultVisibility(), labels: false, style: smooth }).prims);
    return found;
  };
  const spread = (list: Array<{ x: number; y: number }>) => {
    const xs = list.map((q) => q.x);
    const ys = list.map((q) => q.y);
    return { x: Math.max(...xs) - Math.min(...xs), y: Math.max(...ys) - Math.min(...ys) };
  };
  const along = spread(centres({ large: 0, small: 4, arrangement: 'chain', orientation: 'along' }));
  const across = spread(centres({ large: 0, small: 4, arrangement: 'chain', orientation: 'across' }));
  assert.ok(along.y > along.x * 2, 'a chain along a north-south coast runs north-south');
  assert.ok(across.x > across.y * 2, 'a chain across it runs east-west');
});

test('an arrangement can be set and reset on a hex by hand', () => {
  const map = mapWith(['Islands']);
  const arc = reducer(map, { type: 'setIslandSpec', indices: [0], change: { arrangement: 'arc', orientation: 'along' } });
  assert.equal(arc.islandSpecs?.['0']?.arrangement, 'arc');
  assert.equal(arc.islandSpecs?.['0']?.orientation, 'along');
  const back = reducer(arc, { type: 'setIslandSpec', indices: [0], change: { arrangement: 'scattered', orientation: 'free' } });
  assert.equal(back.islandSpecs?.['0']?.arrangement, undefined, 'scattered is the default and is not stored');
  assert.equal(back.islandSpecs?.['0']?.orientation, undefined);
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

test('coastal land beside a lake is drawn at its land share, as beside the sea', () => {
  const base: BaseGeo[] = Array.from({ length: 25 }, (_, i) => (i === 12 ? 'Lake' : 'Coastal Land'));
  const lakeArea = (percent: number): number => {
    const map = mapWith(base, 5, 5);
    const sized = { ...map, hexDimensions: { ...dims, coastalLandPercent: percent } };
    const body = scene(sized).prims.find((p) => p.kind === 'path' && p.fill === smooth.palette.lake);
    assert.ok(body && body.kind === 'path');
    const pts = body.d.filter((c): c is ['M' | 'L', number, number] => c[0] === 'M' || c[0] === 'L');
    let twice = 0;
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length]!;
      twice += p[1] * q[2] - q[1] * p[2];
    });
    return Math.abs(twice) / 2;
  };
  const full = lakeArea(100);
  const half = lakeArea(50);
  assert.ok(half > full * 1.3, `the lake takes more of the coast hexes when they are half land (${half} against ${full})`);
});

test('a lake hex with a land share has land drawn in from its edges against land', () => {
  const base: BaseGeo[] = Array.from({ length: 25 }, (_, i) => (i === 12 ? 'Lake' : 'Land'));
  const lakeArea = (map: MapState): number => {
    const body = scene(map).prims.find((p) => p.kind === 'path' && p.fill === smooth.palette.lake);
    assert.ok(body && body.kind === 'path');
    const pts = body.d.filter((c): c is ['M' | 'L', number, number] => c[0] === 'M' || c[0] === 'L');
    let twice = 0;
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length]!;
      twice += p[1] * q[2] - q[1] * p[2];
    });
    return Math.abs(twice) / 2;
  };
  const map = mapWith(base, 5, 5);
  const none = lakeArea(map);
  const some = lakeArea({ ...map, hexDimensions: { ...dims, lakeLandPercent: 40 } });
  const most = lakeArea({ ...map, hexDimensions: { ...dims, lakeLandPercent: 80 } });
  assert.ok(some < none * 0.8, `the lake shrinks as its hex takes land (${some} against ${none})`);
  assert.ok(most < some, `and more as the share grows (${most} against ${some})`);
  // A share set on the hex overrides the map-wide one, and counts in surface areas.
  const set = reducer(map, { type: 'setHexShape', indices: [12], change: { land: 40 } });
  assert.deepEqual(set.hexShapes, { '12': { type: 'Lake', land: 40 } });
  // A lake does keep an irregularity for its own shore (see the shore test below).
  assert.equal(reducer(map, { type: 'setHexShape', indices: [12], change: { irregular: 'Fractured' } }).hexShapes?.['12']?.irregular, 'Fractured');
  assert.ok(Math.abs(lakeArea(set) - some) < 1e-6);
  assert.equal(landFraction('Lake', undefined, normaliseHexDimensions(undefined), set.hexShapes!['12']), 0.4);
  assert.equal(landFraction('Lake', undefined, normaliseHexDimensions(undefined)), 0, 'a lake is all water unless given land');
});

/* ------------------------------------------------------------ drawn land share */

test('a coast hex is inset until the land left is its share of the hex', () => {
  const size = 10;
  const edges = coastEdges(['Coastal Land', 'Sea', 'Sea', 'Sea'], 2, 2, size).filter((e) => e.hex === 0);
  assert.ok(edges.length >= 1, 'the hex has a coast');
  const corners = hexCorners(0, 0, size);
  const hexArea = 1.5 * Math.sqrt(3) * size * size;
  assert.equal(landInsetDepth(corners, edges, 1), 0, 'all land: no inset');
  // With one wet edge the strip is a trapezoid, widening inwards as a hexagon does: depth * size + depth^2 * tan(30deg).
  const one = edges.slice(0, 1);
  const depth = landInsetDepth(corners, one, 0.9);
  const strip = depth * size + depth * depth * Math.tan(Math.PI / 6);
  assert.ok(Math.abs(strip / hexArea - 0.1) < 1e-3, `one wet edge gives up 10% of the hex, got ${strip / hexArea}`);
  // More wet edges share the loss, so each moves in less.
  assert.ok(landInsetDepth(corners, edges, 0.9) <= depth + 1e-9);
});

test('the land a coast hex leaves uncovered is its share, whatever its neighbours, and a hex set to all land has no strips', () => {
  const size = 10;
  const S: BaseGeo = 'Sea';
  const L: BaseGeo = 'Land';
  const C: BaseGeo = 'Coastal Land';
  const layouts: Record<string, BaseGeo[]> = {
    // The hex at the centre of a 5 x 5 map is index 12.
    surrounded: [S, S, S, S, S, S, S, S, S, S, S, S, C, S, S, S, S, S, S, S, S, S, S, S, S],
    'a bay': [S, S, S, S, S, S, S, C, S, S, S, L, C, S, S, S, C, L, S, S, S, S, S, S, S],
    'a coast of coastal hexes': [S, S, S, S, S, S, C, C, C, S, S, L, C, S, S, S, L, C, S, S, S, S, S, S, S],
  };
  const inside = (x: number, y: number, poly: Array<{ x: number; y: number }>) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if ((poly[i]!.y > y) !== (poly[j]!.y > y) && x < ((poly[j]!.x - poly[i]!.x) * (y - poly[i]!.y)) / (poly[j]!.y - poly[i]!.y) + poly[i]!.x) hit = !hit;
    }
    return hit;
  };
  for (const [name, base] of Object.entries(layouts)) {
    const edges = coastEdges(base, 5, 5, size);
    const wet = edges.filter((e) => e.hex === 12);
    assert.ok(wet.length > 0, `${name}: the hex has a coast`);
    const hex = hexCorners(2, 2, size);
    for (const land of [0.9, 0.6, 0.3]) {
      const shaped = shapeCoast(edges, surfaceMap(base, 5, 5), size, new Map([[12, { share: land, kind: 'inset' as const }]]));
      assert.ok(shaped, `${name}, ${land}: the hex is reshaped`);
      const { strips } = shaped;
      const polygons = strips.map((strip) => strip.d.filter((c) => c[0] !== 'Z').map((c) => ({ x: c.at(-2) as number, y: c.at(-1) as number })));
      const xs = hex.map((p) => p.x);
      const ys = hex.map((p) => p.y);
      let total = 0;
      let dry = 0;
      for (let a = 0; a < 120; a++) {
        for (let b = 0; b < 120; b++) {
          const x = Math.min(...xs) + ((a + 0.5) / 120) * (Math.max(...xs) - Math.min(...xs));
          const y = Math.min(...ys) + ((b + 0.5) / 120) * (Math.max(...ys) - Math.min(...ys));
          if (!inside(x, y, hex)) continue;
          total++;
          const covering = polygons.filter((poly) => inside(x, y, poly)).length;
          assert.ok(covering <= 1, `${name}, ${land}: strips overlap, which an even-odd cut-out would turn back into land`);
          if (covering === 0) dry++;
        }
      }
      assert.ok(Math.abs(dry / total - land) < 0.01, `${name}, ${land}: land left is ${(dry / total).toFixed(3)}`);
    }
  }
  const edges = coastEdges(['Coastal Land', 'Sea', 'Sea', 'Sea'], 2, 2, size);
  const base: BaseGeo[] = ['Coastal Land', 'Sea', 'Sea', 'Sea'];
  assert.equal(coastGeometryOf(edges, false).strips.length, 0, 'no inset, no strips');
  const flat = resolveStyle({ preset: 'parchment', overrides: { coast: 'hex' } });
  const draw = (land: number) => buildScene(
    reducer(mapWith(base, 2, 2), { type: 'setHexShape', indices: [0], change: { land } }),
    { size: 30, visible: defaultVisibility(), labels: false, style: flat },
  ).prims;
  assert.ok(JSON.stringify(draw(50)) !== JSON.stringify(draw(100)), 'the share changes what is drawn');
});

/* ------------------------------------------------------------ enforced for split hexes */

test('an isthmus, a strait and a mainland are reshaped to exactly their land share, and stay joined', () => {
  const S: BaseGeo = 'Sea';
  const L: BaseGeo = 'Land';
  const size = 10;
  const hexArea = 1.5 * Math.sqrt(3) * size * size;
  const layouts: Array<[BaseGeo, BaseGeo[], 'neck' | 'channel' | 'inset']> = [
    // 3 x 3: land west and east of an isthmus with sea north and south of it.
    ['Isthmus', [S, S, S, L, 'Isthmus', L, S, S, S], 'neck'],
    ['Strait', [L, L, L, S, 'Strait', S, L, L, L], 'channel'],
    ['Mainland and islands', [S, S, S, L, 'Mainland and islands', S, S, S, S], 'inset'],
  ];
  for (const [type, base, kind] of layouts) {
    const surface = surfaceMap(base, 3, 3);
    assert.ok(surface.split.has(4), `${type} is split`);
    for (const share of [0.1, 0.3, 0.6, 0.9]) {
      const shaped = shapeCoast(coastEdges(base, 3, 3, size), surface, size, new Map([[4, { share, kind }]]));
      assert.ok(shaped, `${type} ${share}: reshaped`);
      const land = shaped.land.get(4)!.reduce((sum, p) => sum + polyAreaOf(p), 0) / hexArea;
      assert.ok(Math.abs(land - share) < 1e-4, `${type} ${share}: land is ${land}`);
    }
  }
});

function polyAreaOf(p: Array<{ x: number; y: number }>): number {
  let sum = 0;
  for (let k = 0; k < p.length; k++) sum += p[k]!.x * p[(k + 1) % p.length]!.y - p[(k + 1) % p.length]!.x * p[k]!.y;
  return Math.abs(sum) / 2;
}

test('the scene draws an isthmus differently at different widths', () => {
  const base: BaseGeo[] = ['Sea', 'Sea', 'Sea', 'Land', 'Isthmus', 'Land', 'Sea', 'Sea', 'Sea'];
  const map = mapWith(base, 3, 3);
  const draw = (width: ChannelWidth) => JSON.stringify(scene({ ...map, hexShapes: { '4': { type: 'Isthmus', width } } }).prims);
  assert.notEqual(draw('Very narrow'), draw('Wide'));
});

test('an isthmus beside lakes has the lake shore moved to its land share', () => {
  const K: BaseGeo = 'Lake';
  const L: BaseGeo = 'Land';
  const base: BaseGeo[] = [L, L, L, L, L, K, K, L, K, K, L, L, L, L, L, L, L, L, L, L];
  const base5 = [L, K, K, L, L, L, K, K, L, L, L, K, K, L, L, L, L, L, L, L, L, K, K, L, L].slice(0, 25);
  void base;
  const map = mapWith(base5.map((v, i) => (i === 12 ? ('Isthmus' as BaseGeo) : v)), 5, 5);
  const surface = surfaceMap(map.layers.base.data!, 5, 5);
  assert.ok(surface.split.has(12));
  const at = (land: number) => shapeCoast([], surface, 10, new Map([[12, { share: land, kind: 'neck' as const }]]), [])?.insets.get(12) ?? 0;
  assert.ok(at(0.2) > at(0.4), 'less land moves the shore further into it');
  assert.ok(at(0.95) < 0, 'more land than the hex has moves the shore out into the lake');
});

test('coast ink counts as land: a full coastal hex has its coastline inside it, and neighbouring islands keep their ink apart', () => {
  const size = 30;
  const map = { ...mapWith(['Sea', 'Coastal Land', 'Sea']), hexShapes: { '1': { type: 'Coastal Land' as const, land: 100 } } };
  const lines: Array<{ x: number; y: number }> = [];
  const collect = (prims: Prim[]) => {
    for (const p of prims) {
      if (p.kind === 'group') collect(p.prims);
      else if (p.kind === 'path' && p.stroke === smooth.palette.coast) for (const ring of pathPolylines(p.d, 6)) lines.push(...ring);
    }
  };
  collect(buildScene(map, { size, visible: defaultVisibility(), labels: false, style: smooth }).prims);
  const centre = hexCenter(1, 0, size);
  const half = Math.abs(hexCenter(1, 0, size).x - hexCenter(0, 0, size).x) / 2;
  const ink = Math.max(0.8, size * smooth.palette.coastWidth) / 2;
  const side = lines.filter((q) => Math.abs(q.y - centre.y) < size * 0.7);
  assert.ok(side.length > 0, 'the coast is drawn');
  for (const q of side) assert.ok(Math.abs(q.x - centre.x) <= half - ink * 0.8, `coast at ${q.x.toFixed(1)} leaves room for its ink inside the hex`);

  // Islands of one hex: their outer ink edges do not meet.
  const isles = mapWith(['Islands']);
  isles.islandSpecs = { '0': { large: 0, small: 6 } };
  const rings: Array<Array<{ x: number; y: number }>> = [];
  const gather = (prims: Prim[]) => {
    for (const p of prims) {
      if (p.kind === 'group') gather(p.prims);
      else if (p.kind === 'path' && p.fill === smooth.palette.island) rings.push(...pathPolylines(p.d, 8));
    }
  };
  gather(buildScene(isles, { size, visible: defaultVisibility(), labels: false, style: smooth }).prims);
  const nearest = (a: Array<{ x: number; y: number }>, b: Array<{ x: number; y: number }>) => Math.min(...a.map((p) => Math.min(...b.map((q) => Math.hypot(p.x - q.x, p.y - q.y)))));
  for (let a = 0; a < rings.length; a++) {
    for (let b = a + 1; b < rings.length; b++) {
      assert.ok(nearest(rings[a]!, rings[b]!) > 2 * ink, `islands ${a} and ${b} keep their outlines apart`);
    }
  }
});

test('a new random layout moves and reshapes the islands, not just turns the same ring', () => {
  const signatures = new Set<string>();
  const spreads: number[] = [];
  let unequal = 0;
  for (const layoutSeed of [1, 22, 333, 4444, 55555, 666666]) {
    const map = mapWith(['Islands']);
    map.islandSpecs = { '0': { large: 1, small: 4, layoutSeed } };
    const centre = hexCenter(0, 0, 30);
    const rings: Array<Array<{ x: number; y: number }>> = [];
    const gather = (prims: Prim[]) => {
      for (const p of prims) {
        if (p.kind === 'group') gather(p.prims);
        else if (p.kind === 'path' && p.fill === smooth.palette.island) rings.push(...pathPolylines(p.d, 8));
      }
    };
    gather(scene(map).prims);
    const radii = rings
      .map((ring) => Math.hypot(ring.reduce((a, q) => a + q.x, 0) / ring.length - centre.x, ring.reduce((a, q) => a + q.y, 0) / ring.length - centre.y))
      .sort((a, b) => a - b);
    signatures.add(radii.map((r) => Math.round(r)).join(","));
    spreads.push(radii[radii.length - 1]! - radii[0]!);
    // Islands differ in size within one layout.
    const areas = rings.map((ring) => Math.abs(ring.reduce((a, q, k) => a + q.x * ring[(k + 1) % ring.length]!.y - ring[(k + 1) % ring.length]!.x * q.y, 0)) / 2).sort((a, b) => a - b);
    // The small islands (the largest area is the large island) differ in size.
    const small = areas.slice(0, -1).filter((a) => a > 20);
    if (small.length >= 3 && small[small.length - 1]! > small[0]! * 1.2) unequal++;
  }
  assert.ok(unequal >= 4, `islands differ in size in ${unequal} of 6 layouts`);
  assert.ok(signatures.size >= 5, `six presses give ${signatures.size} different spreads of islands`);
});

test('a lake carries its own shore irregularity, which beats the land beside it and the map default', () => {
  const base: BaseGeo[] = Array.from({ length: 25 }, (_, i) => (i === 12 ? 'Lake' : 'Land'));
  const plain = mapWith(base, 5, 5);
  const lakeShape = (map: MapState) => JSON.stringify(scene(map).prims.filter((p) => p.kind === 'path' && p.fill === smooth.palette.lake));
  const turning = (map: MapState) => {
    let total = 0;
    for (const p of scene(map).prims) {
      if (p.kind !== 'path' || p.fill !== smooth.palette.lake) continue;
      for (const ring of pathPolylines(p.d, 4)) {
        for (let k = 0; k < ring.length; k++) {
          const a = ring[k]!;
          const b = ring[(k + 1) % ring.length]!;
          const c = ring[(k + 2) % ring.length]!;
          const t = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
          total += Math.abs(Math.atan2(Math.sin(t), Math.cos(t)));
        }
      }
    }
    return total;
  };
  // The sidebar's setting is accepted on a lake hex, and only while it is a lake.
  const set = (value: 'Smooth' | 'Fractured') => reducer(plain, { type: 'setHexShape', indices: [12], change: { irregular: value } });
  assert.equal(set('Fractured').hexShapes?.['12']?.irregular, 'Fractured');
  assert.equal(set('Fractured').hexShapes?.['12']?.type, 'Lake');
  // Smooth on the lake smooths it even where the map default is Fractured; Fractured roughens it where the default is Smooth.
  const fracturedMap = reducer(plain, { type: 'setDefaultLakeIrregularity', irregular: 'Fractured' });
  const smoothMap = reducer(plain, { type: 'setDefaultLakeIrregularity', irregular: 'Smooth' });
  const calm = reducer(fracturedMap, { type: 'setHexShape', indices: [12], change: { irregular: 'Smooth' } });
  const wild = reducer(smoothMap, { type: 'setHexShape', indices: [12], change: { irregular: 'Fractured' } });
  assert.ok(turning(calm) < turning(fracturedMap) * 0.6, 'a lake set Smooth is smoother than the Fractured default');
  assert.ok(turning(wild) > turning(smoothMap) * 1.8, 'a lake set Fractured is rougher than the Smooth default');
  assert.notEqual(lakeShape(calm), lakeShape(fracturedMap));
  // A setting made for a lake is ignored once the hex is no longer one.
  const filled = { ...wild, layers: { ...wild.layers, base: { ...wild.layers.base, data: base.map((v, i) => (i === 12 ? ('Land' as BaseGeo) : v)) } } };
  assert.equal(hexShapeFor('Land', filled.hexShapes?.['12']).irregular, 'Smooth');
});

test('a land hex between two lakes still takes its lake shores irregularity', () => {
  const size = 40;
  const lakes = [[0, 2], [1, 2], [0, 1], [1, 1], [0, 3], [1, 3], [3, 2], [4, 2], [3, 1], [4, 1], [3, 3], [4, 3]];
  const wobble = (irregular: 'Smooth' | 'Fractured') => {
    const base: BaseGeo[] = Array.from({ length: 25 }, () => 'Land');
    for (const [c, r] of lakes) base[r * 5 + c] = 'Lake';
    const map = { ...mapWith(base, 5, 5), defaultLakeIrregularity: irregular };
    const centre = hexCenter(2, 2, size);
    let turning = 0;
    for (const p of buildScene(map, { size, visible: defaultVisibility(), labels: false, style: smooth }).prims) {
      if (p.kind !== 'path' || p.fill !== smooth.palette.lake) continue;
      for (const ring of pathPolylines(p.d, 4)) {
        // Only the stretches of shore that face the strip of land between the lakes.
        const near = ring.filter((q) => Math.abs(q.x - centre.x) < size * 0.8 && Math.abs(q.y - centre.y) < size * 1.4);
        for (let k = 1; k + 1 < near.length; k++) {
          const a = near[k - 1]!;
          const b = near[k]!;
          const c = near[k + 1]!;
          const t = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x);
          turning += Math.abs(Math.atan2(Math.sin(t), Math.cos(t)));
        }
      }
    }
    return turning;
  };
  assert.ok(wobble('Fractured') > wobble('Smooth') * 2.5, `a Fractured shore beside a thin strip is rougher (${wobble('Fractured').toFixed(1)} against ${wobble('Smooth').toFixed(1)})`);
});

test('a hex on a lake shore shows its land share, the lake border counted as land', () => {
  const size = 50;
  const N = 7;
  const MID = 3;
  const ink = Math.max(0.8, size * smooth.palette.coastWidth * smooth.knobs.lineWeight) / 2;
  const hexArea = 1.5 * Math.sqrt(3) * size * size;
  const shown = (type: BaseGeo, shape: MapState['hexShapes'] extends infer H ? H : never): number => {
    const base: BaseGeo[] = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) base.push(c < MID ? 'Lake' : c === MID ? (r === MID ? type : 'Coastal Land') : 'Land');
    const map = { ...mapWith(base, N, N), hexShapes: { [String(MID * N + MID)]: shape } } as MapState;
    const rings: Array<Array<{ x: number; y: number }>> = [];
    const gather = (prims: Prim[]) => {
      for (const p of prims) {
        if (p.kind === 'group') gather(p.prims);
        else if (p.kind === 'path' && p.fill === smooth.palette.lake) rings.push(...pathPolylines(p.d, 4));
      }
    };
    gather(buildScene(map, { size, visible: defaultVisibility(), labels: false, style: smooth }).prims);
    const hex = MID * N + MID;
    let length = 0;
    for (const ring of rings) {
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k]!;
        const b = ring[(k + 1) % ring.length]!;
        if (nearestHex({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, N, N, size) === hex) length += Math.hypot(b.x - a.x, b.y - a.y);
      }
    }
    const water = coveredArea(rings, hexCorners(MID, MID, size), 200) - length * ink;
    return (1 - water / hexArea) * 100;
  };
  for (const land of [30, 60, 90]) {
    const got = shown('Coastal Land', { [String(MID * N + MID)]: { type: 'Coastal Land', land } }[String(MID * N + MID)] as never);
    assert.ok(Math.abs(got - land) < 3, `Coastal Land set to ${land}% on a lake shore shows ${got.toFixed(1)}%`);
  }
  for (const land of [30, 40]) {
    const got = shown('Lake', { type: 'Lake', land } as never);
    assert.ok(Math.abs(got - land) < 4, `a lake hex given ${land}% land shows ${got.toFixed(1)}%`);
  }
});

/* ------------------------------------------------------------ isthmus and strait widths */

/** Total length of a vertical line at `x` that lies inside any of the convex polygons. */
function chordAt(polys: Array<Array<{ x: number; y: number }>>, x: number): number {
  let total = 0;
  for (const poly of polys) {
    const ys: number[] = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k]!;
      const b = poly[(k + 1) % poly.length]!;
      if ((a.x - x) * (b.x - x) <= 0 && a.x !== b.x) ys.push(a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x));
    }
    if (ys.length >= 2) total += Math.max(...ys) - Math.min(...ys);
  }
  return total;
}

test('an isthmus is 5% of the hex wide at its thinnest at the narrowest setting, and a strait too', () => {
  assert.equal(CHANNEL_WIDTH_PERCENT['Very narrow'], 5);
  const S: BaseGeo = 'Sea';
  const L: BaseGeo = 'Land';
  const size = 20;
  const flat = Math.sqrt(3) * size;
  const layouts: Array<[BaseGeo, BaseGeo[], 'neck' | 'channel']> = [
    // Land west and east of the isthmus, sea north and south: the neck runs east-west and is thinnest at the middle.
    ['Isthmus', [S, S, S, L, 'Isthmus', L, S, S, S], 'neck'],
    // Sea west and east of the strait, land north and south.
    ['Strait', [L, L, L, S, 'Strait', S, L, L, L], 'channel'],
  ];
  for (const [type, base, kind] of layouts) {
    const surface = surfaceMap(base, 3, 3);
    const centre = hexCenter(1, 1, size);
    for (const width of CHANNEL_WIDTH_VALUES) {
      const px = (CHANNEL_WIDTH_PERCENT[width] / 100) * flat;
      const shaped = shapeCoast(coastEdges(base, 3, 3, size), surface, size, new Map([[4, { share: 0.5, kind, width: px }]]));
      assert.ok(shaped, `${type} ${width}: reshaped`);
      const land = shaped.land.get(4)!;
      const chord = chordAt(land, centre.x);
      // The neck is `px` across the middle; the channel leaves the hex's height less `px`.
      const expected = kind === 'neck' ? px : 2 * size - px;
      assert.ok(Math.abs(chord - expected) < 1e-3, `${type} ${width}: ${chord} across the middle, wanted ${expected}`);
    }
  }
});

test('an isthmus or strait of any width stays joined to the land it runs between, whatever its neighbours', () => {
  const S: BaseGeo = 'Sea';
  const L: BaseGeo = 'Land';
  const size = 20;
  // Every way the six neighbours of the middle hex of a 3 x 3 grid can be land and sea (the middle row's
  // neighbours are W and E; the rows above and below hold NW, NE and SW, SE).
  const around = (mask: number): BaseGeo[] => {
    const edge = (e: number): BaseGeo => (mask >> e) & 1 ? L : S;
    // 3 x 3 odd-r: the hex at (1, 1) has neighbours E (2,1), SE (2,2), SW (1,2), W (0,1), NW (1,0), NE (2,0).
    return [S, edge(4), edge(5), edge(3), S, edge(0), S, edge(2), edge(1)];
  };
  for (const type of ['Isthmus', 'Strait'] as const) {
    let drawn = 0;
    for (let mask = 1; mask < 63; mask++) {
      const base = around(mask);
      base[4] = type;
      const surface = surfaceMap(base, 3, 3);
      if (!surface.split.has(4)) continue;
      const dry = [0, 1, 2, 3, 4, 5].filter((e) => surface.split.get(4)!.sides[6 + e] === 'land');
      for (const width of [0.05, 0.15, 0.3, 0.5]) {
        const shaped = shapeCoast(coastEdges(base, 3, 3, size), surface, size, new Map([[4, { share: 0.5, kind: type === 'Isthmus' ? 'neck' : 'channel', width: width * Math.sqrt(3) * size }]]));
        assert.ok(shaped, `${type} ${mask} ${width}`);
        const land = shaped.land.get(4)!;
        assert.ok(land.length > 0, `${type} ${mask} ${width}: has land`);
        // Land reaches the whole of every edge that faces land: the middle of each is inside it.
        const corners = hexCorners(1, 1, size);
        for (const e of dry) {
          const m = { x: (corners[e]!.x + corners[(e + 1) % 6]!.x) / 2, y: (corners[e]!.y + corners[(e + 1) % 6]!.y) / 2 };
          const touches = land.some((poly) => poly.some((p, k) => {
            const q = poly[(k + 1) % poly.length]!;
            const len2 = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
            const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((m.x - p.x) * (q.x - p.x) + (m.y - p.y) * (q.y - p.y)) / len2));
            return Math.hypot(p.x + (q.x - p.x) * t - m.x, p.y + (q.y - p.y) * t - m.y) < 1e-3;
          }));
          assert.ok(touches, `${type} ${mask} ${width}: land reaches the middle of edge ${e}`);
        }
        drawn++;
      }
    }
    assert.ok(drawn > 100, `${type}: many layouts were drawn`);
  }
});

test('the scene draws a strait differently at each width, and its width is set per hex and ignored once the hex changes type', () => {
  const base: BaseGeo[] = ['Land', 'Land', 'Land', 'Sea', 'Strait', 'Sea', 'Land', 'Land', 'Land'];
  const map = mapWith(base, 3, 3);
  const draws = CHANNEL_WIDTH_VALUES.map((width) => JSON.stringify(scene({ ...map, hexShapes: { '4': { type: 'Strait', width } } }).prims));
  assert.equal(new Set(draws).size, CHANNEL_WIDTH_VALUES.length, 'four widths, four pictures');

  const set = reducer(map, { type: 'setHexShape', indices: [4], change: { width: 'Narrow' } });
  assert.deepEqual(set.hexShapes!['4'], { type: 'Strait', width: 'Narrow' });
  assert.equal(hexShapeFor('Strait', set.hexShapes!['4']).width, 'Narrow');
  // A strait has a land share as well, kept beside its width.
  const both = reducer(set, { type: 'setHexShape', indices: [4], change: { land: 10 } });
  assert.deepEqual(both.hexShapes!['4'], { type: 'Strait', land: 10, width: 'Narrow' });
  // A width means nothing on a coast hex.
  const coast = mapWith(['Coastal Land', 'Sea']);
  assert.equal(reducer(coast, { type: 'setHexShape', indices: [0], change: { width: 'Wide' } }), coast);
  // The strait's setting is dropped when the hex becomes something else.
  assert.equal(hexShapeFor('Isthmus', set.hexShapes!['4']).width, undefined);
  const cleared = reducer(set, { type: 'setHexShape', indices: [4], change: { width: null } });
  assert.equal('4' in cleared.hexShapes!, false);
});

test('maps saved with land shares for isthmuses and straits take widths instead', () => {
  const old = { ...dims, isthmusPercent: 30, straitPercent: 40 };
  const migrated = normaliseHexDimensions(old);
  assert.ok(!('isthmusPercent' in migrated) && !('straitPercent' in migrated));
  assert.equal(migrated.isthmusWidth, 'Normal');
  assert.equal(migrated.straitWidth, 'Normal');
  assert.equal(normaliseHexDimensions({ ...dims, straitWidth: 'Wide' }).straitWidth, 'Wide');
  assert.equal(normaliseHexDimensions({ ...dims, straitWidth: 'Gaping' as never }).straitWidth, 'Normal');
});

test('a land share set on an isthmus or strait tunes the land round its width, and leaves the width alone', () => {
  const S: BaseGeo = 'Sea';
  const L: BaseGeo = 'Land';
  const size = 20;
  const hexArea = 1.5 * Math.sqrt(3) * size * size;
  const flat = Math.sqrt(3) * size;
  const layouts: Array<[BaseGeo, BaseGeo[], 'neck' | 'channel']> = [
    ['Isthmus', [S, S, S, L, 'Isthmus', L, S, S, S], 'neck'],
    ['Strait', [L, L, L, S, 'Strait', S, L, L, L], 'channel'],
  ];
  for (const [type, base, kind] of layouts) {
    const surface = surfaceMap(base, 3, 3);
    const centre = hexCenter(1, 1, size);
    for (const width of ['Narrow', 'Normal'] as const) {
      const px = (CHANNEL_WIDTH_PERCENT[width] / 100) * flat;
      const shareOf = (share: number) => {
        const shaped = shapeCoast(coastEdges(base, 3, 3, size), surface, size, new Map([[4, { share, kind, width: px, fit: true }]]))!;
        return { land: shaped.land.get(4)!, got: shaped.land.get(4)!.reduce((sum, p) => sum + polyAreaOf(p), 0) / hexArea };
      };
      // What the width alone allows: the least land (the neck, or the banks cut right back) and the most.
      const naturalShape = shapeCoast(coastEdges(base, 3, 3, size), surface, size, new Map([[4, { share: 0.5, kind, width: px }]]))!;
      const natural = naturalShape.land.get(4)!.reduce((sum, p) => sum + polyAreaOf(p), 0) / hexArea;
      const least = shareOf(0).got;
      const most = shareOf(1).got;
      assert.ok(most - least > 0.3, `${type} ${width}: room to tune (${least} to ${most})`);
      const shares: number[] = [];
      for (const share of [0.15, 0.3, 0.5, 0.7, 0.9]) {
        const { land, got } = shareOf(share);
        shares.push(got);
        if (share > least + 0.01 && share < most - 0.01) assert.ok(Math.abs(got - share) < 2e-3, `${type} ${width} ${share}: drew ${got}`);
        // And the width at the middle is the one set: for a strait only down to the land its width gives (a
        // share below that has to cut the banks back, which widens the channel; the share is what was asked for).
        const chord = chordAt(land, centre.x);
        const expected = kind === 'neck' ? px : 2 * size - px;
        if (kind === 'neck' || got >= natural - 1e-3) assert.ok(Math.abs(chord - expected) < 1e-2, `${type} ${width} ${share}: ${chord} across the middle, wanted ${expected}`);
      }
      assert.ok(shares.every((v, k) => k === 0 || v >= shares[k - 1]! - 1e-9), `${type} ${width}: more share, more land (${shares.join(', ')})`);
      assert.ok(shares[4]! - shares[0]! > 0.15, `${type} ${width}: the share changes the land (${shares.join(', ')})`);
    }
  }
});
