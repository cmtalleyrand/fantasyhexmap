import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { hexCenter, pixelToOffset } from '../shared/hex.ts';
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
  assert.ok((longLabel?.size ?? 0) <= (polityLabel?.size ?? 0), 'a longer name never gets bigger type in the same territory');
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

test('a polity label lies inside its territory, even for a crescent-shaped realm', () => {
  const cols = 12;
  const rows = 9;
  const map = createMapState('Crescent', cols, rows);
  map.layers.base.data = Array(cols * rows).fill('Land');
  const owner: (string | null)[] = Array(cols * rows).fill(null);
  // A "U": two tall arms joined by a base. The centroid falls in the hole.
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const arm = col <= 1 || col >= cols - 2;
      const base = row >= rows - 2;
      if (arm || base) owner[row * cols + col] = 'u';
    }
  }
  map.layers.polities.data = { polities: [{ id: 'u', name: 'Valdoria', colour: '#aa3333' }], owner };
  const visible = defaultVisibility();
  visible.polities = true;
  const size = 20;
  const label = buildScene(map, { size, visible, labels: true }).prims.find((p) => p.kind === 'text');
  assert.ok(label?.kind === 'text');
  const half = (label.text.length * label.size * 0.66) / 2;
  const cos = Math.cos(label.rotation ?? 0);
  const sin = Math.sin(label.rotation ?? 0);
  for (const t of [-1, -0.5, 0, 0.5, 1]) {
    const x = label.at.x + t * half * cos;
    const y = label.at.y + t * half * sin;
    const { col, row } = pixelToOffset(x, y, size);
    assert.equal(owner[row * cols + col], 'u', `label sample ${t} must sit on owned land`);
  }
});

test('a polity label steers clear of a city marker inside the territory', () => {
  const cols = 8;
  const rows = 5;
  const map = createMapState('Obstacle', cols, rows);
  map.layers.base.data = Array(cols * rows).fill('Land');
  map.layers.polities.data = {
    polities: [{ id: 'r', name: 'Realm', colour: '#3355aa' }],
    owner: Array(cols * rows).fill('r'),
  };
  const centre = { col: 4, row: 2 };
  map.layers.cities.data = {
    cities: [{
      id: 'c', col: centre.col, row: centre.row, name: 'Capital', population: 100_000,
      onRiver: false, riverId: null, coastal: false, coastalEdges: [],
    }],
  };
  const visible = defaultVisibility();
  visible.polities = true;
  visible.cities = true;
  const size = 20;
  const prims = buildScene(map, { size, visible, labels: true }).prims;
  const label = prims.find((p) => p.kind === 'text' && p.fantasy);
  assert.ok(label?.kind === 'text');
  const city = hexCenter(centre.col, centre.row, size);
  const half = (label.text.length * label.size * 0.66) / 2;
  assert.ok(
    Math.abs(label.at.y - city.y) > label.size * 0.55 || Math.abs(label.at.x - city.x) > half + size * 0.4,
    'polity name must not sit on the city marker',
  );
});

test('a long unbreakable name shrinks, but a multi-word name wraps to keep larger type', () => {
  const label = (name: string) => {
    const map = createMapState('Wrap', 4, 4);
    map.layers.base.data = Array(16).fill('Land');
    map.layers.polities.data = {
      polities: [{ id: 'r', name, colour: '#3355aa' }],
      owner: Array(16).fill('r'),
    };
    const visible = defaultVisibility();
    visible.polities = true;
    return buildScene(map, { size: 20, visible, labels: true }).prims.filter(
      (p) => p.kind === 'text' && p.fantasy,
    ) as Extract<ReturnType<typeof buildScene>['prims'][number], { kind: 'text' }>[];
  };
  const short = label('Aster');
  const unbreakable = label('Asterhaventhorpeshire');
  const wrapped = label('Aster Haven Thorpe Shire');
  assert.equal(short.length, 1);
  assert.equal(unbreakable.length, 1);
  assert.ok(unbreakable[0]!.size < short[0]!.size, 'one long word has nowhere to wrap, so it shrinks');
  assert.equal(wrapped.length, 2, 'a long multi-word name is split over two lines');
  assert.deepEqual(wrapped.map((l) => l.text), ['ASTER HAVEN', 'THORPE SHIRE']);
  assert.ok(wrapped[0]!.size > unbreakable[0]!.size, 'wrapping keeps type larger than the unbroken equivalent');
  assert.ok(wrapped[0]!.at.y < wrapped[1]!.at.y, 'lines stack top to bottom');
});

test('polity opacity below 1 makes the fill translucent so terrain shows through', () => {
  const map = createMapState('Polity opacity test', 1, 1);
  map.layers.base.data = ['Land'];
  map.layers.polities.data = {
    polities: [{ id: 'realm', name: 'Realm', colour: '#2f6fbb' }],
    owner: ['realm'],
  };
  const visible = defaultVisibility();
  visible.polities = true;
  const lastFill = (polityOpacity?: number) =>
    buildScene(map, { size: 20, visible, labels: false, polityOpacity }).prims
      .filter((p) => p.kind === 'polygon').at(-1)?.fill;

  assert.equal(lastFill(), '#2f6fbb');
  assert.equal(lastFill(1), '#2f6fbb');
  assert.equal(lastFill(0.4), 'rgba(47, 111, 187, 0.4)');
});

test('uniform land draws coastal and inland land in the same base colour', () => {
  const map = createMapState('Uniform land test', 2, 1);
  map.layers.base.data = ['Land', 'Coastal Land'];
  const fills = (uniformLand: boolean) =>
    buildScene(map, { size: 20, visible: defaultVisibility(), labels: false, uniformLand }).prims
      .filter((p) => p.kind === 'polygon').map((p) => p.fill);

  const [inland, coastal] = fills(false);
  assert.notEqual(inland, coastal);
  const [uniformInland, uniformCoastal] = fills(true);
  assert.equal(uniformInland, uniformCoastal);
  assert.equal(uniformInland, inland);
});

test('the polity-name threshold decides which small polities are named', () => {
  // A 6x1 strip: "big" owns four hexes, "small" owns two.
  const named = (polityNames: Parameters<typeof buildScene>[1]['polityNames']) => {
    const map = createMapState('Thresholds', 6, 1);
    map.layers.base.data = Array(6).fill('Land');
    map.layers.polities.data = {
      polities: [
        { id: 'big', name: 'Bigland', colour: '#3355aa' },
        { id: 'small', name: 'Sm', colour: '#aa5533' },
      ],
      owner: ['big', 'big', 'big', 'big', 'small', 'small'],
    };
    const visible = defaultVisibility();
    visible.polities = true;
    return buildScene(map, { size: 20, visible, labels: true, polityNames }).prims
      .filter((p) => p.kind === 'text' && p.fantasy)
      .map((p) => (p as { text: string }).text);
  };
  assert.deepEqual(named(undefined), ['BIGLAND'], 'default keeps the old four-hex cut-off');
  assert.deepEqual(named(5), [], 'five-hex threshold hides both');
  assert.ok(named(2).includes('SM'), 'a two-hex polity is named at threshold 2');
  assert.ok(named(0).includes('SM'));
  assert.ok(!named(3).includes('SM'));
  assert.ok(named(3).includes('BIGLAND'));
});
