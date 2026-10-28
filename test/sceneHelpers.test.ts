import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prim } from '../src/render/prims.ts';
import { scenePaths } from './helpers/scene.ts';

test('scene paths include nested groups in paint order without copying or transforming geometry', () => {
  const path = (x: number): Extract<Prim, { kind: 'path' }> => ({ kind: 'path', d: [['M', x, 0], ['L', x, 1]] });
  const first = path(1), nested = path(2), last = path(3);
  const prims: Prim[] = [first, { kind: 'group', translate: { x: 10, y: 20 }, prims: [
    { kind: 'circle', c: { x: 0, y: 0 }, r: 1 },
    { kind: 'group', clip: [['M', 0, 0], ['Z']], prims: [nested] },
    { kind: 'group', prims: [] },
  ] }, last];
  const before = structuredClone(prims);
  const paths = scenePaths(prims);
  assert.deepEqual(paths, [first, nested, last]);
  paths.forEach((p, i) => assert.equal(p, [first, nested, last][i]));
  assert.deepEqual(prims, before);
  assert.deepEqual(scenePaths([]), []);
});
