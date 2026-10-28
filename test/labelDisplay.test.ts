import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from './seededMap.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import { placePolityLabels } from '../src/render/labels.ts';
import { reducer } from '../src/state/store.ts';
import { geoNameSurfaceAreas, normaliseHexDimensions } from '../shared/surfaceArea.ts';
import { serializeFeatureAreasCsv } from '../src/render/export.ts';
import type { MapState } from '../shared/types.ts';

const COLS = 12;
const ROWS = 8;

/** All land, one realm over all of it, and a land feature across the middle. */
function realmAndFeature(): MapState {
  let map = createMapState('Test.', COLS, ROWS, 'Test');
  map = reducer(map, { type: 'applyGeneration', layer: 'base', data: Array(COLS * ROWS).fill('Land'), warnings: [], notes: null });
  map = { ...map, enabledLayers: [...new Set([...map.enabledLayers, 'polities' as const])] };
  map = reducer(map, {
    type: 'applyGeneration', layer: 'polities', warnings: [], notes: null,
    data: { polities: [{ id: 'p', name: 'Kingdom of Aldmere', colour: '#aa3333' }], owner: Array(COLS * ROWS).fill('p') },
  });
  const middle: number[] = [];
  for (let row = 2; row <= 5; row++) for (let col = 3; col <= 8; col++) middle.push(row * COLS + col);
  return reducer(map, { type: 'nameGeo', id: 'g', kind: 'land', name: 'Greenwold Downs', indices: middle });
}

const near = (a?: { x: number; y: number }, b?: { x: number; y: number }) =>
  !!a && !!b && Math.hypot(a.x - b.x, a.y - b.y) < 0.5;
const scene = (map: MapState) =>
  buildScene(map, { size: 32, visible: { ...defaultVisibility(), polities: true }, labels: true, landNames: true });
const textAt = (map: MapState) =>
  new Map(scene(map).prims.flatMap((p) => (p.kind === 'text' ? [[p.text, p.at] as const] : [])));

test('a geographical name can be shown, hidden or prioritised, one name at a time', () => {
  let map = realmAndFeature();
  map = reducer(map, { type: 'setGeoNameDisplay', id: 'g', display: 'hidden' });
  assert.equal(map.geoNames?.[0]?.hidden, true);
  assert.deepEqual([...textAt(map).keys()], ['KINGDOM OF ALDMERE']);

  map = reducer(map, { type: 'setGeoNameDisplay', id: 'g', display: 'priority' });
  assert.equal(map.geoNames?.[0]?.hidden, undefined);
  assert.equal(map.geoNames?.[0]?.priority, true);

  map = reducer(map, { type: 'setGeoNameDisplay', id: 'g', display: 'normal' });
  assert.equal(map.geoNames?.[0]?.priority, undefined);
  // Extending a name keeps how it is displayed.
  map = reducer(map, { type: 'setGeoNameDisplay', id: 'g', display: 'priority' });
  map = reducer(map, { type: 'nameGeo', id: 'g', kind: 'land', name: 'Greenwold Downs', indices: [0] });
  assert.equal(map.geoNames?.[0]?.priority, true);
});

test('a realm name moves off a prioritised geographical name', () => {
  const plain = textAt(realmAndFeature());
  // Unprioritised, both names take the middle of the map.
  assert.ok(near(plain.get('KINGDOM OF ALDMERE'), plain.get('GREENWOLD DOWNS')));
  const map = reducer(realmAndFeature(), { type: 'setGeoNameDisplay', id: 'g', display: 'priority' });
  const placed = textAt(map);
  assert.ok(near(placed.get('GREENWOLD DOWNS'), plain.get('GREENWOLD DOWNS')));
  assert.ok(placed.has('KINGDOM OF ALDMERE'));
  assert.ok(!near(placed.get('KINGDOM OF ALDMERE'), plain.get('KINGDOM OF ALDMERE')));
});

