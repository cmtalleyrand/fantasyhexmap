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

export type BaseGeo =
  | 'Land'
  | 'Coastal Land'
  | 'Sea'
  | 'Lake'
  | 'Glacier'
  | 'Sea Ice'
  | 'Islands'
  | 'Mainland and islands'
  | 'Isthmus'
  | 'Strait';
export const BASE_GEO_VALUES: BaseGeo[] = [
  'Land', 'Coastal Land', 'Sea', 'Lake', 'Glacier', 'Sea Ice', 'Islands', 'Mainland and islands', 'Isthmus', 'Strait',
];

/**
 * Island types of maps saved before islands were described by counts. They are
 * read and migrated (see `migrateLegacyIslands`), never written.
 */
export type LegacyIslandGeo = 'Island' | 'Coastal Island' | 'Large Island' | 'Small Islands';
export const LEGACY_ISLAND_VALUES: LegacyIslandGeo[] = ['Island', 'Coastal Island', 'Large Island', 'Small Islands'];

/**
 * Maps saved when ice was a type of its own hold 'Ice'. It is read and migrated
 * (see `migrateLegacyIslands`), never written: those hexes carry no land values,
 * so they become Sea Ice.
 */
export const LEGACY_ICE_VALUE = 'Ice';

/**
 * Hexes that hold islands: open sea with islands in it, or part of a mainland
 * coast with islands off it. How many islands, and where, is in `islandSpecs`.
 */
export const ISLAND_TYPES: BaseGeo[] = ['Islands', 'Mainland and islands'];

export function isIslandType(value: BaseGeo | null | undefined): boolean {
  return value === 'Islands' || value === 'Mainland and islands';
}

/**
 * Hexes drawn partly land and partly water: a coast with islands off it, a
 * neck of land between two waters, and a channel of water between two lands.
 */
export function isSplitType(value: BaseGeo | null | undefined): boolean {
  return value === 'Mainland and islands' || value === 'Isthmus' || value === 'Strait';
}

/** What each base type means, for the sidebar and the legend. */
export const BASE_DESCRIPTIONS: Record<BaseGeo, string> = {
  Land: 'Dry land.',
  'Coastal Land': 'Land with a shoreline crossing it.',
  Sea: 'Open salt water.',
  Lake: 'Fresh water enclosed by land.',
  Glacier: 'Land under permanent ice: it has elevation and the rest of the land layers, and shows the ice over the relief.',
  'Sea Ice': 'Frozen sea: pack ice floating on salt water.',
  Islands: 'Sea holding up to two large islands and six small ones.',
  'Mainland and islands': 'Part mainland coast, part sea with islands off the shore.',
  Isthmus: 'A narrow neck of land joining two land masses, with water either side.',
  Strait: 'A narrow channel of water joining two seas or lakes, with land either side.',
};

/** Hex types that carry land-only layer values (elevation, climate, vegetation, population). */
export const LAND_LIKE: BaseGeo[] = ['Land', 'Coastal Land', 'Glacier', 'Islands', 'Mainland and islands', 'Isthmus'];

/**
 * The patterns islands lie in, as they do in nature. Scattered is a shelf
 * archipelago, with islets sharing a grain. A chain is a hotspot trail (Hawaii)
 * with the largest at one end. An arc is a volcanic island arc (the Aleutians,
 * the Lesser Antilles), bowed away from the land behind it. A barrier is a row
 * of long narrow islands standing off a coast (the Outer Banks, the Frisians).
 * A ring is an atoll or a drowned caldera round a lagoon.
 */
export type IslandArrangement = 'scattered' | 'chain' | 'arc' | 'barrier' | 'ring';
export const ISLAND_ARRANGEMENTS: Array<{ value: IslandArrangement; label: string; hint: string }> = [
  { value: 'scattered', label: 'Scattered archipelago', hint: 'Islets of one grain, as on a drowned shelf' },
  { value: 'chain', label: 'Chain (hotspot trail)', hint: 'A line of islands, the largest at one end' },
  { value: 'arc', label: 'Arc (volcanic island arc)', hint: 'A curve bowed away from the nearest land' },
  { value: 'barrier', label: 'Barrier islands', hint: 'Long narrow islands in a row off the coast' },
  { value: 'ring', label: 'Ring (atoll)', hint: 'Islands round a lagoon' },
];

