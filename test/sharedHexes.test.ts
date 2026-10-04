import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { holdersOf } from '../shared/polityShares.ts';
import { politySurfaceAreas, normaliseHexDimensions } from '../shared/surfaceArea.ts';
import type { LayerDataMap, LayerId, MapState } from '../shared/types.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';
import { reducer, type Action } from '../src/state/store.ts';

function mapWithTwoPolities(): MapState {
  let map = createMapState('Shares', 3, 1, 'Shares', ['base', 'polities']);
  const generate = <K extends LayerId>(layer: K, data: LayerDataMap[K]) => {
    map = reducer(map, { type: 'applyGeneration', layer, data, warnings: [], notes: null } as Action);
  };
  generate('base', ['Land', 'Land', 'Sea']);
  generate('polities', {
    polities: [{ id: 'a', name: 'A', colour: '#aa0000' }, { id: 'b', name: 'B', colour: '#0000aa' }],
    owner: ['a', 'a', null],
  });
  return map;
}

test('a hex can be shared between two polities in a chosen proportion', () => {
  const shared = reducer(mapWithTwoPolities(), { type: 'shareHexes', indices: [1], first: 'a', second: 'b', share: 0.25 });
  const data = shared.layers.polities.data!;
  assert.equal(data.owner[1], 'a');
  assert.deepEqual(holdersOf(data, 1), [['a', 0.75], ['b', 0.25]]);
  assert.deepEqual(holdersOf(data, 0), [['a', 1]]);
});

test('the larger holder is the owner, and areas follow the shares', () => {
  const shared = reducer(mapWithTwoPolities(), { type: 'shareHexes', indices: [1], first: 'a', second: 'b', share: 0.75 });
  const data = shared.layers.polities.data!;
  assert.equal(data.owner[1], 'b');
  const areas = politySurfaceAreas(shared.layers.base.data!, data, normaliseHexDimensions(shared.hexDimensions));
  const whole = areas.get('a')! / 1.25; // hex 0 whole + a quarter of hex 1
  assert.ok(Math.abs(areas.get('b')! - whole * 0.75) < 1e-6);
});

test('assigning a shared hex whole ends the sharing; water and bad ids are refused', () => {
  const shared = reducer(mapWithTwoPolities(), { type: 'shareHexes', indices: [1], first: 'a', second: 'b', share: 0.5 });
  const whole = reducer(shared, { type: 'setPolityOwner', indices: [1], polityId: 'b' });
  assert.equal(whole.layers.polities.data!.shares, undefined);
  assert.equal(whole.layers.polities.data!.owner[1], 'b');
  const base = mapWithTwoPolities();
  assert.equal(reducer(base, { type: 'shareHexes', indices: [2], first: 'a', second: 'b', share: 0.5 }), base);
  assert.equal(reducer(base, { type: 'shareHexes', indices: [1], first: 'a', second: 'zzz', share: 0.5 }), base);
  assert.equal(reducer(base, { type: 'shareHexes', indices: [1], first: 'a', second: 'a', share: 0.5 }), base);
});

test('removing a polity leaves its partner the whole hex; global undo reverses sharing', () => {
  const beforeShare = mapWithTwoPolities();
  const shared = reducer(beforeShare, { type: 'shareHexes', indices: [1], first: 'a', second: 'b', share: 0.4 });
  assert.equal(shared.history?.past.length, (beforeShare.history?.past.length ?? 0) + 1);
  const noB = reducer(shared, { type: 'removePolity', id: 'b' }).layers.polities.data!;
  assert.deepEqual(holdersOf(noB, 1), [['a', 1]]);
  const noA = reducer(shared, { type: 'removePolity', id: 'a' }).layers.polities.data!;
  assert.deepEqual(holdersOf(noA, 1), [['b', 1]]);
  assert.equal(noA.owner[0], null);
  const undone = reducer(shared, { type: 'undo' }).layers.polities.data!;
  assert.equal(undone.shares, undefined);
  assert.deepEqual(undone.owner, beforeShare.layers.polities.data!.owner);
});

test('a shared hex that turns to water loses its share', () => {
  const shared = reducer(mapWithTwoPolities(), { type: 'shareHexes', indices: [1], first: 'a', second: 'b', share: 0.4 });
  const flooded = reducer(shared, { type: 'setHexValues', layer: 'base', indices: [1], value: 'Sea' });
  assert.equal(flooded.layers.polities.data!.owner[1], null);
  assert.equal(flooded.layers.polities.data!.shares, undefined);
});

test('a shared hex is drawn with a piece in the second holder\'s colour', () => {
  const map = createMapState('Scene', 2, 1);
  map.layers.base.data = ['Land', 'Land'];
  map.layers.polities.data = {
    polities: [{ id: 'a', name: 'A', colour: '#ff0000' }, { id: 'b', name: 'B', colour: '#0000ff' }],
    owner: ['a', 'a'],
    shares: { '1': { polityId: 'b', share: 0.3 } },
  };
  const visible = defaultVisibility();
  visible.polities = true;
  const scene = buildScene(map, { size: 20, visible, labels: false });
  const pieces = scene.prims.filter((p) => p.kind === 'polygon' && p.points.length < 6);
  assert.ok(pieces.length >= 2, 'expected a clipped polygon for the shared part');
});

test('a shared hex is visible with the parchment wash polity style', () => {
  const map = mapWithTwoPolities();
  map.layers.polities.data!.shares = { '1': { polityId: 'b', share: 0.3 } };
  const visible = defaultVisibility();
  visible.polities = true;
  const scene = buildScene(map, {
    size: 20,
    visible,
    labels: false,
    style: resolveStyle({ preset: 'parchment', overrides: {} }),
  });
  assert.ok(
    scene.prims.some((p) => p.kind === 'polygon' && p.points.length < 6 && p.fill === 'rgba(0, 0, 170, 0.55)'),
    'expected the second polity share to be painted over the wash-style map',
  );
});
