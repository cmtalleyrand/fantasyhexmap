import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRebuildMatchesUncached } from './helpers/scene.ts';
import { buildStaticScene, defaultVisibility } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';
import { createMapState } from './seededMap.ts';

test('rebuild equality reports the edit and nested prim, and also checks scene metadata', () => {
  const map = createMapState('Rebuild diagnostic', 3, 3);
  map.layers.base.data = Array(9).fill('Sea'); map.layers.base.data[4] = 'Land';
  const options = { size: 20, visible: defaultVisibility(), labels: false,
    style: resolveStyle({ preset: 'parchment', overrides: { coast: 'smooth' } }) };
  const scene = buildStaticScene(map, options);
  assertRebuildMatchesUncached(map, options, 'unchanged', scene);
  const changed = structuredClone(scene);
  const index = changed.prims.findIndex(p => p.kind === 'group' && p.prims.length > 0);
  const group = changed.prims[index];
  assert.ok(group?.kind === 'group');
  group.prims = [];
  assert.throws(() => assertRebuildMatchesUncached(map, options, 'shore edit', changed), error =>
    error instanceof assert.AssertionError && error.message.includes(`shore edit: first difference at scene.prims[${index}].prims[0]`));
  assert.throws(() => assertRebuildMatchesUncached(map, options, 'resize', { ...scene, width: scene.width + 1 }),
    /resize: first difference at scene.width/);
});