/** Which way a chain, arc or barrier runs: with the nearest coast (as island arcs and barrier islands do), across it (a peninsula's drowned tail), or by chance. */
export type IslandOrientation = 'free' | 'along' | 'across';
export const ISLAND_ORIENTATIONS: Array<{ value: IslandOrientation; label: string }> = [
  { value: 'free', label: 'Any direction' },
  { value: 'along', label: 'Parallel to the coast (or the chosen side)' },
  { value: 'across', label: 'Pointing away from the coast (or the chosen side)' },
];

/**
 * How the islands of an Islands or Mainland-and-islands hex are drawn: up to
 * two large islands and six small ones (at least one island in all). A
 * coastal group lies against the hex's side facing land (`side`, or the
 * nearest land when absent) - for a mainland hex, against the mainland.
 */
export interface IslandSpec {
  large: number;
  small: number;
  /** The pattern the islands lie in (see `ISLAND_ARRANGEMENTS`); absent means scattered. */
  arrangement?: IslandArrangement;
  /** How a chain, arc or barrier runs relative to the nearest coast; absent means free. */
  orientation?: IslandOrientation;
  /** User-selected salt which changes the islands' positions and outlines. */
  layoutSeed?: number;
  coastal?: { large?: boolean; small?: boolean };
  /** Edge 0-5 the coastal groups lie against; absent means the side facing land. */
  side?: number;
}

export const DEFAULT_ISLAND_SPECS: Record<'Islands' | 'Mainland and islands', IslandSpec> = {
  Islands: { large: 1, small: 0 },
  'Mainland and islands': { large: 0, small: 2 },
};

/** A stored spec, clamped to the allowed counts; the type's default when absent or empty. */
export function islandSpecFor(value: BaseGeo | null | undefined, stored: IslandSpec | undefined): IslandSpec {
  const fallback = value === 'Mainland and islands' ? DEFAULT_ISLAND_SPECS['Mainland and islands'] : DEFAULT_ISLAND_SPECS.Islands;
  if (!stored) return fallback;
  const large = Math.max(0, Math.min(2, Math.round(Number(stored.large) || 0)));
  const small = Math.max(0, Math.min(6, Math.round(Number(stored.small) || 0)));
  if (large + small === 0) return fallback;
  const side = typeof stored.side === 'number' && stored.side >= 0 && stored.side < 6 ? Math.floor(stored.side) : undefined;
  const arrangement = ISLAND_ARRANGEMENTS.find((a) => a.value === stored.arrangement)?.value;
  const orientation = ISLAND_ORIENTATIONS.find((o) => o.value === stored.orientation)?.value;
  return {
    large,
    small,
    ...(arrangement && arrangement !== 'scattered' ? { arrangement } : {}),
    ...(orientation && orientation !== 'free' ? { orientation } : {}),
    coastal: { large: Boolean(stored.coastal?.large), small: Boolean(stored.coastal?.small) },
    ...(Number.isFinite(stored.layoutSeed) ? { layoutSeed: Math.floor(stored.layoutSeed!) } : {}),
    ...(side !== undefined ? { side } : {}),
  };
}

/**
 * How irregular a hex's shoreline or ice edge is drawn. For a coast, an island or an ice edge
 * it is how far the outline wanders from the plain smoothed line, and how much
 * broken-off detail (islets, floes, icebergs) lies along it.
 */
export type Irregularity = 'Smooth' | 'Wavy' | 'Ragged' | 'Fractured';
export const IRREGULARITY_VALUES: Irregularity[] = ['Smooth', 'Wavy', 'Ragged', 'Fractured'];

