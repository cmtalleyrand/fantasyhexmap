import { coastEdges, surfaceMap } from '../src/render/coast.ts';
import { shapeCoast } from '../src/render/footprint.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HEX_CATEGORIES, PASSAGE_LAND_RANGE, adjacentHexes, boundedLandShare, isCategoryLand, landPercent, landShareRange, passageNeighbours } from '../shared/hexCategories.ts';
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
  for (const [type, min, max] of [['Isthmus', 35, 95], ['Strait', 10, 75], ['Mainland and islands', 10, 90]] as const) {
    assert.equal(boundedLandShare(type, 0), min);
    assert.equal(boundedLandShare(type, 100), max);
  }
  // A passage's range depends on its width, and holds its natural share at that width.
  for (const type of ['Isthmus', 'Strait'] as const) for (const width of ['Very narrow', 'Narrow', 'Normal', 'Wide'] as const) {
    const [min, max] = PASSAGE_LAND_RANGE[type][width];
    assert.deepEqual(landShareRange(type, undefined, width), [min, max]);
    const share = landFraction(type, undefined, dims, { type, width }) * 100;
    assert.ok(share >= min && share <= max, `${type} ${width}: natural ${share}% outside ${min}–${max}%`);
    assert.equal(landPercent(landFraction(type, undefined, dims, { type, width, land: 0 })), min);
    assert.equal(landPercent(landFraction(type, undefined, dims, { type, width, land: 100 })), max);
  }
  for (const [type, max] of [['Isthmus', 90], ['Strait', 55], ['Mainland and islands', 90]] as const) {
    const changed = reducer(mapWith(type), { type: 'setHexShape', indices: [24], change: { land: 100 } });
    assert.equal(changed.hexShapes?.['24']?.land, max, `${type} at the map's Normal width`);
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
test('passages require exactly two land groups and two water groups, across all 64 neighbour patterns', () => {
  for (const type of ['Isthmus', 'Strait'] as const) for (let mask = 0; mask < 64; mask++) {
    const map = mapWith(type), base = map.layers.base.data!;
    adjacentHexes(base, 7, 24).forEach((j, side) => { base[j] = mask & (1 << side) ? 'Land' : 'Sea'; });
    const bits = Array.from({ length: 6 }, (_, side) => !!(mask & (1 << side)));
    const transitions = bits.filter((v, side) => v !== bits[(side + 5) % 6]).length;
    // Four changes round the ring are two groups of each; six (land and water alternating) are three of each, not one passage.
    assert.equal(validateHexDefinitions(map).length === 0, transitions === 4, `${type}: mask ${mask}`);
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
test('mixed mainland and islands keeps 2.5% mainland plus each island\'s minimum, within 10–90%', () => {
  const spec = { large: 2, small: 6 };
  assert.deepEqual(landShareRange('Mainland and islands', spec), [27.5, 90]);
  assert.deepEqual(landShareRange('Mainland and islands', { large: 0, small: 1 }), [10, 90]);
  assert.deepEqual(landShareRange('Mainland and islands', { large: 1, small: 2 }), [12.5, 90]);
  const map = mapWith('Mainland and islands'); map.islandSpecs = { '24': spec };
  const changed = reducer(map, { type: 'setHexShape', indices: [24], change: { land: 10 } });
  assert.equal(changed.hexShapes?.['24']?.land, 27.5);
  const shape = changed.hexShapes?.['24'];
  const mainland = drawnLandFraction('Mainland and islands', dims, shape, true, spec)!;
  assert.ok(Math.abs(mainland - .025) < 1e-12, 'the mainland keeps its 2.5%');
  assert.ok(Math.abs(landFraction('Mainland and islands', spec, dims, shape) - mainland - .25) < 1e-12, 'the islands keep their 25%');
  // A share saved below the minimum, or islands added after it was set, is read at the minimum and flagged.
  const stale = mapWith('Mainland and islands'); stale.islandSpecs = { '24': spec };
  stale.hexShapes = { '24': { type: 'Mainland and islands', land: 15 } };
  assert.equal(landFraction('Mainland and islands', spec, dims, stale.hexShapes['24']), .275);
  assert.ok(validateHexDefinitions(stale).some(w => w.includes('27.5–90%')));
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
    assert.equal(withShoreSlack(base, 7, 24, total, dims), total, 'a bounded total is left as it is');
    if (requested <= 27.5) {
      assert.equal(target, .025);
      assert.ok(Math.abs(islands - .25) < 1e-12);
      assert.ok(Math.abs(target + islands - .275) < 1e-12);
    }
  }
});
test('half-step land shares are stored and shown exactly, without floating-point residue', () => {
  for (const type of ['Isthmus', 'Strait', 'Mainland and islands'] as const) {
    // At the map's Normal width for a passage.
    const [min, max] = landShareRange(type, undefined, type === 'Mainland and islands' ? undefined : 'Normal');
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
