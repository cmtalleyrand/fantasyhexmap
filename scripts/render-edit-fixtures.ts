import { createMapState } from '../shared/layers.ts';
import { LAYER_ORDER, type MapState } from '../shared/types.ts';
import { resolveStyle } from '../src/render/styles.ts';
import type { SceneOptions } from '../src/render/scene.ts';
import { coastGallery } from './coast-gallery-fixtures.ts';

export interface EditCase { name: string; map: MapState; options: SceneOptions }
export const editOptions = (): SceneOptions => ({ size: 26, visible: Object.fromEntries(LAYER_ORDER.map(id => [id, true])) as SceneOptions['visible'],
  labels: true, riverNames: true, rangeNames: true, seaNames: true, landNames: true, polityNames: 0,
  style: resolveStyle({ preset: 'parchment', overrides: { coast: 'smooth' } }) });
export function componentFixture(): MapState {
  const map = createMapState('Independent coasts', 40, 18); map.id = 'incremental-components';
  map.layers.base.data = Array(720).fill('Sea');
  // Empty populated layers let the production app enable all eight layers.
  map.layers.elevation.data = Array(720).fill(null);
  map.layers.climate.data = Array(720).fill(null);
  map.layers.vegetation.data = Array(720).fill(null);
  map.layers.population.data = Array(720).fill(null);
  map.layers.rivers.data = { rivers: [] };
  map.layers.cities.data = { cities: [] };
  map.layers.polities.data = { polities: [], owner: Array(720).fill(null) };
  for (const start of [3, 29]) for (let row = 5; row <= 7; row++) for (let col = start; col < start + 3; col++) map.layers.base.data![row * 40 + col] = 'Coastal Land';
  map.defaultIrregularity = 'Ragged';
  return map;
}
export function placementFixture(): MapState {
  const map = createMapState('Placement dependencies', 12, 10); map.id = 'incremental-placement';
  const base = map.layers.base.data = Array.from({ length: 120 }, (_, i) => i < 24 ? 'Sea' as const : 'Land' as const);
  map.defaultIrregularity = 'Smooth';
  map.layers.elevation.data = base.map((b, i) => b === 'Land' ? i % 3 ? 'Mountains' : 'Hills' : null);
  map.layers.vegetation.data = base.map(b => b === 'Land' ? 'Deciduous Forest' : null);
  map.layers.polities.data = { polities: [{ id: 'realm', name: 'Eastmarch', colour: '#ae7733' }], owner: base.map(b => b === 'Land' ? 'realm' : null) };
  map.layers.cities.data = { cities: [{ id: 'seat', name: 'Highport', col: 5, row: 5, population: 100000, capital: true,
    onRiver: false, riverId: null, coastal: false, coastalEdges: [], site: 'inland' }] };
  map.layers.rivers.data = { rivers: [{ id: 'river', name: 'The Beryl', terminus: 'Unresolved', segments:
    Array.from({ length: 7 }, (_, col) => ({ col: col + 2, row: 7, entryEdge: col ? 2 : null, exitEdge: 5, navigable: false })) }] };
  map.mountainRanges = [{ id: 'range', name: 'High Teeth', hexes: [38, 39, 40, 41, 42, 43] }];
  map.geoNames = [{ id: 'water', kind: 'sea', name: 'Northern Sea', hexes: Array.from({ length: 24 }, (_, i) => i) },
    { id: 'land', kind: 'land', name: 'Green Reach', hexes: Array.from({ length: 96 }, (_, i) => i + 24) }];
  return map;
}

