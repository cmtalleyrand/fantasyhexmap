import assert from 'node:assert/strict';
import test from 'node:test';
import type { Prim } from '../src/render/prims.ts';
import { assertCachedBuildsMatch, firstDifference, scenePaths } from './helpers/scene.ts';
import type { Scene } from '../src/render/scene.ts';

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

test('the first difference between two scenes is named by its path', () => {
  const a = { prims: [{ kind: 'path', d: [['M', 0, 0], ['L', 1, 2]] }], width: 10 };
  assert.equal(firstDifference(a, structuredClone(a)), null);
  const moved = structuredClone(a); moved.prims[0]!.d[1]![2] = 3;
  assert.equal(firstDifference(a, moved), '.prims[0].d[1][2]');
  assert.equal(firstDifference(a, { ...a, extra: 1 }), '.extra');
  assert.equal(firstDifference([1, 2], [1, 2, 3]), '[2]');
  assert.equal(firstDifference(1, 2), '(root)');
  assert.equal(firstDifference(Number.NaN, Number.NaN), null);
});

test('a cached build that differs from the uncached one fails, naming the case and the difference', () => {
  const scene = (x: number) => ({ width: 1, height: 1, prims: [{ kind: 'circle', c: { x, y: 0 }, r: 1 }] }) as unknown as Scene;
  const cases = [{ name: 'edit/a', map: {} as never, options: { size: 1 } as never }];
  assertCachedBuildsMatch(cases, () => scene(0));
  assert.throws(() => assertCachedBuildsMatch(cases, (_, options) => scene(options.cache === 'off' ? 1 : 0)),
    /edit\/a: the cached build differs from the uncached one at \.prims\[0\]\.c\.x/);
});
