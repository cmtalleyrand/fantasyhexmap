import { coastEdges, surfaceMap } from '../src/render/coast.ts';
import { shapeCoast } from '../src/render/footprint.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HEX_CATEGORIES, adjacentHexes, boundedLandShare, isCategoryLand } from '../shared/hexCategories.ts';
import { validateHexDefinitions } from '../shared/hexValidation.ts';
import { landFraction, landFractionAt, normaliseHexDimensions } from '../shared/surfaceArea.ts';
import { createMapState } from './seededMap.ts';
import { DEFAULT_HEX_DIMENSIONS, type HexShape, type BaseGeo } from '../shared/types.ts';
import { reducer } from '../src/state/store.ts';
import { coastGallery } from '../scripts/coast-gallery-fixtures.ts';
import { editCases } from '../scripts/render-edit-fixtures.ts';
import { fixture } from '../scripts/render-profile-input.ts';
import { featureFixture } from '../scripts/coastFeatureFixture.ts';
import { neighbourOf, inBounds, hexIndex } from '../shared/hex.ts';

const dims = DEFAULT_HEX_DIMENSIONS;
function mapWith(type: BaseGeo) {
  const map = createMapState('Definitions', 7, 7);
  const base = map.layers.base.data = Array<BaseGeo>(49).fill('Sea');
  base[24] = type;
  const neighbours = adjacentHexes(base, 7, 24);
  base[neighbours[0]!] = 'Land'; base[neighbours[3]!] = 'Land';
  return map;
}

test('geography categories distinguish straits and islands from layer eligibility', () => {
  assert.equal(HEX_CATEGORIES.Strait[0], 'Land');
  assert.equal(HEX_CATEGORIES.Islands[0], 'Water');
  assert.equal(isCategoryLand('Mainland and islands'), true);
});
test('channel and mixed land shares stay within their definitions, including natural widths', () => {
  for (const [type, min, max] of [['Isthmus', 15, 80], ['Strait', 10, 70], ['Mainland and islands', 10, 90]] as const) {
    assert.equal(boundedLandShare(type, 0), min);
    assert.equal(boundedLandShare(type, 100), max);
    for (const width of ['Very narrow', 'Narrow', 'Normal', 'Wide'] as const) {
      const share = landFraction(type, undefined, dims, { type, width }) * 100;
      assert.ok(share >= min && share <= max);
    }
    const map = mapWith(type);
    const changed = reducer(map, { type: 'setHexShape', indices: [24], change: { land: 100 } });
    assert.equal(changed.hexShapes?.['24']?.land, max);
  }
});
test('island minima are per island and retain half-percent precision in edits', () => {
  const map = mapWith('Islands');
  map.islandSpecs = { '24': { large: 1, small: 3 } };
  const changed = reducer(map, { type: 'setHexShape', indices: [24], change: { land: 0 } });
  assert.equal(changed.hexShapes?.['24']?.land, 12.5);
  assert.equal(landFraction('Islands', map.islandSpecs['24'], dims, { type: 'Islands', land: 0 }), .125);
  assert.equal(normaliseHexDimensions({ largeIslandPercent: 0 }).largeIslandPercent, 5);
});
test('every plain water subtype has no detached land and exactly 5% beside whole land', () => {
  for (const type of ['Sea', 'Lake', 'Sea Ice'] as const) {
    const base = Array<BaseGeo>(49).fill(type);
    const shapes: Record<string, HexShape> = { '24': { type, land: 80 } };
    assert.equal(landFractionAt(base, 24, dims, undefined, shapes, 7), 0);
    base[25] = 'Land';
    shapes['25'] = { type: 'Land', land: 100 };
    assert.equal(landFractionAt(base, 24, dims, undefined, shapes, 7), .05);
  }
});
test('channel topology requires all six neighbours and exactly two in the Land category', () => {
  for (const type of ['Isthmus', 'Strait'] as const) {
    const map = mapWith(type);
    assert.deepEqual(validateHexDefinitions(map), []);
    map.layers.base.data![17] = 'Land';
    assert.ok(validateHexDefinitions(map).some(w => w.includes('exactly two')));
    map.layers.base.data![0] = type;
    assert.ok(validateHexDefinitions(map).some(w => w.includes('(0,0)')));
  }
});
test('mixed hexes need land and water, and islands cannot adjoin whole land', () => {
  const map = mapWith('Mainland and islands');
  map.layers.base.data!.fill('Land'); map.layers.base.data![24] = 'Mainland and islands';
  assert.ok(validateHexDefinitions(map).some(w => w.includes('land and a water')));
  const island = mapWith('Islands');
  island.hexShapes = { '25': { type: 'Land', land: 100 } };
  assert.ok(validateHexDefinitions(island).some(w => w.includes('100% land')));
});
test('render performance maps and every edit state obey hex definitions', () => {
  const maps = [...coastGallery(), ...editCases(), ...['populated', 'feature'].map(name => ({ name, map: fixture(name) }))];
  for (const N of [20, 30, 40, 50]) for (const layout of ['plain', 'mixed'])
    maps.push({ name: `feature-${N}-${layout}`, map: featureFixture({ createMapState, neighbourOf, inBounds, hexIndex }, N, layout) });
  for (const { name, map } of maps) assert.deepEqual(validateHexDefinitions(map), [], name);
});

test('a strait draws two separate banks for all fifteen pairs of land neighbours', () => {
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) {
    const map = createMapState('Two banks', 7, 7);
    const base = map.layers.base.data = Array<BaseGeo>(49).fill('Sea'); base[24] = 'Strait';
    for (const side of [a, b]) { const n = neighbourOf(3, 3, side); base[n.row * 7 + n.col] = 'Land'; }
    assert.deepEqual(validateHexDefinitions(map), []);
    const drawn = shapeCoast(coastEdges(base, 7, 7, 30), surfaceMap(base, 7, 7), 30,
      new Map([[24, { share: .4, kind: 'channel', width: .3 * Math.sqrt(3) * 30, fit: true }]]))!;
    assert.equal(drawn.land.get(24)!.length, 2, `land neighbours on sides ${a},${b}`);
  }
});
