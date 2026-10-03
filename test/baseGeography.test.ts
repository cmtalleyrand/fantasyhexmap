import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeBase, encodeBase } from '../shared/codec.js';
import { isLandLike } from '../shared/derive.js';
import type { BaseGeo } from '../shared/types.js';

test('Coastal Land round-trips through the base-grid codec as land-like terrain', () => {
  const base: BaseGeo[] = ['Land', 'Coastal Land', 'Sea', 'Lake', 'Glacier', 'Sea Ice', 'Islands', 'Mainland and islands', 'Isthmus', 'Strait'];

  const encoded = encodeBase(base, 10, 1);
  const decoded = decodeBase(encoded, 10, 1);

  assert.deepEqual(encoded, ['tcmlgfikns']);
  assert.deepEqual(decoded, { data: base, warnings: [] });
  assert.equal(isLandLike(decoded.data[1]), true);
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
  const { createMapState } = await import('../shared/layers.js');
  const { migrateLegacyIslands } = await import('../shared/islandMigration.js');
  const map = createMapState('Old ice', 3, 1);
  map.layers.base.data = ['Land', 'Ice', 'Sea'] as unknown as BaseGeo[];
  const migrated = migrateLegacyIslands(map);
  assert.deepEqual(migrated.layers.base.data, ['Land', 'Sea Ice', 'Sea']);
  assert.equal(migrateLegacyIslands(migrated), migrated);
});

test('a glacier is shaded by its elevation and sea ice is drawn as a body of pack ice', async () => {
  const { createMapState } = await import('../shared/layers.js');
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
