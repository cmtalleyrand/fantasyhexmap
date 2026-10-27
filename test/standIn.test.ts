import assert from 'node:assert/strict';
import test from 'node:test';
import { coastGallery } from '../scripts/coast-gallery-fixtures.ts';
import { options } from '../scripts/render-all-layers-fixture.ts';
import { buildStaticScene, exactCoastReady } from '../src/render/scene.ts';

const json = (value: unknown) => JSON.stringify(value);

test('a stand-in draws the unfitted coast, leaves no trace in the caches, and the exact scene follows unchanged', () => {
  const map = coastGallery().find(f => f.name === 'coast-30-Wavy')!.map;
  const opts = { ...options(), labels: false };
  assert.equal(exactCoastReady(map, opts), false);
  const standIn = buildStaticScene(map, { ...opts, standIn: true });
  assert.equal(exactCoastReady(map, opts), false, 'a stand-in coast is never cached as the exact one');
  const exact = buildStaticScene(map, opts);
  assert.equal(exactCoastReady(map, opts), true);
  assert.notEqual(json(standIn.prims), json(exact.prims), 'the stand-in coast is not fitted to the shares');
  assert.equal(json(exact), json(buildStaticScene(map, { ...opts, cache: 'off' })));
  assert.equal(exactCoastReady(map, { ...opts, cache: 'off' }), false);
});
