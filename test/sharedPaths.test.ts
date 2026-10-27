import assert from 'node:assert/strict';
import test from 'node:test';
import type { PathCmd, Prim } from '../src/render/prims.ts';
import { clearSharedPaths, shareUnchangedPaths } from '../src/render/sharedPaths.ts';
import { buildStaticScene } from '../src/render/scene.ts';
import { fixture, options } from '../scripts/render-all-layers-fixture.ts';

const outline = (shift = 0): PathCmd[] => [['M', shift, 0], ...Array.from({ length: 80 }, (_, i) => ['L', shift + i, i % 7] as PathCmd), ['Z']];

test('a long outline rebuilt with equal commands is handed back as the earlier array; a changed one is not', () => {
  clearSharedPaths();
  const first: Prim[] = [{ kind: 'path', d: outline(), fill: '#000000' }, { kind: 'group', clip: outline(1), prims: [] }];
  shareUnchangedPaths(first);
  const same: Prim[] = [{ kind: 'path', d: outline(), fill: '#000000' }, { kind: 'group', clip: outline(1), prims: [] }];
  shareUnchangedPaths(same);
  assert.equal((same[0] as Extract<Prim, { kind: 'path' }>).d, (first[0] as Extract<Prim, { kind: 'path' }>).d);
  assert.equal((same[1] as Extract<Prim, { kind: 'group' }>).clip, (first[1] as Extract<Prim, { kind: 'group' }>).clip);
  const moved = outline();
  moved[40] = ['L', 40, 99];
  const changed: Prim[] = [{ kind: 'path', d: moved, fill: '#000000' }];
  shareUnchangedPaths(changed);
  assert.equal((changed[0] as Extract<Prim, { kind: 'path' }>).d, moved, 'one differing number keeps the new array');
  const short: PathCmd[] = [['M', 0, 0], ['L', 1, 1]];
  const tiny: Prim[] = [{ kind: 'path', d: short, stroke: '#000000' }];
  shareUnchangedPaths(tiny);
  assert.equal((tiny[0] as Extract<Prim, { kind: 'path' }>).d, short);
});

test('after an ownership edit, shared outlines leave the scene equal to an uncached build', () => {
  let map = fixture('shared paths', 20);
  const opts = options();
  buildStaticScene(map, opts);
  const p = map.layers.polities.data!;
  const index = p.owner.findIndex((o, i) => o && map.layers.base.data![i] === 'Land');
  map = structuredClone(map);
  map.layers.polities.data!.owner[index] = p.polities.find(q => q.id !== p.owner[index])!.id;
  assert.deepEqual(buildStaticScene(map, opts), buildStaticScene(structuredClone(map), { ...opts, cache: 'off' }));
});
