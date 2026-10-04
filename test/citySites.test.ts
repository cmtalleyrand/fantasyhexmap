import test from 'node:test';
import assert from 'node:assert/strict';
import { citySite } from '../src/render/sites.ts';
import { landTest, surfaceMap, surfaceEdges } from '../src/render/coast.ts';
import { hexCenter } from '../shared/hex.ts';
import type { BaseGeo, City } from '../shared/types.ts';
import { createMapState } from '../shared/layers.ts';
import { reducer } from '../src/state/store.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';

const size = 20;
const S: BaseGeo = 'Sea';
const L: BaseGeo = 'Land';
const I: BaseGeo = 'Isthmus';

test('a port in an isthmus hex stands on the neck, not out in the water of its rim', () => {
  // The isthmus (index 12) joins land to the west and east, with sea north and south.
  const base: BaseGeo[] = [S, S, S, S, S, L, S, S, S, S, S, L, I, L, S, S, S, S, S, S, S, S, S, S, S].map((b, i) => (i === 11 || i === 13 ? L : b));
  const map = surfaceMap(base, 5, 5);
  const onLand = landTest(map, new Map(), size);
  const city = { id: 'c', col: 2, row: 2, coastalEdges: [1, 2], onRiver: false } as unknown as City;
  const c = hexCenter(2, 2, size);
  const p = citySite(city, { size, base, cols: 5, onLand });
  assert.ok(onLand(p), 'the city is on land');
  assert.ok(Math.hypot(p.x - c.x, p.y - c.y) < size * 0.5, 'and near the neck');
  void surfaceEdges;
});

const lakeRow = (...cells: BaseGeo[]) => cells;

test('land between two lakes is recognised only when the lakes are not neighbours', async () => {
  const { lakeEdgesOf, isLakeNeck, resolvedSite } = await import('../src/render/sites.ts');
  const Lk: BaseGeo = 'Lake';
  // Row 0 of a 3x1 grid: lake, land, lake - the middle hex has lake on its east and west edges.
  const base = lakeRow(Lk, L, Lk);
  const edges = lakeEdgesOf({ col: 1, row: 0 }, base, 3);
  assert.deepEqual(edges, [0, 3]);
  assert.ok(isLakeNeck(edges));
  assert.ok(!isLakeNeck([0, 1]), 'neighbouring lake edges are one bay');
  assert.ok(isLakeNeck([0, 2]), 'lakes two edges apart leave a pass between them');
  assert.ok(!isLakeNeck([]));
  const city = { id: 'c', col: 1, row: 0, name: 'C', population: 100, onRiver: false, riverId: null, coastal: true, coastalEdges: [0, 3] } as City;
  assert.equal(resolvedSite(city, edges).kind, 'neck', 'auto picks the neck');
  assert.equal(resolvedSite(city).kind, 'coast', 'without the lake edges it is an ordinary shore');
  assert.equal(resolvedSite({ ...city, site: 'neck' }, edges).kind, 'neck');
  assert.equal(resolvedSite({ ...city, site: 'neck' }, [0]).kind, 'coast', 'neck is impossible without a second lake');
  assert.equal(resolvedSite({ ...city, onRiver: true, riverId: 'r' }, edges).kind, 'port', 'a river keeps its priority');
});

test('a city between two lakes stands midway between them, on land', async () => {
  const { citySite } = await import('../src/render/sites.ts');
  const Lk: BaseGeo = 'Lake';
  const base = lakeRow(Lk, L, Lk);
  const city = { id: 'c', col: 1, row: 0, name: 'C', population: 100, onRiver: false, riverId: null, coastal: true, coastalEdges: [0, 3] } as City;
  const c = hexCenter(1, 0, size);
  const p = citySite(city, { size, base, cols: 3 });
  assert.ok(Math.hypot(p.x - c.x, p.y - c.y) < 1e-9, 'opposite lakes put it at the centre');
  // A land strip only the middle third of the hex wide: the city stays on it.
  const onLand = (q: { x: number; y: number }) => Math.abs(q.x - c.x) < size * 0.3;
  const q = citySite(city, { size, base, cols: 3, onLand });
  assert.ok(onLand(q));
});

