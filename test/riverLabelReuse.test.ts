import assert from 'node:assert/strict';
import test from 'node:test';
import { clearRiverLabelCache, placeRiverLabels } from '../src/render/featureLabels.ts';
import type { OrientedBox } from '../src/render/labels.ts';
import { beginRenderProfile, endRenderProfile } from '../src/render/profile.ts';
import { buildStaticScene } from '../src/render/scene.ts';
import { fixture, options } from '../scripts/render-all-layers-fixture.ts';
import { assertRebuildMatchesUncached } from './helpers/scene.ts';

const SIZE = 26;
function rng(seed: number) {
  return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
}
function rivers() {
  const rivers = fixture('river reuse', 30).layers.rivers.data!.rivers;
  assert.ok(rivers.filter(r => r.name.trim()).length >= 4, 'fixture needs several named rivers');
  return rivers;
}
const wet = (p: { x: number; y: number }) => Math.sin(p.x / 37) + Math.cos(p.y / 23) > 1.7;
const land = (p: { x: number; y: number }) => Math.sin(p.x / 53 + p.y / 41) > -0.9;

function counted<T>(work: () => T): { result: T; hits: number; searches: number } {
  beginRenderProfile();
  const result = work();
  const profile = endRenderProfile()!;
  return { result, hits: profile.counters['riverLabels.riverHits'] ?? 0, searches: profile.counters['riverLabels.riverSearches'] ?? 0 };
}

test('per-river reuse equals a fresh search after random obstacle moves, additions and removals', () => {
  clearRiverLabelCache();
  const list = rivers(), random = rng(7);
  const width = 30 * SIZE * 1.8, height = 30 * SIZE * 1.6;
  const box = (): OrientedBox => ({ cx: random() * width, cy: random() * height, halfW: 10 + random() * 60,
    halfH: 6 + random() * 20, rotation: (random() - 0.5) * Math.PI });
  let boxes = Array.from({ length: 12 }, box);
  let reused = 0;
  for (let step = 0; step < 40; step++) {
    const roll = random();
    if (roll < 0.4) boxes[Math.floor(random() * boxes.length)] = box();
    else if (roll < 0.7) boxes = [...boxes, box()];
    else if (boxes.length > 1) boxes = boxes.filter((_, i) => i !== Math.floor(random() * boxes.length));
    const fresh = placeRiverLabels(list, SIZE, undefined, undefined, boxes, undefined, wet, undefined, land);
    const { result, hits } = counted(() => placeRiverLabels(list, SIZE, undefined, undefined, boxes, undefined, wet, undefined, land, 'ctx'));
    assert.deepEqual(result, fresh, `step ${step}`);
    reused += hits;
  }
  assert.ok(reused > 0, 'distant obstacle edits must reuse rivers');
});

test('a box touching only one river re-searches that river and its successors near it, not the rest', async () => {
  clearRiverLabelCache();
  const list = rivers();
  const named = list.filter(r => r.name.trim()).length;
  placeRiverLabels(list, SIZE, undefined, undefined, [], undefined, undefined, undefined, undefined, 'ctx');
  const far: OrientedBox = { cx: -5000, cy: -5000, halfW: 20, halfH: 10, rotation: 0.3 };
  const distant = counted(() => placeRiverLabels(list, SIZE, undefined, undefined, [far], undefined, undefined, undefined, undefined, 'ctx'));
  assert.equal(distant.searches, 0);
  assert.equal(distant.hits, named);
  // A box on one river's course re-searches that river (and any later river it
  // reaches), while rivers out of its reach are reused.
  const { hexCenter } = await import('../shared/hex.ts');
  const target = list.find(r => r.name.trim())!, segment = target.segments[Math.floor(target.segments.length / 2)]!;
  const mid = hexCenter(segment.col, segment.row, SIZE);
  const near: OrientedBox = { cx: mid.x, cy: mid.y, halfW: 8, halfH: 8, rotation: 0 };
  const local = counted(() => placeRiverLabels(list, SIZE, undefined, undefined, [far, near], undefined, undefined, undefined, undefined, 'ctx'));
  assert.ok(local.searches >= 1 && local.searches < named, `searches ${local.searches} of ${named}`);
  assert.deepEqual(local.result, placeRiverLabels(list, SIZE, undefined, undefined, [far, near]));
  // A changed context (land, lakes or measurements) invalidates every river.
  const other = counted(() => placeRiverLabels(list, SIZE, undefined, undefined, [far], undefined, undefined, undefined, undefined, 'ctx2'));
  assert.equal(other.hits, 0);
});

test('scene rebuilds after ownership edits equal uncached rebuilds and reuse rivers', () => {
  // A small map with two named rivers: the random-obstacle test above covers the reuse's exactness.
  let map = fixture('river reuse scene', 12);
  assert.ok(map.layers.rivers.data!.rivers.filter(r => r.name.trim()).length >= 2, 'fixture needs two named rivers');
  const opts = options();
  buildStaticScene(map, opts);
  const p = map.layers.polities.data!;
  const cells = p.owner.flatMap((owner, i) => owner && map.layers.base.data![i] === 'Land' ? [i] : []);
  let hits = 0;
  // On so small a map the first edits move a realm name near both rivers; later ones reach only one.
  for (const index of cells.slice(0, 6)) {
    const owner = [...map.layers.polities.data!.owner];
    owner[index] = p.polities.find(polity => polity.id !== owner[index])!.id;
    map = { ...map, layers: { ...map.layers, polities: { ...map.layers.polities, data: { ...map.layers.polities.data!, owner } } } };
    const { result, hits: reused } = counted(() => buildStaticScene(map, opts));
    hits += reused;
    assertRebuildMatchesUncached(map, opts, `ownership at ${index}`, result);
  }
  assert.ok(hits > 0, 'ownership edits should reuse at least some river names');
});
