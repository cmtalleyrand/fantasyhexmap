import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from './seededMap.ts';
import { buildStaticScene, defaultVisibility, landTestOf } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';
import { coastEdges, coastGeometryOf, reverseCoastPath, surfaceMap } from '../src/render/coast.ts';
import { shapeCoast } from '../src/render/footprint.ts';
import { hexCenter, neighbourOf, inBounds } from '../shared/hex.ts';
import { DEFAULT_HEX_DIMENSIONS, hexShapeFor, type BaseGeo, type Irregularity } from '../shared/types.ts';
import { baseSurfaceStatistics, landFractionAt, normaliseHexDimensions } from '../shared/surfaceArea.ts';
import { reducer } from '../src/state/store.ts';
import { parseMapImport, prepareLoadedMap } from '../src/state/import.ts';

const size = 30;
const options = { size, visible: defaultVisibility(), labels: false, style: resolveStyle({ preset: 'parchment' }) };
function shore(water: 'Sea' | 'Lake', percent = 0, irregular: Irregularity = 'Ragged') {
  const map = createMapState('Shared shore', 7, 7);
  map.layers.base.data = Array.from({ length: 49 }, (_, i) => i % 7 < 3 ? water : i % 7 === 3 ? 'Land' : 'Land');
  map.hexDimensions = { ...map.hexDimensions, seaLandPercent: percent, lakeLandPercent: percent };
  map.defaultIrregularity = irregular;
  map.defaultLakeIrregularity = irregular;
  return map;
}

test('sea and lake use identical final land geometry with matching policies', () => {
  for (const irregular of ['Smooth', 'Ragged', 'Fractured'] as const) for (const percent of [0, 20]) {
    const sea = buildStaticScene(shore('Sea', percent, irregular), options);
    const lake = buildStaticScene(shore('Lake', percent, irregular), options);
    const seaLand = landTestOf(sea)!, lakeLand = landTestOf(lake)!;
    for (let y = 40; y < 280; y += 5) for (let x = 35; x < 330; x += 5) {
      assert.equal(lakeLand({ x, y }), seaLand({ x, y }), `${irregular}, ${percent}%, at ${x},${y}`);
    }
    assert.deepEqual(lake.compromises, sea.compromises);
  }
});

test('water growth and passage geometry do not depend on sea/lake identity', () => {
  const base: BaseGeo[] = Array.from({ length: 25 }, (_, i) => i % 5 < 2 ? 'Sea' : 'Land');
  const lakes = base.map(v => v === 'Sea' ? 'Lake' as const : v);
  const targets = new Map([[11, { kind: 'water' as const, share: 0.35 }]]);
  const sea = shapeCoast(coastEdges(base, 5, 5, size), surfaceMap(base, 5, 5), size, targets)!;
  const lake = shapeCoast(coastEdges(lakes, 5, 5, size), surfaceMap(lakes, 5, 5), size, targets)!;
  assert.deepEqual(lake, sea);
  const rough = { size, amplitude: () => 0.12, noise: () => 0.4 };
  assert.deepEqual(coastGeometryOf(lake.edges, true, rough, lake), coastGeometryOf(sea.edges, true, rough, sea));
});

test('Sea defaults to zero, retains per-hex overrides and counts only shore-adjacent land', () => {
  assert.equal(DEFAULT_HEX_DIMENSIONS.seaLandPercent, 0);
  const { seaLandPercent: _old, ...legacy } = DEFAULT_HEX_DIMENSIONS;
  assert.equal(normaliseHexDimensions(legacy).seaLandPercent, 0);
  assert.equal(normaliseHexDimensions({ seaLandPercent: NaN }).seaLandPercent, 0);
  const map = shore('Sea');
  const changed = reducer(map, { type: 'setHexShape', indices: [23], change: { land: 35 } });
  const saved = reducer(changed, { type: 'setHexDimensions', hexDimensions: { ...changed.hexDimensions, seaLandPercent: 15 } });
  const loaded = prepareLoadedMap(parseMapImport(JSON.stringify(saved)));
  assert.equal(loaded.hexDimensions.seaLandPercent, 15);
  assert.deepEqual(loaded.hexShapes, saved.hexShapes);
  assert.equal(hexShapeFor('Sea', changed.hexShapes?.['23']).land, 35);
  assert.equal(hexShapeFor('Land', changed.hexShapes?.['23']).land, undefined);
  assert.equal(landFractionAt(changed.layers.base.data!, 23, changed.hexDimensions, undefined, changed.hexShapes, 7), 0.35);
  const dims = { ...DEFAULT_HEX_DIMENSIONS, seaLandPercent: 30 };
  const base: BaseGeo[] = Array(25).fill('Sea'); base[12] = 'Land';
  assert.equal(landFractionAt(base, 0, dims, undefined, { '0': { type: 'Sea', land: 90 } }, 5), 0);
  const land = baseSurfaceStatistics(base, dims, undefined, undefined, 5).find(s => s.label === 'Land')!;
  assert.equal(land.hexCount, 7);
  // The island hex is shore land at the coastal share; its six sea neighbours add their 30% each.
  assert.ok(Math.abs(land.area / (dims.width * dims.height * 0.75) - (dims.coastalLandPercent / 100 + 6 * 0.3)) < 1e-10);
});