test('a city can be placed toward a corner, back from the shore, or at a free offset', async () => {
  const { citySite, resolvedSite } = await import('../src/render/sites.ts');
  const base: BaseGeo[] = Array(9).fill('Land');
  const city = { id: 'c', col: 1, row: 1, name: 'C', population: 100, onRiver: false, riverId: null, coastal: true, coastalEdges: [0] } as City;
  const c = hexCenter(1, 1, size);
  const ctx = { size, base, cols: 3 };
  const corner = citySite({ ...city, site: { corner: 1 } }, ctx);
  assert.ok(corner.x > c.x && corner.y > c.y, 'corner 1 is the south-east corner');
  const corner6 = citySite({ ...city, site: { corner: 7 } }, ctx);
  assert.deepEqual(corner6, corner, 'corners wrap round');
  const back = citySite({ ...city, site: 'landward' }, ctx);
  assert.ok(back.x < c.x && Math.abs(back.y - c.y) < 1e-9, 'landward is away from the east shore');
  assert.equal(resolvedSite({ ...city, coastalEdges: [], site: 'landward' }).kind, 'inland');
  const free = citySite({ ...city, site: { offset: { x: 0.3, y: -0.2 } } }, ctx);
  assert.ok(Math.abs(free.x - (c.x + 0.3 * size)) < 1e-9 && Math.abs(free.y - (c.y - 0.2 * size)) < 1e-9);
  const far = citySite({ ...city, site: { offset: { x: 5, y: 0 } } }, ctx);
  assert.ok(far.x - c.x <= size * 0.8 + 1e-9, 'an offset stays inside the hex');
});

test('an island city uses its island centre as the origin without ignoring its chosen site', () => {
  const base: BaseGeo[] = ['Islands'];
  const island = { x: 14, y: 11 };
  const city = {
    id: 'island-city', col: 0, row: 0, name: 'C', population: 100,
    onRiver: false, riverId: null, coastal: true, coastalEdges: [0],
  } as City;
  const onLand = (p: { x: number; y: number }) => Math.hypot(p.x - island.x, p.y - island.y) <= size * 0.7;
  const ctx = { size, base, cols: 1, islandCentre: () => island, onLand };

  assert.deepEqual(citySite({ ...city, site: 'inland' }, ctx), island);
  const east = citySite({ ...city, site: { coast: 0 } }, ctx);
  assert.ok(east.x > island.x, 'a coastal choice moves the marker east of the island centre');
  assert.ok(onLand(east), 'the chosen point is constrained to the island rather than skipped');
  const offset = citySite({ ...city, site: { offset: { x: -0.2, y: 0.1 } } }, ctx);
  assert.ok(offset.x < island.x && offset.y > island.y, 'a custom offset is relative to the island centre');
});

test('editing a city site changes the marker position in the rendered scene', () => {
  const map = createMapState('City sites', 3, 3);
  map.layers.base.data = Array(9).fill('Land');
  const city = {
    id: 'city', col: 1, row: 1, name: 'City', population: 10_000,
    onRiver: false, riverId: null, coastal: false, coastalEdges: [],
  } satisfies City;
  map.layers.cities.data = { cities: [city] };
  const visible = { ...defaultVisibility(), cities: true };
  const style = resolveStyle({ preset: 'classic', overrides: { cityMarkers: 'symbols' } });
  const markerAt = (state: typeof map) => {
    const markers = buildScene(state, { size, visible, labels: false, style }).prims
      .filter((p) => p.kind === 'city');
    assert.equal(markers.length, 1);
    return markers[0]!.c;
  };

  const centre = markerAt(map);
  const edited = reducer(map, { type: 'setCitySite', id: city.id, site: { corner: 1 } });
  const corner = markerAt(edited);
  assert.ok(corner.x > centre.x && corner.y > centre.y);
  assert.deepEqual(edited.layers.cities.data!.cities[0]!.site, { corner: 1 });
});
