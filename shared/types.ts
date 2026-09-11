/**
 * Core data model for the fantasy hex map.
 *
 * COORDINATE SYSTEM (documented once, used everywhere)
 * ----------------------------------------------------
 * Hexes are POINTY-TOP and addressed with ODD-R OFFSET coordinates:
 *   - `col` runs 0..cols-1 west -> east
 *   - `row` runs 0..rows-1 north -> south (row 0 is the northern edge of the map)
 *   - odd-numbered rows are shifted half a hex to the EAST
 * The flat index of a hex is `row * cols + col`; every per-hex layer is stored as a
 * flat array of that length.
 *
 * EDGES
 * -----
 * Each hex has six edges indexed 0..5 in this fixed order:
 *   0 = E, 1 = SE, 2 = SW, 3 = W, 4 = NW, 5 = NE
 * Edge `e` of a hex is shared with the neighbour in direction `e`; from that
 * neighbour's point of view the same edge is `(e + 3) % 6`.
 */

export type LayerId =
  | 'base'
  | 'elevation'
  | 'climate'
  | 'vegetation'
  | 'rivers'
  | 'cities'
  | 'polities'
  | 'population';

export const LAYER_ORDER: LayerId[] = [
  'base',
  'elevation',
  'climate',
  'vegetation',
  'rivers',
  'cities',
  'polities',
  'population',
];

export type BaseGeo = 'Land' | 'Sea' | 'Lake' | 'Ice' | 'Island';
export const BASE_GEO_VALUES: BaseGeo[] = ['Land', 'Sea', 'Lake', 'Ice', 'Island'];

/** Hex types that carry land-only layer values (elevation, climate, vegetation, population). */
export const LAND_LIKE: BaseGeo[] = ['Land', 'Island'];

export type Elevation =
  | 'Lowland'
  | 'Rolling'
  | 'Hills'
  | 'Highland'
  | 'Mountains'
  | 'Plateau';
export const ELEVATION_VALUES: Elevation[] = [
  'Lowland',
  'Rolling',
  'Hills',
  'Highland',
  'Mountains',
  'Plateau',
];

export type Climate =
  | 'Af' | 'Am' | 'Aw'
  | 'BWh' | 'BWk' | 'BSh' | 'BSk'
  | 'Csa' | 'Csb' | 'Cfa' | 'Cfb' | 'Cwa'
  | 'Dfa' | 'Dfb' | 'Dfc' | 'Dsa' | 'Dsb' | 'Dwa' | 'Dwb'
  | 'ET' | 'EF';
export const CLIMATE_VALUES: Climate[] = [
  'Af', 'Am', 'Aw',
  'BWh', 'BWk', 'BSh', 'BSk',
  'Csa', 'Csb', 'Cfa', 'Cfb', 'Cwa',
  'Dfa', 'Dfb', 'Dfc', 'Dsa', 'Dsb', 'Dwa', 'Dwb',
  'ET', 'EF',
];

export type VegetationGroup = 'Ungrazed' | 'Grassland' | 'Forest' | 'Cultivated';

export type Vegetation =
  // Ungrazed
  | 'Barren Desert' | 'Scrubland' | 'Wetland' | 'Tundra'
  // Grassland
  | 'Steppe' | 'Prairie' | 'Savanna' | 'Veld'
  // Forest
  | 'Boreal Forest' | 'Coniferous Forest' | 'Deciduous Forest'
  | 'Tropical Rainforest' | 'Subtropical Rainforest'
  // Cultivated
  | 'Flood Plain' | 'Breadbasket' | 'Black Earth' | 'Assart'
  | 'Paddy Fields' | 'Desert Oasis';

export const VEGETATION_GROUPS: Record<VegetationGroup, Vegetation[]> = {
  Ungrazed: ['Barren Desert', 'Scrubland', 'Wetland', 'Tundra'],
  Grassland: ['Steppe', 'Prairie', 'Savanna', 'Veld'],
  Forest: [
    'Boreal Forest',
    'Coniferous Forest',
    'Deciduous Forest',
    'Tropical Rainforest',
    'Subtropical Rainforest',
  ],
  Cultivated: [
    'Flood Plain',
    'Breadbasket',
    'Black Earth',
    'Assart',
    'Paddy Fields',
    'Desert Oasis',
  ],
};

export const VEGETATION_VALUES: Vegetation[] = [
  ...VEGETATION_GROUPS.Ungrazed,
  ...VEGETATION_GROUPS.Grassland,
  ...VEGETATION_GROUPS.Forest,
  ...VEGETATION_GROUPS.Cultivated,
];

export function vegetationGroupOf(v: Vegetation): VegetationGroup {
  for (const g of Object.keys(VEGETATION_GROUPS) as VegetationGroup[]) {
    if (VEGETATION_GROUPS[g].includes(v)) return g;
  }
  return 'Ungrazed';
}

