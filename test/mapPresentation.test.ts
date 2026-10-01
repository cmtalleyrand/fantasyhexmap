import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { contrastingPolityColours } from '../src/render/palette.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';

test('map presentation hides tiny polity labels and smooths thicker rivers', () => {
  const map = createMapState('Presentation test', 4, 3);
  map.layers.base.data = Array(12).fill('Land');
  map.layers.polities.data = {
    polities: [
      { id: 'tiny', name: 'Tiny March', colour: '#ff0000' },
      { id: 'large', name: 'The Long Kingdom', colour: '#0000ff' },
    ],
    owner: ['tiny', 'tiny', null, null, 'tiny', 'large', 'large', null, null, 'large', 'large', null],
  };
  map.layers.rivers.data = {
    rivers: [{
      id: 'r', name: 'River', terminus: 'OffMap',
      segments: [
        { col: 0, row: 0, entryEdge: null, exitEdge: 1, navigable: true },
        { col: 0, row: 1, entryEdge: 4, exitEdge: 1, navigable: true },
      ],
    }],
  };
  const visible = defaultVisibility();
  visible.polities = true;
  visible.rivers = true;
  const scene = buildScene(map, { size: 20, visible, labels: true });
  const labels = scene.prims.filter((p) => p.kind === 'text').map((p) => p.text);
  const polityLabel = scene.prims.find((p) => p.kind === 'text');
  const river = scene.prims.find((p) => p.kind === 'polyline' && p.smooth);

  assert.deepEqual(labels, ['THE LONG KINGDOM']);
  assert.equal(polityLabel?.halo, 'rgba(20,16,12,0.88)');
  assert.equal(polityLabel?.weight, 600);
  assert.notEqual(polityLabel?.rotation, 0);
  assert.ok(river && river.strokeWidth === 4.25);
});

test('terrain-mark elevation preserves geography colours and encodes height with strokes', () => {
  const map = createMapState('Elevation marks', 3, 1);
  map.layers.base.data = ['Land', 'Coastal Land', 'Land'];
  map.layers.elevation.data = ['Lowland', 'Plateau', 'Mountains'];
  const visible = defaultVisibility();
  visible.elevation = true;

  const scene = buildScene(map, {
    size: 20,
    visible,
    labels: false,
    elevationStyle: 'contours',
  });
  const fills = scene.prims.filter((p) => p.kind === 'polygon').map((p) => p.fill);
  const marks = scene.prims.filter(
    (p) => p.kind === 'polyline' && p.stroke === 'rgba(37,30,22,0.72)',
  );

  assert.deepEqual(fills, ['#c4d49b', '#d9c58f', '#c4d49b']);
  assert.equal(marks.length, 6);
  assert.equal(marks.filter((p) => p.points.length === 2).length, 2);
  assert.equal(marks.filter((p) => p.points.length === 3).length, 4);
});

test('contrasting polity colours separate adjacent realms deterministically', () => {
  const colours = contrastingPolityColours(
    ['west', 'east', 'south'],
    ['west', 'east', 'west', 'south'],
    2,
    2,
  );
  assert.equal(colours.size, 3);
  assert.notEqual(colours.get('west'), colours.get('east'));
  assert.notEqual(colours.get('west'), colours.get('south'));
  assert.deepEqual(colours, contrastingPolityColours(['west', 'east', 'south'], ['west', 'east', 'west', 'south'], 2, 2));
});

test('contrasting polity colours remain distinct beyond the twelve curated colours', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `realm-${i}`);
  const colours = contrastingPolityColours(ids, ids, ids.length, 1);

  assert.equal(colours.size, ids.length);
  assert.equal(new Set(colours.values()).size, ids.length);
});

test('polity fills are opaque and independent of underlying thematic colours', () => {
  const map = createMapState('Polity colour test', 1, 1);
  map.layers.base.data = ['Coastal Land'];
  map.layers.elevation.data = ['Mountains'];
  map.layers.polities.data = {
    polities: [{ id: 'realm', name: 'Realm', colour: '#2f6fbb' }],
    owner: ['realm'],
  };
  const visible = defaultVisibility();
  visible.polities = true;

  const baseScene = buildScene(map, { size: 20, visible, labels: false });
  visible.elevation = true;
  const elevationScene = buildScene(map, { size: 20, visible, labels: false });
  const polityFill = (scene: ReturnType<typeof buildScene>) =>
    scene.prims.filter((p) => p.kind === 'polygon').at(-1)?.fill;

  assert.equal(polityFill(baseScene), '#2f6fbb');
  assert.equal(polityFill(elevationScene), '#2f6fbb');
});
