import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeBase, encodeBase } from '../shared/codec.js';
import { isLandLike } from '../shared/derive.js';
import type { BaseGeo } from '../shared/types.js';

test('every base type round-trips through the base-grid codec, and the retired Coastal Land code reads as Land', () => {
  const base: BaseGeo[] = ['Land', 'Sea', 'Lake', 'Glacier', 'Sea Ice', 'Islands', 'Mainland and islands', 'Isthmus', 'Strait'];

  const encoded = encodeBase(base, 9, 1);
  assert.deepEqual(encoded, ['tmlgfikns']);
  assert.deepEqual(decodeBase(encoded, 9, 1), { data: base, warnings: [] });
  assert.deepEqual(decodeBase(['tcm'], 3, 1), { data: ['Land', 'Land', 'Sea'], warnings: [] });
  assert.equal(isLandLike('Land'), true);
});

test('Land is shore land exactly where it shares an edge with sea, lake, sea ice or an island-sea hex', async () => {
  const { isShoreLand } = await import('../shared/derive.js');
  const { landFractionAt } = await import('../shared/surfaceArea.js');
  const { DEFAULT_HEX_DIMENSIONS } = await import('../shared/types.js');
  for (const water of ['Sea', 'Lake', 'Sea Ice', 'Islands'] as const) {
    const base: BaseGeo[] = ['Land', 'Land', 'Land', water];
    assert.deepEqual(base.map((_, i) => isShoreLand(base, 4, i)), [false, false, true, false], water);
    assert.equal(landFractionAt(base, 1, DEFAULT_HEX_DIMENSIONS, undefined, undefined, 4), 1, `inland beside ${water}`);
    assert.equal(landFractionAt(base, 2, DEFAULT_HEX_DIMENSIONS, undefined, undefined, 4), DEFAULT_HEX_DIMENSIONS.coastalLandPercent / 100, `shore beside ${water}`);
  }
  for (const other of ['Glacier', 'Isthmus', 'Strait', 'Mainland and islands'] as const) {
    assert.equal(isShoreLand(['Land', other], 2, 0), false, `beside ${other}`);
  }
  // Settings on a Land hex apply only while it meets water.
  const shapes = { '0': { type: 'Land' as const, land: 40 } };
  assert.equal(landFractionAt(['Land', 'Sea'], 0, DEFAULT_HEX_DIMENSIONS, undefined, shapes, 2), 0.4);
  assert.equal(landFractionAt(['Land', 'Land'], 0, DEFAULT_HEX_DIMENSIONS, undefined, shapes, 2), 1);
});

test('maps saved with Coastal Land load it as Land, with its settings and undo history', async () => {
  const { createMapState } = await import('./seededMap.ts');
  const { migrateMap } = await import('../shared/islandMigration.js');
  const map = createMapState('Old coast', 3, 1);
  delete map.derivedShores; // saved before shores were derived
  const old = ['Land', 'Coastal Land', 'Sea'] as unknown as BaseGeo[];
  map.layers.base.data = old;
  map.hexShapes = { '1': { type: 'Coastal Land' as BaseGeo, land: 60, irregular: 'Wavy' } };
  map.history = { past: [{ ...map, layers: { ...map.layers, base: { ...map.layers.base, data: [...old] } } }], future: [] };
  const migrated = migrateMap(map);
  assert.deepEqual(migrated.layers.base.data, ['Land', 'Land', 'Sea']);
  assert.deepEqual(migrated.hexShapes, { '1': { type: 'Land', land: 60, irregular: 'Wavy' } });
  assert.deepEqual(migrated.history!.past[0]!.layers.base.data, ['Land', 'Land', 'Sea']);
  assert.deepEqual(migrated.history!.past[0]!.hexShapes, { '1': { type: 'Land', land: 60, irregular: 'Wavy' } });
  assert.equal(migrateMap(migrated), migrated, 'a current map is left alone');
});

test('glacier is whole inland and cut back to its share where it meets water, like Land', async () => {
  const { landFractionAt } = await import('../shared/surfaceArea.js');
  const { migrateMap } = await import('../shared/islandMigration.js');
  const { DEFAULT_HEX_DIMENSIONS } = await import('../shared/types.js');
  const { createMapState } = await import('./seededMap.ts');
  assert.equal(landFractionAt(['Glacier', 'Glacier'], 0, DEFAULT_HEX_DIMENSIONS, undefined, undefined, 2), 1);
  assert.equal(landFractionAt(['Glacier', 'Lake'], 0, DEFAULT_HEX_DIMENSIONS, undefined, undefined, 2), DEFAULT_HEX_DIMENSIONS.glacierPercent / 100);
  for (const landShoresDone of [false, true]) {
    // Saved before any shores were derived, or after Land's but before Glacier's.
    const old = createMapState('Old ice', 2, 1);
    if (!landShoresDone) delete old.derivedShores;
    delete old.derivedGlacierShores;
    old.hexDimensions = { ...old.hexDimensions, glacierPercent: 100 };
    const migrated = migrateMap(old);
    assert.equal(migrated.hexDimensions.glacierPercent, DEFAULT_HEX_DIMENSIONS.glacierPercent, 'the old whole-glacier default moves to the shore default');
    assert.equal(migrateMap({ ...migrated, hexDimensions: { ...migrated.hexDimensions, glacierPercent: 100 } }).hexDimensions.glacierPercent, 100,
      'a glacier share chosen afterwards is kept');
  }
});

