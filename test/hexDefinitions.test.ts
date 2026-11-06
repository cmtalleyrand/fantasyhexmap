import { coastEdges, surfaceMap } from '../src/render/coast.ts';
import { shapeCoast } from '../src/render/footprint.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HEX_CATEGORIES, adjacentHexes, boundedLandShare, isCategoryLand, landPercent, passageNeighbours } from '../shared/hexCategories.ts';
import { validateHexDefinitions } from '../shared/hexValidation.ts';
import { prepareLoadedMap } from '../src/state/import.ts';
import { drawnLandFraction, landFraction, landFractionAt, normaliseHexDimensions, withShoreSlack } from '../shared/surfaceArea.ts';
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
test('every plain water subtype has no detached land and at least 5% beside whole land', () => {
  for (const type of ['Sea', 'Lake', 'Sea Ice'] as const) {
    const base = Array<BaseGeo>(49).fill(type);
    const shapes: Record<string, HexShape> = { '24': { type, land: 80 } };
    assert.equal(landFractionAt(base, 24, dims, undefined, shapes, 7), 0);
    base[25] = 'Land';
    shapes['25'] = { type: 'Land', land: 100 };
    for (const percent of [0, 2.5, 5, 20, 80]) {
      shapes['24'] = { type, land: percent };
      const expected = Math.max(5, percent);
      assert.equal(landFractionAt(base, 24, dims, undefined, shapes, 7), expected / 100);
      const map = mapWith(type); map.layers.base.data = base; map.hexShapes = shapes;
      const edited = reducer(map, { type: 'setHexShape', indices: [24], change: { land: percent } });
      assert.equal(edited.hexShapes?.['24']?.land, expected);
    }
  }
});
test('passages require separated land and water groups, across all 64 neighbour patterns', () => {
  for (const type of ['Isthmus', 'Strait'] as const) for (let mask = 0; mask < 64; mask++) {
    const map = mapWith(type), base = map.layers.base.data!;
    adjacentHexes(base, 7, 24).forEach((j, side) => { base[j] = mask & (1 << side) ? 'Land' : 'Sea'; });
    const bits = Array.from({ length: 6 }, (_, side) => !!(mask & (1 << side)));
    const transitions = bits.filter((v, side) => v !== bits[(side + 5) % 6]).length;
    assert.equal(validateHexDefinitions(map).length === 0, transitions >= 4, `${type}: mask ${mask}`);
  }
});
test('passages may reach a map edge when the required land and water neighbours exist', () => {
  for (const type of ['Isthmus', 'Strait'] as const) {
    const map = mapWith(type), base = map.layers.base.data!;
    base[24] = 'Sea'; base[3] = type;
    const neighbours = adjacentHexes(base, 7, 3);
    neighbours.forEach((j, index) => { base[j] = index % 2 === 0 ? 'Land' : 'Sea'; });
    assert.equal(neighbours.length, 4);
    assert.deepEqual(validateHexDefinitions(map), []);
  }
});
test('mixed mainland and islands retains the stated 10–90% range for any island count', () => {
  const spec = { large: 2, small: 6 };
  assert.equal(boundedLandShare('Mainland and islands', 10, spec), 10);
  const map = mapWith('Mainland and islands'); map.islandSpecs = { '24': spec };
  const changed = reducer(map, { type: 'setHexShape', indices: [24], change: { land: 10 } });
  assert.equal(changed.hexShapes?.['24']?.land, 10);
  const mainland = drawnLandFraction('Mainland and islands', dims, changed.hexShapes?.['24'], true, spec)!;
  assert.ok(mainland >= .025 && mainland < .1, 'the 10% share contains both mainland and islands');
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

test('a strait draws two separate banks for all nine separated pairs of land neighbours', () => {
  for (let a = 0; a < 6; a++) for (let b = a + 1; b < 6; b++) {
    const map = createMapState('Two banks', 7, 7);
    const base = map.layers.base.data = Array<BaseGeo>(49).fill('Sea'); base[24] = 'Strait';
    for (const side of [a, b]) { const n = neighbourOf(3, 3, side); base[n.row * 7 + n.col] = 'Land'; }
    if (!passageNeighbours(base, 7, 24).valid) {
      assert.ok(validateHexDefinitions(map).length > 0); continue;
    }
    assert.deepEqual(validateHexDefinitions(map), []);
    const drawn = shapeCoast(coastEdges(base, 7, 7, 30), surfaceMap(base, 7, 7), 30,
      new Map([[24, { share: .4, kind: 'channel', width: .3 * Math.sqrt(3) * 30, fit: true }]]))!;
    assert.equal(drawn.land.get(24)!.length, 2, `land neighbours on sides ${a},${b}`);
  }
});

test('shore slack preserves the mainland-only share after bounding and splitting a mixed hex total', () => {
  const map = mapWith('Mainland and islands');
  const base = map.layers.base.data!, spec = { large: 2, small: 6 };
  map.islandSpecs = { '24': spec };
  for (const requested of [0, 10, 15, 40, 90, 100]) {
    const shape: HexShape = { type: 'Mainland and islands', land: requested };
    const total = landFraction(base[24], spec, dims, shape);
    const mainland = drawnLandFraction(base[24], dims, shape, true, spec)!;
    const islands = total - mainland;
    const target = withShoreSlack(base, 7, 24, mainland, dims, { '24': shape }, 'mainland');
    assert.equal(target, mainland, `mainland portion at ${requested}% total`);
    assert.ok(Math.abs(target + islands - total) < 1e-12);
    assert.equal(withShoreSlack(base, 7, 24, requested / 100, dims), total, 'total-share bounds still apply');
    if (requested <= 10) {
      assert.equal(target, .025);
      assert.ok(Math.abs(islands - .075) < 1e-12);
      assert.ok(Math.abs(target + islands - .1) < 1e-12);
    }
  }
});
test('half-step land shares are stored and shown exactly, without floating-point residue', () => {
  for (const type of ['Isthmus', 'Strait', 'Mainland and islands'] as const) {
    const [min, max] = boundedLandShare(type, 0) === 0 ? [0, 100] : [boundedLandShare(type, 0), boundedLandShare(type, 100)];
    for (let percent = min; percent <= max; percent += 2.5) {
      const changed = reducer(mapWith(type), { type: 'setHexShape', indices: [24], change: { land: percent } });
      assert.equal(changed.hexShapes?.['24']?.land, percent, `${type} ${percent}%`);
    }
  }
  assert.equal(landPercent(.575), 57.5);
  assert.equal(landPercent(.025), 2.5);
  assert.equal(landPercent(.07), 7);
});
test('an unrecognised base value in a loaded map is neither land nor water and does not abort loading', () => {
  const map = mapWith('Isthmus');
  (map.layers.base.data as unknown as string[])[25] = 'Coast';
  assert.equal(isCategoryLand('Coast' as BaseGeo), false);
  assert.doesNotThrow(() => prepareLoadedMap(map));
});