/** Base types whose land share and irregularity can be set: anything with a shoreline or an ice edge. */
export const SHAPED_TYPES: BaseGeo[] = [
  'Coastal Land', 'Islands', 'Mainland and islands', 'Isthmus', 'Strait', 'Glacier', 'Sea Ice',
];

export function isShapedType(value: BaseGeo | null | undefined): boolean {
  return value !== null && value !== undefined && SHAPED_TYPES.includes(value);
}

/**
 * Types with a land share: every shaped type but Sea Ice, which is all water, and Lake, which
 * is the other way round from a coast: water with some land (shore, mudflats) drawn in from
 * the edges it shares with land. A lake has no irregularity of its own (its shore takes the
 * land beside it, see `lakeShoreIrregularity`), so it is not a shaped type.
 */
export function hasLandShare(value: BaseGeo | null | undefined): boolean {
  return value === 'Lake' || (isShapedType(value) && value !== 'Sea Ice');
}

/**
 * How narrow a neck of land (an Isthmus) or a channel of water (a Strait) is at its
 * thinnest, as a share of the hex's flat-to-flat width. The thinnest isthmus is 5% of
 * the hex's width.
 */
export type ChannelWidth = 'Very narrow' | 'Narrow' | 'Normal' | 'Wide';
export const CHANNEL_WIDTH_VALUES: ChannelWidth[] = ['Very narrow', 'Narrow', 'Normal', 'Wide'];
export const CHANNEL_WIDTH_PERCENT: Record<ChannelWidth, number> = { 'Very narrow': 5, Narrow: 15, Normal: 30, Wide: 50 };

/** Types drawn at a width (see `ChannelWidth`) rather than to a land share. */
export function hasChannelWidth(value: BaseGeo | null | undefined): boolean {
  return value === 'Isthmus' || value === 'Strait';
}

export const DEFAULT_CHANNEL_WIDTH: Record<'Isthmus' | 'Strait', ChannelWidth> = { Isthmus: 'Normal', Strait: 'Normal' };

/**
 * The irregularity a type is drawn with when none is set: Ragged for every shaped
 * type (coasts, islands, isthmuses, straits, ice). Land, Sea and Lake are not shaped,
 * so theirs is not used.
 */
export const DEFAULT_IRREGULARITY: Record<BaseGeo, Irregularity> = {
  Land: 'Smooth',
  'Coastal Land': 'Ragged',
  Sea: 'Smooth',
  Lake: 'Smooth',
  Glacier: 'Ragged',
  'Sea Ice': 'Ragged',
  Islands: 'Ragged',
  'Mainland and islands': 'Ragged',
  Isthmus: 'Ragged',
  Strait: 'Ragged',
};

/**
 * What a person has set on one shaped hex. `land` is the percentage of the hex
 * that is land, replacing the share its type would give it; `irregular` is how
 * ragged its outline is. A coast or mainland may also concentrate its land towards
 * one side. `type` is the base type the settings were made for: they are ignored
 * once the hex becomes something else.
 */
export interface HexShape {
  type: BaseGeo;
  land?: number;
  /** An Isthmus or Strait: how narrow it is at its thinnest, replacing the map's default. */
  width?: ChannelWidth;
  irregular?: Irregularity;
  /** Edge 0-5 towards which a coast or mainland is biased. */
  concentrationSide?: number;
  /** Strength of that bias, from 0 (uniform) to 100 (strongly concentrated). */
  concentration?: number;
}

/**
 * The settings that apply to a hex of this type: nothing when it has changed type or is not shaped.
 * A hex with no irregularity of its own takes `mapDefault` (`MapState.defaultIrregularity`) when
 * the map has one, else its type's default.
 */
