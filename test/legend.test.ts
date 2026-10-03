import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import type { MapState } from '../shared/types.ts';
import { buildExportScene } from '../src/render/export.ts';
import {
  DEFAULT_LEGEND_OPTIONS,
  legendLayers,
  legendSections,
  type LegendOptions,
} from '../src/render/legend.ts';
import { buildScene, defaultVisibility, type VisibleLayers } from '../src/render/scene.ts';
import { sceneToSvg } from '../src/render/svg.ts';

function sampleMap(): MapState {
  const map = createMapState('A small realm.', 3, 2, 'Test Realm');
  map.layers.base.data = ['Land', 'Coastal Land', 'Sea', 'Land', 'Land', 'Sea'];
  map.layers.elevation.data = ['Hills', 'Lowland', null, 'Hills', 'Mountains', null];
  map.layers.climate.data = ['Cfb', 'Cfb', null, 'Dfc', 'Dfc', null];
  map.layers.vegetation.data = ['Prairie', 'Prairie', null, 'Boreal Forest', 'Boreal Forest', null];
  map.layers.rivers.data = {
    rivers: [{
      id: 'r1',
      name: 'Aln',
      segments: [{ col: 0, row: 0, entryEdge: null, exitEdge: 1, navigable: false }],
    }],
  } as never;
  map.layers.cities.data = {
    cities: [
      { id: 'c1', col: 0, row: 0, name: 'Alder', population: 8_000, onRiver: true, riverId: 'r1', coastalEdges: [] },
      { id: 'c2', col: 1, row: 0, name: 'Brack', population: 300_000, onRiver: false, riverId: null, coastalEdges: [2] },
    ],
  } as never;
  map.layers.polities.data = {
    polities: [
      { id: 'p1', name: 'Northmark', colour: '#aa0000' },
      { id: 'p2', name: 'Unused Kingdom', colour: '#00aa00' },
    ],
    owner: ['p1', 'p1', null, 'p1', 'p1', null],
  };
  map.layers.population.data = [500, 1200, null, 40, 900, null];
  return map;
}

function visibility(...on: Array<keyof VisibleLayers>): VisibleLayers {
  const v = defaultVisibility();
  for (const id of on) v[id] = true;
  return v;
}

const opts = (over: Partial<LegendOptions> = {}): LegendOptions => ({ ...DEFAULT_LEGEND_OPTIONS, ...over });
const titles = (map: MapState, v: VisibleLayers, o = opts(), style: 'colour' | 'contours' = 'colour') =>
  legendSections(map, v, style, o).map((s) => s.id);

test('legend follows what the scene paints, not everything that is switched on', () => {
  const map = sampleMap();
  // Vegetation outranks climate and elevation for the hex fill, so only it is described.
  assert.deepEqual(titles(map, visibility('elevation', 'climate', 'vegetation')), ['base', 'vegetation']);
  assert.deepEqual(titles(map, visibility('climate', 'elevation')), ['base', 'climate']);
  // Contour-style elevation does not paint a fill, so it coexists with another fill layer.
  assert.deepEqual(titles(map, visibility('elevation', 'climate'), opts(), 'contours'), ['base', 'elevation', 'climate']);
  // A hidden base contributes nothing.
  const noBase = visibility('rivers');
  noBase.base = false;
  assert.deepEqual(titles(map, noBase), ['rivers']);
  // Layers without data are never offered.
  map.layers.rivers.data = null;
  assert.deepEqual(legendLayers(map, visibility('rivers', 'cities')), ['base', 'cities']);
});

test('onlyUsed trims entries to values on the map; turning it off lists the full vocabulary', () => {
  const map = sampleMap();
  const used = legendSections(map, visibility('vegetation'), 'colour', opts());
  assert.deepEqual(used.find((s) => s.id === 'base')!.entries.map((e) => e.label), ['Land', 'Coastal Land', 'Sea']);
  assert.deepEqual(used.find((s) => s.id === 'vegetation')!.entries.map((e) => e.label), ['Prairie', 'Boreal Forest']);

  const all = legendSections(map, visibility('vegetation'), 'colour', opts({ onlyUsed: false }));
  assert.equal(all.find((s) => s.id === 'base')!.entries.length, 10, 'every base value, the four island types included');
  assert.equal(all.find((s) => s.id === 'vegetation')!.entries.length, 19);
});

