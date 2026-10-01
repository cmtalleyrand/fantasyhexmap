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
  const river = scene.prims.find((p) => p.kind === 'polyline' && p.smooth);

  assert.deepEqual(labels, ['THE LONG KINGDOM']);
  assert.ok(river && river.strokeWidth === 4.25);
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