export function hexShapeFor(
  value: BaseGeo | null | undefined,
  stored: HexShape | undefined,
  mapDefault?: Irregularity | null,
): { land?: number; width?: ChannelWidth; irregular: Irregularity; concentrationSide?: number; concentration?: number } {
  const fallback = mapDefault && IRREGULARITY_VALUES.includes(mapDefault) && isShapedType(value) ? mapDefault : undefined;
  const irregular = fallback ?? (value ? DEFAULT_IRREGULARITY[value] : 'Smooth');
  if (!value || !stored || stored.type !== value || !(isShapedType(value) || value === 'Lake')) return { irregular };
  const land = hasLandShare(value) && typeof stored.land === 'number' && Number.isFinite(stored.land)
    ? Math.max(0, Math.min(100, stored.land))
    : undefined;
  const width = hasChannelWidth(value) && CHANNEL_WIDTH_VALUES.includes(stored.width as ChannelWidth) ? (stored.width as ChannelWidth) : undefined;
  return {
    ...(land !== undefined ? { land } : {}),
    ...(width !== undefined ? { width } : {}),
    irregular: IRREGULARITY_VALUES.includes(stored.irregular as Irregularity) ? (stored.irregular as Irregularity) : irregular,
    ...((value === 'Coastal Land' || value === 'Mainland and islands') && Number.isInteger(stored.concentrationSide) && stored.concentrationSide! >= 0 && stored.concentrationSide! < 6
      ? { concentrationSide: stored.concentrationSide }
      : {}),
    ...((value === 'Coastal Land' || value === 'Mainland and islands') && typeof stored.concentration === 'number' && Number.isFinite(stored.concentration)
      ? { concentration: Math.max(0, Math.min(100, stored.concentration)) }
      : {}),
  };
}

/** The irregularity a lake's shore is drawn with when neither the land beside it nor the map sets one. */
export const DEFAULT_LAKE_IRREGULARITY: Irregularity = 'Ragged';

/**
 * The irregularity of the shore of a lake beside a hex of this type: the hex's own setting when it
 * has one for its current type, else the map's lake default (`MapState.defaultLakeIrregularity`),
 * else `DEFAULT_LAKE_IRREGULARITY`. Unlike a sea coast, any land hex beside a lake may carry it.
 */
export function lakeShoreIrregularity(
  value: BaseGeo | null | undefined,
  stored: HexShape | undefined,
  mapDefault?: Irregularity | null,
  /** What is set on the lake hex itself, which wins over the land beside it. */
  lake?: HexShape,
): Irregularity {
  if (lake && lake.type === 'Lake' && IRREGULARITY_VALUES.includes(lake.irregular as Irregularity)) return lake.irregular as Irregularity;
  if (value && stored && stored.type === value && isShapedType(value) && IRREGULARITY_VALUES.includes(stored.irregular as Irregularity)) {
    return stored.irregular as Irregularity;
  }
  return mapDefault && IRREGULARITY_VALUES.includes(mapDefault) ? mapDefault : DEFAULT_LAKE_IRREGULARITY;
}

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
  /** Optional bounds on the course's closest approach to this hex's centre, measured from 0 (centre) to 1 (edge). */
  reach?: { min: number | null; max: number | null };
}

export interface River {
  id: string;
  name: string;
  segments: RiverSegment[];
  /**
   * What the last segment empties into: the sea, a lake, another river (a
   * tributary: see `joins`), over the map edge, or nothing found.
   */
  terminus: 'Sea' | 'Lake' | 'River' | 'OffMap' | 'Unresolved';
  /**
   * Set on a tributary: the id of the river it flows into. Its last segment
   * sits in the confluence hex, which is one of that river's hexes, and has no
   * exit edge.
   */
  joins?: string;
  /**
   * The river flows out of a lake: its first segment's entry edge is the edge
   * it shares with the lake. The lake hex itself is not a segment.
   */
  fromLake?: boolean;
  /**
   * Set on a distributary: the id of the river it splits from. Its first segment
   * sits in the fork hex, which must also be one of the parent's hexes. A river
   * can have any number of branches, so a delta can split into two or more.
   */
  branchOf?: string;
}

/**
 * A named group of Mountains hexes. Elevation is a flat per-hex array with no
 * room for identity, so ranges are kept beside the layers rather than in one.
 * Hexes that stop being Mountains are ignored when drawing, not deleted.
 */