test('exclude removes whole sections', () => {
  const map = sampleMap();
  assert.deepEqual(titles(map, visibility('rivers', 'cities'), opts({ exclude: ['base', 'rivers'] })), ['cities']);
});

test('cities, rivers and polities list only what occurs, with optional areas', () => {
  const map = sampleMap();
  const v = visibility('rivers', 'cities', 'polities');
  const by = (o: LegendOptions) => Object.fromEntries(legendSections(map, v, 'colour', o).map((s) => [s.id, s.entries.map((e) => e.label)]));

  const lean = by(opts());
  assert.deepEqual(lean.rivers, ['Non-navigable river']);
  assert.deepEqual(lean.cities!.map((l) => l.split(' (')[0]), ['Village', 'Metropolis', 'Blue centre: on a river', 'Dashed edge: borders sea or lake']);
  assert.deepEqual(lean.polities, ['Northmark']);

  const full = by(opts({ onlyUsed: false, polityAreas: true }));
  assert.equal(full.rivers!.length, 2);
  assert.equal(full.cities!.length, 6);
  assert.equal(full.polities!.length, 2);
  assert.match(full.polities![0]!, /^Northmark - [\d.,]+ .+²$/);
});

test('population is a single ramp entry carrying the real maximum', () => {
  const [section] = legendSections(sampleMap(), visibility('population'), 'colour', opts({ exclude: ['base'] }));
  assert.equal(section!.entries.length, 1);
  assert.equal(section!.entries[0]!.swatch.kind, 'ramp');
  assert.match(section!.entries[0]!.label, /1,?200/);
});

test('an export with a legend is wider than the bare map and shares its prims', () => {
  const map = sampleMap();
  const v = visibility('vegetation', 'rivers', 'cities', 'polities');
  const bare = buildExportScene(map, v, { format: 'png', labels: true });
  const withLegend = buildExportScene(map, v, { format: 'png', labels: true, legend: opts() });

  assert.ok(withLegend.width > bare.width);
  assert.ok(withLegend.height >= bare.height);
  assert.deepEqual(withLegend.prims.slice(0, bare.prims.length), bare.prims);
  const labels = withLegend.prims.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text);
  for (const expected of ['Test Realm', 'Vegetation', 'Prairie', 'Northmark', 'Non-navigable river']) {
    assert.ok(labels.includes(expected), `missing legend text: ${expected}`);
  }
  assert.ok(!labels.includes('Unused Kingdom'));
  // Both back ends see the same extended canvas.
  assert.match(sceneToSvg(withLegend, 't'), new RegExp(`width="${Math.round(withLegend.width * 100) / 100}"`));
});

test('no legend sections, or no legend option, leaves the scene untouched', () => {
  const map = sampleMap();
  const v = visibility();
  v.base = false;
  const bare = buildScene(map, { size: 32, visible: v, labels: false });
  const scene = buildExportScene(map, v, { format: 'png', labels: false, legend: opts() });
  assert.equal(scene.width, bare.width);
  assert.deepEqual(scene.prims, bare.prims);
});

test('the legend title can be omitted', () => {
  const map = sampleMap();
  const scene = buildExportScene(map, visibility(), { format: 'png', labels: false, legend: opts({ title: false }) });
  const texts = scene.prims.filter((p) => p.kind === 'text').map((p) => (p as { text: string }).text);
  assert.ok(!texts.includes('Test Realm'));
  assert.ok(texts.includes('Base Geography'));
});

test('a long legend continues in a further column rather than growing without bound', () => {
  const map = sampleMap();
  // 21 climate entries plus base can't fit beside a 3x2 map's height.
  const scene = buildExportScene(map, visibility('climate'), {
    format: 'png', labels: false, legend: opts({ onlyUsed: false }),
  });
  const heads = scene.prims
    .filter((p) => p.kind === 'text')
    .map((p) => (p as { text: string }).text)
    .filter((t) => t.endsWith('(continued)'));
  assert.ok(heads.length > 0);
  assert.ok(scene.height < 30 * 22 + 100, 'column height stays bounded');
});