test('the old 10% lake share is reset in undo history too, so undo does not bring it back', async () => {
  const { createMapState } = await import('./seededMap.ts');
  const { migrateMap } = await import('../shared/islandMigration.js');
  const map = createMapState('Old lakes', 2, 1);
  delete map.derivedShores;
  map.hexDimensions = { ...map.hexDimensions, lakeLandPercent: 10 };
  map.history = { past: [{ ...map }], future: [{ ...map }] };
  const migrated = migrateMap(map);
  for (const s of [migrated, migrated.history!.past[0]!, migrated.history!.future[0]!]) {
    assert.equal(s.hexDimensions.lakeLandPercent, 0);
    assert.equal(s.derivedShores, true);
  }
});

test('Glacier is land and Sea Ice is water', async () => {
  const { isWater } = await import('../shared/derive.js');
  const { sideOf } = await import('../src/render/coast.js');
  assert.equal(isLandLike('Glacier'), true);
  assert.equal(isWater('Glacier'), false);
  assert.equal(sideOf('Glacier'), 'land');
  assert.equal(isLandLike('Sea Ice'), false);
  assert.equal(isWater('Sea Ice'), true);
  assert.equal(sideOf('Sea Ice'), 'water');
});

test('maps saved with the old Ice type load it as Sea Ice', async () => {
  const { createMapState } = await import('./seededMap.ts');
  const { migrateLegacyIslands } = await import('../shared/islandMigration.js');
  const map = createMapState('Old ice', 3, 1);
  map.layers.base.data = ['Land', 'Ice', 'Sea'] as unknown as BaseGeo[];
  const migrated = migrateLegacyIslands(map);
  assert.deepEqual(migrated.layers.base.data, ['Land', 'Sea Ice', 'Sea']);
  assert.equal(migrateLegacyIslands(migrated), migrated);
});

test('a glacier is shaded by its elevation and sea ice is drawn as a body of pack ice', async () => {
  const { createMapState } = await import('./seededMap.ts');
  const { buildScene, defaultVisibility } = await import('../src/render/scene.js');
  const { resolveStyle } = await import('../src/render/styles.js');
  const map = createMapState('Ice', 4, 1);
  map.layers.base.data = ['Glacier', 'Glacier', 'Sea Ice', 'Sea'];
  map.layers.elevation.data = ['Lowland', 'Mountains', null, null];
  const style = resolveStyle({ preset: 'classic', overrides: { ice: 'glacier', relief: 'marks' } });
  const visible = { ...defaultVisibility(), elevation: true };
  const prims = buildScene(map, { size: 20, visible, labels: false, style }).prims;
  const fills = prims.filter((p) => p.kind === 'polygon' && p.points.length === 6).map((p) => (p as { fill?: string }).fill);
  const glacierFills = new Set(fills.filter((f) => f !== style.palette.sea && f !== style.palette.seaIce));
  assert.equal(glacierFills.size, 1, 'glacier hexes share one colour: height is shaded over the sheet, not stepped hex by hex');
  // Height is shaded over the sheet as soft discs, not hex by hex: dull over low ground, bright over high.
  const discs = prims
    .flatMap((p) => (p.kind === 'group' ? p.prims : []))
    .filter((p): p is Extract<typeof p, { kind: 'circle' }> => p.kind === 'circle');
  const tones = new Set(discs.map((d) => d.fill));
  assert.ok(discs.length >= 3, 'the ice is shaded by its ground');
  assert.ok(tones.size >= 2, 'low and high ice are shaded differently');
  // Sea ice lies on ordinary sea as one body, not as a pale hex.
  assert.ok(!fills.includes(style.palette.seaIce), 'sea ice is not a hex fill');
  const group = prims.find((p) => p.kind === 'group' && p.prims.some((q) => q.kind === 'path' && q.fill === style.palette.seaIce));
  assert.ok(group, 'the pack is a path in the frozen sea\'s colour');
  const floes = (group as { prims: Array<{ kind: string }> }).prims.flatMap((p) => (p.kind === 'group' ? (p as { prims: Array<{ kind: string }> }).prims : [p])).filter((p) => p.kind === 'polygon');
  assert.ok(floes.length >= 2, 'sea ice carries plates');
});