export interface MountainRange {
  id: string;
  name: string;
  /** Flat hex indices (`row * cols + col`). */
  hexes: number[];
}

/** What a geographical name names; see `shared/geoNames.ts` for which hexes each may hold. */
export type GeoNameKind = 'sea' | 'lake' | 'land' | 'island';

/** A named sea, lake, land feature or island: a set of hexes that carry one name on the map. */
export interface GeoName {
  id: string;
  name: string;
  kind: GeoNameKind;
  /** Do not draw this particular name, independently of the global name display settings. */
  hidden?: boolean;
  /** Flat hex indices (`row * cols + col`). */
  hexes: number[];
}

/** Superseded by `GeoName`; read from older saves and migrated. */
export interface WaterName {
  id: string;
  name: string;
  /** Flat hex indices (`row * cols + col`) of Sea, Lake or island hexes. */
  hexes: number[];
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
  /** The seat of its realm: drawn with a crown over its marker and its name in capitals. */
  capital?: boolean;
  /**
   * Where in its hex the city is drawn: on its river, against one of its
   * coastal edges, at the centre, or (absent or 'auto') river first, then
   * coast, then centre. Presentation only; nothing else depends on it.
   */
  site?: CitySite;
}

/**
 * `{ bank }` stands on the tip of land on that edge of a strait hex, in the
 * realm whose land lies there. `{ coast }` stands on that coastal edge; `{ coast, river: true }` stands
 * where its river meets that coast - a river port.
 *
 * `'neck'` stands on the strip of land between two lakes (a hex with lake on two sides that are not
 * neighbours), midway between their shores; `'auto'` chooses it for such a hex when there is no river.
 * `'landward'` stands back from the shore, on the side away from the water. `{ corner }` stands toward that
 * corner of the hex (corner c lies between edges c-1 and c), and `{ offset }` at a free point of the hex, as
 * a fraction of the hex size from its centre (kept inside the hex and, like every site, moved onto land).
 */
export type CitySite =
  | 'auto'
  | 'inland'
  | 'river'
  | 'neck'
  | 'landward'
  | { coast: number; river?: boolean }
  | { bank: number }
  | { corner: number }
  | { offset: { x: number; y: number } };

export interface Polity {
  id: string;
  name: string;
  /** A compact cartographic label; the full official name remains in `name`. */
  shortName?: string;
  colour: string;
  /**
   * The larger polity this one is part of (a duchy's kingdom). A parent may
   * own no hexes itself: its territory is the union of its descendants'.
   */
  parentId?: string;
  /**
   * The colour is derived from the parent's (a shade of it) and follows it when
   * the parent's colour changes. Cleared when the colour is chosen by hand.
   */
  autoShade?: boolean;
  /**
   * A city-state: while it is small, the map names it by its capital alone
   * (the capital, else the largest city in its land) instead of a realm name.
   */
  cityState?: boolean;
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
  /** Polity id owning each hex, or null for unclaimed / non-land. A shared hex lists its larger holder here. */
  owner: (string | null)[];
  /**
   * Hexes held by two polities, keyed by hex index. `polityId` is the second
   * holder and `share` (0-1, exclusive) the fraction of the hex it holds; the
   * `owner` entry holds the rest. Absent or empty when no hex is shared.
   */
  shares?: Record<string, HexShare>;
}
export interface HexShare {
  polityId: string;
  share: number;
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

/** Token counts reported for one generation; `thinking` is the part of `output` spent reasoning. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  thinking: number;
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
  /** Tokens the generation used, when the API reported them. Absent on older entries. */
  usage?: TokenUsage | null;
  /** How long the generation took, in milliseconds. */
  elapsedMs?: number;
}