test('a sea land share grows the existing shore, and open sea stays water', () => {
  const map = shore('Sea');
  // A full land neighbour isolates the water-side target from competing requests.
  map.layers.base.data = map.layers.base.data!.map(v => v === 'Land' ? 'Land' : v);
  map.hexShapes = { '23': { type: 'Sea', land: 35 } };
  const scene = buildStaticScene(map, options), dry = landTestOf(scene)!;
  const centre = hexCenter(2, 3, size);
  let points = 0, land = 0;
  for (let x = -size; x <= size; x += size / 50) for (let y = -size; y <= size; y += size / 50) {
    if (Math.abs(x) >= Math.sqrt(3) / 2 * size || Math.abs(y) + Math.abs(x) / Math.sqrt(3) >= size) continue;
    points++; if (dry({ x: centre.x + x, y: centre.y + y })) land++;
  }
  // The fill excludes the outer half of the coastline ink, which counts toward the request.
  assert.ok(land / points > 0.29 && land / points < 0.36, `${land / points} of sea hex filled with land`);
  const ocean = createMapState('Open sea', 5, 5);
  ocean.layers.base.data = Array(25).fill('Sea'); ocean.hexDimensions.seaLandPercent = 50;
  assert.equal(landTestOf(buildStaticScene(ocean, options))!(hexCenter(2, 2, size)), false);
});

test('lake settings, undo and worker-style clones invalidate the shared coast cache', () => {
  const initial = shore('Lake');
  const edits = [initial, { ...initial, defaultLakeIrregularity: 'Fractured' as const },
    { ...initial, hexShapes: { '23': { type: 'Lake' as const, land: 35 } } }, initial];
  const scenes = edits.map(map => {
    const scene = buildStaticScene(structuredClone(map), options);
    assert.deepEqual(scene, buildStaticScene(structuredClone(map), { ...options, cache: 'off' }));
    return scene;
  });
  assert.notDeepEqual(scenes[0], scenes[1]);
  assert.notDeepEqual(scenes[0], scenes[2]);
  assert.deepEqual(scenes[0], scenes[3]);
});

test('mixed sea/lake shores preserve the intervening land and report one shared target', () => {
  const map = createMapState('Two waters', 9, 7);
  map.layers.base.data = Array.from({ length: 63 }, (_, i) => i % 9 < 4 ? 'Sea' : i % 9 === 4 ? 'Land' : 'Lake');
  map.hexDimensions = { ...map.hexDimensions, lakeLandPercent: 0 };
  map.hexShapes = { '31': { type: 'Land', land: 70 } };
  const scene = buildStaticScene(map, options), dry = landTestOf(scene)!;
  assert.equal(dry(hexCenter(4, 3, size)), true, 'land strip survives');
  const reports = scene.compromises?.filter(c => c.hexes.includes(31) && /% land drawn/.test(c.what)) ?? [];
  assert.ok(reports.length <= 1, 'one area fit accounts for both shores');
  assert.deepEqual(scene, buildStaticScene(structuredClone(map), { ...options, cache: 'off' }));
});

test('lake islands, map-edge water and fully filled lakes retain their topology', () => {
  const map = createMapState('Lake ring', 7, 7);
  map.layers.base.data = Array(49).fill('Land');
  for (let e = 0; e < 6; e++) {
    const n = neighbourOf(3, 3, e);
    if (inBounds(7, 7, n.col, n.row)) map.layers.base.data[n.row * 7 + n.col] = 'Lake';
  }
  map.hexDimensions.lakeLandPercent = 0;
  assert.equal(landTestOf(buildStaticScene(map, options))!(hexCenter(3, 3, size)), true);
  const full = createMapState('Filled lake', 5, 5);
  full.layers.base.data = Array(25).fill('Land'); full.layers.base.data[12] = 'Lake';
  full.hexShapes = { '12': { type: 'Lake', land: 100 } };
  assert.equal(landTestOf(buildStaticScene(full, options))!(hexCenter(2, 2, size)), true);
  const lake = buildStaticScene(shore('Lake'), options);
  assert.equal(landTestOf(lake)!({ x: 1, y: 100 }), false);
});

test('reversing a shoreline preserves quadratic and cubic control points', () => {
  assert.deepEqual(reverseCoastPath([['M', 0, 0], ['Q', 1, 2, 3, 4], ['C', 5, 6, 7, 8, 9, 10], ['Z']]),
    [['M', 9, 10], ['C', 7, 8, 5, 6, 3, 4], ['Q', 1, 2, 0, 0], ['Z']]);
});