test('a geographical name without priority gives way to a prioritised realm name, and says so', () => {
  const map = reducer(realmAndFeature(), { type: 'setPolityLabelDisplay', id: 'p', display: 'priority' });
  assert.equal(map.layers.polities.data?.polities[0]?.labelPriority, true);
  const built = scene(map);
  const texts = built.prims.flatMap((p) => (p.kind === 'text' ? [p.text] : []));
  assert.deepEqual(texts, ['KINGDOM OF ALDMERE']);
  assert.ok(built.compromises?.some((c) => c.what.includes('Greenwold Downs')));
});

test('a realm name can be hidden without touching its territory, and it marks nothing stale', () => {
  const before = realmAndFeature();
  const map = reducer(before, { type: 'setPolityLabelDisplay', id: 'p', display: 'hidden' });
  assert.equal(map.layers.polities.data?.polities[0]?.labelHidden, true);
  assert.deepEqual(map.layers.polities.data?.owner, before.layers.polities.data?.owner);
  assert.equal(map.layers.polities.version, before.layers.polities.version);
  assert.deepEqual([...textAt(map).keys()], ['GREENWOLD DOWNS']);
  const shown = reducer(map, { type: 'setPolityLabelDisplay', id: 'p', display: 'normal' });
  assert.equal(shown.layers.polities.data?.polities[0]?.labelHidden, undefined);
});

test('a prioritised realm is named first and whatever the minimum size for names', () => {
  const cols = 10, rows = 4;
  const owner: (string | null)[] = Array(cols * rows).fill('big');
  owner[0] = 'small';
  owner[1] = 'small';
  const polities = [{ id: 'big', name: 'Big' }, { id: 'small', name: 'Small' }];
  const input = { cols, rows, size: 20, owner, obstacles: [], minHexes: 5, measure: (t: string) => t.length * 0.7 };
  assert.deepEqual(placePolityLabels({ ...input, polities }).map((l) => l.polityId), ['big']);
  const prioritised = polities.map((p) => (p.id === 'small' ? { ...p, labelPriority: true } : p));
  assert.deepEqual(placePolityLabels({ ...input, polities: prioritised }).map((l) => l.polityId), ['small', 'big']);
});

test('named features are measured by their water or land, and exported as CSV', () => {
  let map = realmAndFeature();
  const dims = normaliseHexDimensions(map.hexDimensions);
  const hexArea = dims.width * dims.height * 0.75;
  const [land] = geoNameSurfaceAreas(map);
  assert.equal(land?.hexCount, 24);
  // Inland Land is whole.
  assert.ok(Math.abs(land!.area - 24 * hexArea) < 1e-6);

  // A lake measures its water; the lake hexes leave the land feature.
  const lake = [3 * COLS + 5, 3 * COLS + 6];
  const base = map.layers.base.data!.map((v, i) => (lake.includes(i) ? 'Lake' as const : v));
  map = reducer(map, { type: 'applyGeneration', layer: 'base', data: base, warnings: [], notes: null });
  map = reducer(map, { type: 'nameGeo', id: 'l', kind: 'lake', name: 'Mere, "the Still"', indices: lake });
  map = reducer(map, { type: 'setGeoNameDisplay', id: 'l', display: 'hidden' });
  const areas = new Map(geoNameSurfaceAreas(map).map((a) => [a.id, a]));
  assert.equal(areas.get('g')?.hexCount, 22);
  assert.equal(areas.get('l')?.hexCount, 2);
  assert.ok(areas.get('l')!.area > 0 && areas.get('l')!.area <= 2 * hexArea);

  const csv = serializeFeatureAreasCsv(map).trimEnd().split('\r\n');
  assert.equal(csv[0], `Name,Kind,Measures,Hexes,Area (${dims.unit}²),Label`);
  assert.equal(csv.length, 3);
  assert.ok(csv.some((row) => row.startsWith('"Mere, ""the Still""",Lake,water,2,') && row.endsWith(',Hidden')));
});
