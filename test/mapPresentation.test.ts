import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { contrastingPolityColours } from '../src/render/palette.ts';
import { buildScene, citySymbolForPopulation, defaultVisibility } from '../src/render/scene.ts';

test('city symbols use the four population bands at their exact boundaries', () => {
  assert.equal(citySymbolForPopulation(0), 'village');
  assert.equal(citySymbolForPopulation(10_000), 'village');
  assert.equal(citySymbolForPopulation(10_001), 'town');
  assert.equal(citySymbolForPopulation(50_000), 'town');
  assert.equal(citySymbolForPopulation(50_001), 'city');
  assert.equal(citySymbolForPopulation(250_000), 'city');
  assert.equal(citySymbolForPopulation(250_001), 'metropolis');
});

test('city scene primitives carry the population-band symbol for both screen and export renderers', () => {
  const map = createMapState('City symbols', 4, 1);
  map.layers.base.data = Array(4).fill('Land');
  map.layers.cities.data = {
    cities: [5_000, 25_000, 100_000, 500_000].map((population, col) => ({
      id: `city-${col}`,
      col,
      row: 0,
      name: `City ${col}`,
      population,
      onRiver: false,
      riverId: null,
      coastal: false,
      coastalEdges: [],
    })),
  };
  const visible = defaultVisibility();
  visible.cities = true;

  const symbols = buildScene(map, { size: 20, visible, labels: false }).prims
    .filter((primitive) => primitive.kind === 'city')
    .map((primitive) => primitive.symbol);

  assert.deepEqual(symbols, ['village', 'town', 'city', 'metropolis']);
});

test('map presentation hides tiny polity labels and smooths thicker rivers', () => {
  const map = createMapState('Presentation test', 4, 3);
  map.layers.base.data = Array(12).fill('Land');
  map.layers.polities.data = {
    polities: [
      { id: 'tiny', name: 'Tiny March', colour: '#ff0000' },
      { id: 'large', name: 'The Long Kingdom', shortName: 'Kingdom', colour: '#0000ff' },
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

  assert.deepEqual(labels, ['KINGDOM']);
  assert.equal(polityLabel?.fill, '#14100c');
  assert.equal(polityLabel?.halo, undefined);
  assert.equal(polityLabel?.weight, 600);
  assert.ok(Math.abs(polityLabel?.rotation ?? 0) <= Math.PI / 6);
  assert.ok((polityLabel?.size ?? 0) <= 20 * 0.58);
  const withoutShortName = structuredClone(map);
  delete withoutShortName.layers.polities.data!.polities[1]!.shortName;
  const longLabel = buildScene(withoutShortName, { size: 20, visible, labels: true })
    .prims.find((p) => p.kind === 'text');
  assert.ok((longLabel?.size ?? 0) < (polityLabel?.size ?? 0), 'longer text should shrink to the same available territory');
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

test('polity type size grows with territory area for the same label', () => {
  const sizeFor = (cols: number, rows: number): number => {
    const map = createMapState('Label area test', cols, rows);
    map.layers.base.data = Array(cols * rows).fill('Land');
    map.layers.polities.data = {
      polities: [{ id: 'realm', name: 'Aster', colour: '#2f6fbb' }],
      owner: Array(cols * rows).fill('realm'),
    };
    const visible = defaultVisibility();
    visible.polities = true;
    const label = buildScene(map, { size: 20, visible, labels: true }).prims.find(
      (prim) => prim.kind === 'text',
    );
    assert.ok(label?.kind === 'text');
    return label.size;
  };

  const fourHexes = sizeFor(2, 2);
  const sixteenHexes = sizeFor(4, 4);

  assert.ok(sixteenHexes > fourHexes);
  assert.equal(sixteenHexes / fourHexes, 2);
});