export interface MapState {
  id: string;
  name: string;
  description: string;
  cols: number;
  rows: number;
  /** Physical scale used to derive land surface area from the pointy-top hex grid. */
  hexDimensions: HexDimensions;
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
  /**
   * Let cities stand on, and polities own, Sea and Lake hexes. Off by default:
   * the map is then a land partition and anything on water is dropped when the
   * geography changes. Absent on maps saved before the option existed.
   */
  allowUnderwater?: boolean;
  /** Named mountain ranges, drawn as labels when the option is on. Absent on older maps. */
  mountainRanges?: MountainRange[];
  /** Named seas, lakes, land features and islands. */
  geoNames?: GeoName[];
  /** Superseded by `geoNames`; read from older saves and migrated. */
  waterNames?: WaterName[];
  /**
   * How the islands of Islands and Mainland-and-islands hexes are drawn, keyed
   * by flat hex index. Absent hexes take their type's default.
   */
  islandSpecs?: Record<string, IslandSpec>;
  /** Superseded by `islandSpecs`; read from older saves and migrated. */
  islandSides?: Record<string, number>;
  /**
   * Land share and irregularity set by hand on shaped hexes (see `SHAPED_TYPES`),
   * keyed by flat hex index. Absent hexes take their type's defaults.
   */
  hexShapes?: Record<string, HexShape>;
  /**
   * The irregularity of every shaped hex that has none of its own (`hexShapes`).
   * Absent: each type uses its own default (`DEFAULT_IRREGULARITY`).
   */
  defaultIrregularity?: Irregularity;
  /**
   * The irregularity of every lake shore whose land hex has none of its own.
   * Absent: `DEFAULT_LAKE_IRREGULARITY`. Separate from `defaultIrregularity`, which is for sea coasts.
   */
  defaultLakeIrregularity?: Irregularity;
  layers: LayersState;
  /** Append-only record of every change, oldest first. */
  journal: JournalEntry[];
}

export interface HexDimensions {
  /** Flat-to-flat horizontal span of one hex. */
  width: number;
  /** Corner-to-corner vertical span of one hex. */
  height: number;
  unit: string;
  /** Share of a hex that is land, by type, unless a hex sets its own (`MapState.hexShapes`). */
  coastalLandPercent: number;
  /** Land in a lake hex, drawn in from the edges it shares with land: the reverse of coastal land. */
  lakeLandPercent: number;
  /** Share of an island hex taken by each large island, and by each small one. */
  largeIslandPercent: number;
  smallIslandPercent: number;
  /** The mainland part of a Mainland and islands hex, before its islands are added. */
  mainlandPercent: number;
  /** How narrow an Isthmus or a Strait is at its thinnest, unless a hex sets its own (`MapState.hexShapes`). */
  isthmusWidth: ChannelWidth;
  straitWidth: ChannelWidth;
  /**
   * Land share of an Isthmus or Strait, tuning how much land the hex has once its width is set (the
   * flared ends of a neck, the banks of a channel). Absent: the natural shape for the width.
   */
  isthmusPercent?: number;
  straitPercent?: number;
  /** Glacier is land under ice; less than all of it for a hex at the edge of an ice sheet. */
  glacierPercent: number;
  /** Increment used when displaying areas (in square `unit`s). */
  areaRounding: number;
  /** Increment used when displaying lengths (in `unit`s). */
  lengthRounding: number;
}

export const DEFAULT_HEX_DIMENSIONS: HexDimensions = {
  width: 10,
  // Regular hex: corner-to-corner = flat-to-flat * 2 / sqrt(3).
  height: 11.5470053838,
  unit: 'km',
  coastalLandPercent: 90,
  lakeLandPercent: 0,
  largeIslandPercent: 20,
  smallIslandPercent: 5,
  mainlandPercent: 30,
  isthmusWidth: DEFAULT_CHANNEL_WIDTH.Isthmus,
  straitWidth: DEFAULT_CHANNEL_WIDTH.Strait,
  glacierPercent: 100,
  areaRounding: 100,
  lengthRounding: 10,
};

export const MAX_DIM = 50;
export const MIN_DIM = 3;
export const MAX_HISTORY = 40;
