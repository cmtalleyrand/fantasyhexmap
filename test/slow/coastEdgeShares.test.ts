import assert from 'node:assert/strict';
import test from 'node:test';
import frozen from '../fixtures/populated-40.json';
import { migrateMap } from '../../shared/islandMigration.ts';
import type { MapState } from '../../shared/types.ts';
import { buildScene, defaultVisibility } from '../../src/render/scene.ts';
import { NEW_USER_STYLE_CHOICE, resolveStyle } from '../../src/render/styles.ts';

test('the populated map keeps its land shares where the coast meets the page edge', () => {
  const map = migrateMap(structuredClone(frozen) as MapState);
  const scene = buildScene(map, { size: 30, style: resolveStyle(NEW_USER_STYLE_CHOICE),
    visible: defaultVisibility(), labels: false, cache: 'off' });
  // The final detail fit used to leave edge hex 520 above tolerance. Its repair
  // must also preserve the neighbouring shares, rather than move the miss elsewhere.
  const misses = scene.compromises?.filter(c => c.what.includes('land drawn')) ?? [];
  assert.deepEqual(misses, []);
});