/** Replay all prior states without mutating them; suitable for workers and browser bundles. */
export function editCases(): EditCase[] {
  const out: EditCase[] = [];
  const append = (name: string, map: MapState, options = editOptions()) => out.push({ name, map: structuredClone(map), options: structuredClone(options) });
  let map = componentFixture(); append('components/cold', map);
  map.layers.base.data![5 * 40 + 3] = 'Sea'; append('components/shore', map);
  map.layers.base.data![6 * 40 + 8] = 'Land'; append('components/approaching', map);
  for (let col = 6; col < 29; col++) map.layers.base.data![6 * 40 + col] = 'Land'; append('components/merge', map);
  map.layers.base.data![6 * 40 + 18] = 'Sea'; append('components/split', map);
  map = componentFixture(); append('components/undo', map);
  map.layers.base.data!.fill('Sea', 29 + 5 * 40, 32 + 5 * 40); append('components/delete-row', map);
  map.hexDimensions.coastalLandPercent = 70; append('components/default-share', map);
  map.id += '-different'; append('components/seed', map);

  for (const name of ['Ragged', 'Fractured'].flatMap(level =>
    ['strait-share', 'isthmus', 'coast-conc', 'mainland-shares'].map(kind => `${kind}-${level}`))) {
    map = coastGallery().find(f => f.name === name)!.map;
    append(`${name}/cold`, map);
    const hex = Object.keys(map.hexShapes ?? {})[0] ?? String(map.layers.base.data!.findIndex(v => v === 'Isthmus'));
    if (map.layers.base.data![Number(hex)] === 'Isthmus' && !map.hexShapes?.[hex]) map.hexShapes = { ...map.hexShapes, [hex]: { type: 'Isthmus' } };
    map.hexShapes = { ...map.hexShapes, [hex]: { ...map.hexShapes![hex]!, land: 60 } }; append(`${name}/share`, map);
    map.hexShapes![hex] = { ...map.hexShapes![hex]!, concentration: 80, concentrationSide: 2 }; append(`${name}/concentration`, map);
    if (map.layers.base.data![Number(hex)] === 'Strait' || map.layers.base.data![Number(hex)] === 'Isthmus') {
      map.hexShapes![hex] = { ...map.hexShapes![hex]!, width: 'Narrow' }; append(`${name}/width`, map);
    }
    if (name.startsWith('mainland')) { map.islandSpecs![hex] = { large: 1, small: 2 }; append(`${name}/islands`, map); }
  }
  map = placementFixture(); let options = editOptions(); append('placement/cold', map, options);
  options = { ...options, polityOpacity: .4 }; append('placement/opacity', map, options);
  map.layers.polities.data!.polities[0]!.colour = '#4477bb'; append('placement/colour', map, options);
  options = { ...options, style: { ...options.style!, knobs: { ...options.style!.knobs, cityMarkers: 'classic' } } }; append('placement/marker', map, options);
  map.layers.cities.data!.cities[0]!.name = 'A much longer city name'; append('placement/city-name', map, options);
  map.layers.polities.data!.polities[0]!.name = 'A very different realm'; append('placement/realm-name', map, options);
  map.layers.rivers.data!.rivers[0]!.segments[2]!.reach = { min: .5, max: .8 }; append('placement/river-course', map, options);
  map.geoNames![0]!.name = 'The Northern Passage'; append('placement/water-name', map, options);
  map.layers.base.data![5 * 12 + 7] = 'Lake'; append('placement/lake', map, options);
  map.defaultLakeIrregularity = 'Fractured'; append('placement/lake-irregularity', map, options);
  map.layers.base.data![4 * 12 + 3] = 'Islands'; map.islandSpecs = { [4 * 12 + 3]: { large: 1, small: 0 } }; append('placement/islands', map, options);
  map.islandSpecs[4 * 12 + 3] = { large: 1, small: 2 }; append('placement/island-count', map, options);
  map.layers.polities.data!.polities.push({ id: 'child', name: 'Southmark', colour: '#5577aa', parentId: 'realm' });
  for (let i = 72; i < 120; i++) map.layers.polities.data!.owner[i] = 'child'; append('placement/hierarchy', map, options);
  map.layers.polities.data!.polities[1]!.name = 'Southern Marches'; append('placement/hierarchy-name', map, options);
  options = { ...options, style: { ...options.style!, knobs: { ...options.style!.knobs, lettering: 'oldprint' } } }; append('placement/font', map, options);
  options = { ...options, visible: { ...options.visible, cities: false } }; append('placement/hide-obstacles', map, options);
  options = { ...options, size: 31 }; append('placement/scale', map, options);
  map.cols = 10; map.rows = 12; append('placement/dimensions', map, options);
  map.id += '-replacement'; append('placement/map-replacement', map, options);
  append('placement/switch-back', placementFixture());
  return out;
}