/** One hex-traversal of a river: it enters through `entryEdge` and leaves through `exitEdge`. */
export interface RiverSegment {
  col: number;
  row: number;
  /** null at the river's source (the water rises inside this hex). */
  entryEdge: number | null;
  /** Edge the water leaves through. null only if the river is malformed / truncated. */
  exitEdge: number | null;
  navigable: boolean;
}

export interface River {
  id: string;
  name: string;
  segments: RiverSegment[];
  /** 'Sea' | 'Lake' | 'OffMap' | 'Unresolved' - what the last segment empties into. */
  terminus: 'Sea' | 'Lake' | 'OffMap' | 'Unresolved';
}

export interface City {
  id: string;
  col: number;
  row: number;
  name: string;
  population: number;
  onRiver: boolean;
  /** Which river the city sits on, when the hex carries one (or more). */
  riverId: string | null;
  coastal: boolean;
  /** Which of the hex's six edges border Sea or Lake. */
  coastalEdges: number[];
}

export interface Polity {
  id: string;
  name: string;
  colour: string;
}

/** Per-hex flat arrays are indexed `row * cols + col`. */
export type BaseData = BaseGeo[];
export type ElevationData = (Elevation | null)[];
export type ClimateData = (Climate | null)[];
export type VegetationData = (Vegetation | null)[];
export interface RiversData {
  rivers: River[];
}
export interface CitiesData {
  cities: City[];
}
export interface PolitiesData {
  polities: Polity[];
  /** Polity id owning each hex, or null for unclaimed / non-land. */
  owner: (string | null)[];
}
export type PopulationData = (number | null)[];

export interface LayerDataMap {
  base: BaseData;
  elevation: ElevationData;
  climate: ClimateData;
  vegetation: VegetationData;
  rivers: RiversData;
  cities: CitiesData;
  polities: PolitiesData;
  population: PopulationData;
}

export interface LayerSnapshot<K extends LayerId = LayerId> {
  data: LayerDataMap[K] | null;
  warnings: string[];
  notes: string | null;
  generatedAt: number | null;
  /** Versions of the layers this one was generated against; absent key = layer did not exist. */
  depVersions: Partial<Record<LayerId, number>>;
}

export interface LayerState<K extends LayerId = LayerId> extends LayerSnapshot<K> {
  /** Bumped on every committed change; used for staleness comparison. */
  version: number;
  past: LayerSnapshot<K>[];
  future: LayerSnapshot<K>[];
}

export type LayersState = { [K in LayerId]: LayerState<K> };

/**
 * One choice the model made while generating a layer, in its own words.
 *
 * The map itself only records *what* is where. This records *why*, which is the
 * part a reader of the map cannot reconstruct and the part that makes a
 * generated world defensible rather than arbitrary.
 */
export interface Decision {
  /** Short headline, e.g. "Rain shadow east of the Kelder Spine". */
  title: string;
  /** One to three sentences of reasoning. */
  detail: string;
  /** Hexes the decision is about, as "col,row" - optional and often absent. */
  hexes?: string[];
}

export type JournalKind = 'generate' | 'instruct' | 'manual' | 'import' | 'undo' | 'redo';

/**
 * A chronological account of how the map came to look the way it does. AI
 * entries carry the model's reasoning; the others are recorded so the record
 * never implies the AI decided something a person actually did.
 */
export interface JournalEntry {
  id: string;
  layer: LayerId;
  kind: JournalKind;
  at: number;
  /** The user's instruction, for `instruct` entries. */
  instruction: string | null;
  /** One-line summary; for manual entries, what was changed. */
  summary: string;
  decisions: Decision[];
  /**
   * Model that produced this, or null for a manual edit or the offline
   * generator. For an `import` entry this is whatever the user said produced it
   * elsewhere, which is why the kind and not the model is what marks the
   * distinction - the record must never imply this app's model made a choice
   * that was actually made somewhere else.
   */
  model: string | null;
  warnings: number;
}

export interface MapState {
  id: string;
  name: string;
  description: string;
  cols: number;
  rows: number;
  createdAt: number;
  updatedAt: number;
  /**
   * The layers this map is meant to have. Chosen when the map is created and
   * changeable afterwards: a large grid is eight long generations if you want
   * all of it, and most maps do not. Layers left out are not generated, not
   * shown and not exported; a layer removed after it has data keeps that data,
   * so removing one is never destructive.
   */
  enabledLayers: LayerId[];
  layers: LayersState;
  /** Append-only record of every change, oldest first. */
  journal: JournalEntry[];
}

export const MAX_DIM = 50;
export const MIN_DIM = 3;
export const MAX_HISTORY = 40;
