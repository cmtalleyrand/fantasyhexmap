/**
 * Map styles.
 *
 * A style is every aesthetic decision the scene builder makes that is not data:
 * how water, coasts, the grid, islands, ice and rivers are drawn, in which
 * colours, on what paper. A user picks a preset and may then override single
 * knobs, so "Parchment, but with the full hex grid" is one choice, not a new
 * template. Overrides are stored apart from the preset so that improving a
 * preset later reaches everyone who has not overridden that knob.
 */

import type { CityMarkerSet } from './cityMarkers.js';
import type { CityRiver } from './riverCity.js';
import type { LetteringId } from './lettering.js';
import { BASE_COLOURS, ISLAND_DOT, MAP_COLOURS } from './palette.js';

export type StylePresetId = 'classic' | 'parchment' | 'atlas' | 'night' | 'frills';

export interface StyleKnobs {
  /** Sea surface: one flat colour, shading that deepens away from land, or ripple lines along the coast. */
  water: 'flat' | 'depth' | 'ripples';
  /** How many ripple lines follow the sea coast: none, or up to three (a lake takes at most one). */
  ripples: 0 | 1 | 2 | 3;
  /** Coastline: none, traced along hex edges, or smoothed (never more than an eighth of a hex off the data). */
  coast: 'none' | 'hex' | 'smooth';
  /** Hex grid: on every hex, on land only, or off. */
  grid: 'all' | 'land' | 'none';
  /** Coastal Land as its own band of colour, or the same colour as inland Land. */
  land: 'band' | 'uniform';
  /** Island hexes: a round dot, or an irregular islet with its own shore. */
  islands: 'dot' | 'blob';
  /** Ice: flat fill, or glaciers shaded by elevation and cracked with crevasses. */
  ice: 'flat' | 'glacier';
  /** Rivers: even strokes through hex centres, or a meandering course that widens downstream. */
  rivers: 'classic' | 'tapered';
  /** How irregular a meandering river's course is, and how far it swings into the hexes it bends through. */
  riverWander: RiverWander;
  /**
   * How height is shown when the Elevation layer is visible: hexes tinted by
   * height, stacked marks per hex, drawn hills and peaks, or shading as if lit
   * from the north-west. 'none' leaves height out of the picture entirely.
   */
  relief: 'none' | 'colour' | 'marks' | 'illustrated' | 'hillshade';
  /** Realms as solid fills, as a wash of colour along their borders, or as outlines only. */
  polityStyle: 'fill' | 'tint' | 'wash' | 'outline';
  /** The ink line between realms: none, solid, dashed or dash-dot. Parts of one realm are always divided by a fine dashed line. */
  frontier: 'none' | 'solid' | 'dashed' | 'dashdot';
  /** How far the borders between realms stray from the hex edges: not at all, a little, noticeably, or a lot. */
  borders: 'straight' | 'wobbly' | 'ragged' | 'wild';
  /** Realm colours as chosen, lightened, or greyed. */
  polityTone: 'vivid' | 'pastel' | 'muted';
  /** Realm names in moderate type, or grown to fill their territory. */
  realmNames: 'moderate' | 'fill';
  /** Where a city's name goes first: beside its marker or below it. */
  cityNames: 'beside' | 'below';
  /** The typefaces names are set in: a pairing for realms, water and cities. */
  lettering: LetteringId;
  /** City markers: the app's symbols, the atlas convention of dots and rings, or drawn buildings. */
  cityMarkers: CityMarkerSet;
  /** How a city's icon sits with the river it stands on: beside it, over its bank, beside it with a bridge, or on an islet. */
  cityRiver: CityRiver;
  /** The dashed water-coloured marks on a city's coastal edges. */
  cityCoastMarks: boolean;
  /** Thickness of the ink lines (coasts and frontiers) relative to the style's own: fine, thin, standard, bold or heavy. */
  lineWeight: 0.5 | 0.75 | 1 | 1.5 | 2;
  /** Paper grain over the whole map. */
  grain: boolean;
  /** Polities that are part of another: in their own colours, or as shades of their parent's. */
  subPolities: 'own' | 'tints';
}

export type RiverWander = 'verygentle' | 'gentle' | 'normal' | 'irregular' | 'wild';

export type KnobId = keyof StyleKnobs;

/** How a map's legend and fills treat elevation: tinted by it, marked with it, or leaving it out. */
export type ElevationStyle = 'colour' | 'contours' | 'none';

export interface StylePalette {
  sea: string;
  /** Shallow water, reached at the coast when water is depth-shaded. */
  seaShallow: string;
  lake: string;
  /** Ripple lines over water (a #rrggbb colour) and their opacity nearest the shore. */
  ripple: string;
  rippleAlpha: number;
  coast: string;
  /** Coast line width, in hex sizes. */
  coastWidth: number;
  land: string;
  coastalLand: string;
  island: string;
  ice: string;
  /** Pack ice on the sea: the sea's colour frozen over, a little bluer than glacier ice. */
  seaIce: string;
  /** Crevasses and shading on glacier ice, and the cracks between floes of sea ice. */
  iceShade: string;
  grid: string;
  /** Grid line width, in hex sizes. */
  gridWidth: number;
  river: string;
  riverNonNavigable: string;
  /** The darker edge a tapered river is drawn with. */
  riverBank: string;
  riverLabel: string;
  grain: string;
  /** Linework of drawn symbols (peaks, trees) and the shadow side of hill shading. */
  ink: string;
  /** Peak opacity of the grain, 0-1. */
  grainStrength: number;
  /** Realm and city names. */
  label: string;
  /** The outline behind city, river and range names. */
  labelHalo: string;
  rangeLabel: string;
  /** The line between realms (wash and outline styles) and, fainter, between parts of one realm. */
  frontier: string;
  /** City markers: body and ring. */
  cityFill: string;
  cityRing: string;
}

export interface MapStyle {
  preset: StylePresetId;
  palette: StylePalette;
  knobs: StyleKnobs;
}

/** What is stored: a preset and the knobs the user changed from it. */
export interface MapStyleChoice {
  preset: StylePresetId;
  overrides: Partial<StyleKnobs>;
}

export interface PresetInfo {
  id: StylePresetId;
  label: string;
  description: string;
  palette: StylePalette;
  knobs: StyleKnobs;
}

const CLASSIC: PresetInfo = {
  id: 'classic',
  label: 'Classic hex',
  description: 'Exact hex geometry on a dark sea, for play where every hex counts',
  palette: {
    sea: BASE_COLOURS.Sea,
    seaShallow: '#2f5a7c',
    lake: BASE_COLOURS.Lake,
    ripple: '#9fd2f0',
    rippleAlpha: 0.32,
    coast: '#16232e',
    coastWidth: 0.0525,
    land: BASE_COLOURS.Land,
    coastalLand: BASE_COLOURS['Coastal Land'],
    island: ISLAND_DOT,
    ice: BASE_COLOURS.Glacier,
    seaIce: BASE_COLOURS['Sea Ice'],
    iceShade: '#b9cfdc',
    grid: MAP_COLOURS.hexOutline,
    gridWidth: 0.03,
    river: MAP_COLOURS.river,
    riverNonNavigable: MAP_COLOURS.riverNonNavigable,
    riverBank: MAP_COLOURS.riverBank,
    riverLabel: MAP_COLOURS.riverLabel,
    grain: '#000000',
    ink: '#2f2a22',
    grainStrength: 0.12,
    label: MAP_COLOURS.label,
    labelHalo: 'rgba(247, 243, 231, 0.8)',
    rangeLabel: MAP_COLOURS.rangeLabel,
    frontier: 'rgba(47, 42, 34, 0.8)',
    cityFill: MAP_COLOURS.city,
    cityRing: MAP_COLOURS.cityRing,
  },
  knobs: {
    water: 'flat',
    ripples: 0,
    coast: 'hex',
    grid: 'all',
    land: 'band',
    islands: 'dot',
    ice: 'flat',
    rivers: 'classic',
    riverWander: 'normal',
    lineWeight: 1,
    grain: false,
    subPolities: 'own',
    relief: 'colour',
    polityStyle: 'fill',
    frontier: 'none',
    polityTone: 'vivid',
    borders: 'ragged',
    cityCoastMarks: true,
    realmNames: 'moderate',
    cityNames: 'beside',
    lettering: 'classic',
    cityMarkers: 'symbols',
    cityRiver: 'beside',
  },
};

const PARCHMENT: PresetInfo = {
  id: 'parchment',
  label: 'Parchment',
  description: 'Inked coasts and rippled seas on aged paper, in the manner of a novel’s endpapers',
  palette: {
    sea: '#8fb0a6',
    seaShallow: '#abc6b6',
    lake: '#8aaea6',
    ripple: '#2f4842',
    rippleAlpha: 0.5,
    coast: '#30251a',
    coastWidth: 0.0525,
    land: '#e5d09c',
    coastalLand: '#d6b77c',
    island: '#d6b77c',
    ice: '#f4f2ea',
    seaIce: '#dde8e4',
    iceShade: '#c9d4d2',
    grid: 'rgba(84, 62, 34, 0.20)',
    gridWidth: 0.025,
    river: '#3f7488',
    riverNonNavigable: '#4c8193',
    riverBank: '#2c5363',
    riverLabel: '#2c4b58',
    grain: '#5c4426',
    ink: '#3a2b1b',
    grainStrength: 0.14,
    label: '#2a1d10',
    labelHalo: 'rgba(239, 227, 194, 0.8)',
    rangeLabel: '#4a3a2c',
    frontier: 'rgba(58, 43, 27, 0.8)',
    cityFill: '#2a1d10',
    cityRing: '#f1e6c8',
  },
  knobs: {
    water: 'ripples',
    ripples: 0,
    coast: 'smooth',
    grid: 'land',
    // Coastal Land is data the rest of the map relies on, so it stays visible.
    land: 'band',
    islands: 'blob',
    ice: 'glacier',
    rivers: 'tapered',
    riverWander: 'normal',
    lineWeight: 1,
    grain: true,
    subPolities: 'tints',
    relief: 'illustrated',
    polityStyle: 'wash',
    frontier: 'solid',
    polityTone: 'vivid',
    borders: 'ragged',
    cityCoastMarks: false,
    realmNames: 'moderate',
    cityNames: 'beside',
    lettering: 'storybook',
    cityMarkers: 'illustrated',
    cityRiver: 'beside',
  },
};

const FRILLS: PresetInfo = {
  id: 'frills',
  label: 'All frills',
  description: 'Parchment with every embellishment on: triple ripple lines round every shore, drawn mountains, buildings and names that fill their realms',
  palette: PARCHMENT.palette,
  knobs: {
    ...PARCHMENT.knobs,
    water: 'ripples',
    ripples: 3,
    cityCoastMarks: true,
    realmNames: 'fill',
  },
};

const ATLAS: PresetInfo = {
  id: 'atlas',
  label: 'Political atlas',
  description: 'Pale seas shading to the coast, every realm and sub-polity in its own strong colour with a crisp frontier; no relief, so the politics stand alone',
  palette: {
    sea: '#a9cfe0',
    seaShallow: '#d6ecf2',
    lake: '#a2c8da',
    ripple: '#4a7f99',
    rippleAlpha: 0.4,
    coast: '#3f6274',
    coastWidth: 0.05,
    land: '#f3eedc',
    coastalLand: '#ebe0c2',
    island: '#ebe0c2',
    ice: '#f8fbfc',
    seaIce: '#e3f0f6',
    iceShade: '#cfdde4',
    grid: 'rgba(60, 70, 80, 0.12)',
    gridWidth: 0.025,
    river: '#4f8fb5',
    riverNonNavigable: '#6aa3c4',
    riverBank: '#38688a',
    riverLabel: '#2e5f80',
    grain: '#000000',
    ink: '#3b3a36',
    grainStrength: 0.08,
    label: '#22201c',
    labelHalo: 'rgba(248, 245, 234, 0.8)',
    rangeLabel: '#5a4a3a',
    frontier: 'rgba(40, 38, 34, 0.85)',
    cityFill: '#22201c',
    cityRing: '#f8f5ea',
  },
  knobs: {
    water: 'depth',
    ripples: 0,
    coast: 'smooth',
    grid: 'none',
    land: 'band',
    islands: 'blob',
    ice: 'glacier',
    rivers: 'tapered',
    riverWander: 'normal',
    lineWeight: 1,
    grain: false,
    subPolities: 'own',
    relief: 'none',
    polityStyle: 'fill',
    frontier: 'solid',
    polityTone: 'vivid',
    borders: 'ragged',
    cityCoastMarks: false,
    realmNames: 'moderate',
    cityNames: 'beside',
    lettering: 'chancery',
    cityMarkers: 'classic',
    cityRiver: 'beside',
  },
};

const NIGHT: PresetInfo = {
  id: 'night',
  label: 'Night campaign',
  description: 'A dark table map with glowing coasts and rivers, for a screen or a virtual tabletop',
  palette: {
    sea: '#0f1a26',
    seaShallow: '#1d3a4f',
    lake: '#16303f',
    ripple: '#5fa8d3',
    rippleAlpha: 0.38,
    coast: '#7cc6e8',
    coastWidth: 0.06,
    land: '#2b3a33',
    coastalLand: '#36483d',
    island: '#36483d',
    ice: '#9fb4c0',
    seaIce: '#7f9bad',
    iceShade: '#6d8594',
    grid: 'rgba(160, 200, 220, 0.12)',
    gridWidth: 0.025,
    river: '#5fb4e0',
    riverNonNavigable: '#4a9ccc',
    riverBank: '#2f7fae',
    riverLabel: '#bfe6ff',
    grain: '#000000',
    ink: '#0b1016',
    grainStrength: 0.1,
    label: '#e8eef0',
    labelHalo: 'rgba(15, 26, 38, 0.8)',
    rangeLabel: '#d6d0c0',
    frontier: 'rgba(220, 232, 240, 0.7)',
    cityFill: '#e8eef0',
    cityRing: '#0f1a26',
  },
  knobs: {
    water: 'ripples',
    ripples: 0,
    coast: 'smooth',
    grid: 'all',
    land: 'band',
    islands: 'blob',
    ice: 'flat',
    rivers: 'tapered',
    riverWander: 'normal',
    lineWeight: 1,
    grain: false,
    subPolities: 'tints',
    relief: 'hillshade',
    polityStyle: 'outline',
    frontier: 'solid',
    polityTone: 'muted',
    borders: 'ragged',
    cityCoastMarks: false,
    realmNames: 'moderate',
    cityNames: 'beside',
    lettering: 'storybook',
    cityMarkers: 'classic',
    cityRiver: 'beside',
  },
};

export const PRESETS: Record<StylePresetId, PresetInfo> = {
  classic: CLASSIC,
  parchment: PARCHMENT,
  atlas: ATLAS,
  night: NIGHT,
  frills: FRILLS,
};

export const PRESET_ORDER: StylePresetId[] = ['classic', 'parchment', 'atlas', 'night', 'frills'];

/** Every knob's allowed values with a label for each, in display order. */
export const KNOB_OPTIONS: {
  [K in KnobId]: { label: string; options: Array<{ value: StyleKnobs[K]; label: string }> };
} = {
  water: {
    label: 'Sea',
    options: [
      { value: 'flat', label: 'Flat' },
      { value: 'depth', label: 'Depth shading' },
      { value: 'ripples', label: 'Ripple lines' },
    ],
  },
  ripples: {
    label: 'Ripple count',
    options: [
      { value: 0, label: 'None' },
      { value: 1, label: 'One' },
      { value: 2, label: 'Two' },
      { value: 3, label: 'Three' },
    ],
  },
  coast: {
    label: 'Coastline',
    options: [
      { value: 'none', label: 'None' },
      { value: 'hex', label: 'Along hex edges' },
      { value: 'smooth', label: 'Smoothed' },
    ],
  },
  grid: {
    label: 'Hex grid',
    options: [
      { value: 'all', label: 'Everywhere' },
      { value: 'land', label: 'Land only' },
      { value: 'none', label: 'Off' },
    ],
  },
  land: {
    label: 'Coastal land',
    options: [
      { value: 'band', label: 'Own colour' },
      { value: 'uniform', label: 'Same as inland' },
    ],
  },
  islands: {
    label: 'Islands',
    options: [
      { value: 'dot', label: 'Dots' },
      { value: 'blob', label: 'Islets' },
    ],
  },
  ice: {
    label: 'Ice',
    options: [
      { value: 'flat', label: 'Flat' },
      { value: 'glacier', label: 'Textured' },
    ],
  },
  rivers: {
    label: 'Rivers',
    options: [
      { value: 'classic', label: 'Even strokes' },
      { value: 'tapered', label: 'Meandering, widening' },
    ],
  },
  riverWander: {
    label: 'River irregularity',
    options: [
      { value: 'verygentle', label: 'Very gentle' },
      { value: 'gentle', label: 'Gentle' },
      { value: 'normal', label: 'Normal' },
      { value: 'irregular', label: 'Irregular (deep, sharp bends)' },
      { value: 'wild', label: 'Wild (very deep, sharp bends)' },
    ],
  },
  relief: {
    label: 'Elevation shown as',
    options: [
      { value: 'none', label: 'Not shown' },
      { value: 'colour', label: 'Colours by height' },
      { value: 'marks', label: 'Height marks' },
      { value: 'illustrated', label: 'Drawn mountains and hills' },
      { value: 'hillshade', label: 'Shaded slopes' },
    ],
  },
  polityStyle: {
    label: 'Realms',
    options: [
      { value: 'fill', label: 'Filled' },
      { value: 'tint', label: 'Tint with border' },
      { value: 'wash', label: 'Border wash' },
      { value: 'outline', label: 'Outline' },
    ],
  },
  frontier: {
    label: 'Frontier line',
    options: [
      { value: 'none', label: 'None' },
      { value: 'solid', label: 'Solid' },
      { value: 'dashed', label: 'Dashed' },
      { value: 'dashdot', label: 'Dash-dot' },
    ],
  },
  borders: {
    label: 'Border irregularity',
    options: [
      { value: 'straight', label: 'Straight (hex edges)' },
      { value: 'wobbly', label: 'Slightly wobbly' },
      { value: 'ragged', label: 'Ragged' },
      { value: 'wild', label: 'Very ragged' },
    ],
  },
  polityTone: {
    label: 'Realm colours',
    options: [
      { value: 'vivid', label: 'As chosen' },
      { value: 'pastel', label: 'Pastel' },
      { value: 'muted', label: 'Muted' },
    ],
  },
  realmNames: {
    label: 'Realm names',
    options: [
      { value: 'moderate', label: 'Moderate size' },
      { value: 'fill', label: 'Fill the territory' },
    ],
  },
  cityNames: {
    label: 'City names',
    options: [
      { value: 'beside', label: 'Beside the marker' },
      { value: 'below', label: 'Below the marker' },
    ],
  },
  lettering: {
    label: 'Lettering',
    options: [
      { value: 'classic', label: 'Classic (Palatino)' },
      { value: 'storybook', label: 'Storybook (Cinzel, Garamond)' },
      { value: 'oldprint', label: 'Old print (IM Fell)' },
      { value: 'chancery', label: 'Chancery (Almendra)' },
      { value: 'uncial', label: 'Uncial (Uncial Antiqua, Garamond)' },
    ],
  },
  cityMarkers: {
    label: 'City markers',
    options: [
      { value: 'symbols', label: 'Symbols' },
      { value: 'classic', label: 'Dots and rings' },
      { value: 'illustrated', label: 'Drawn buildings' },
    ],
  },
  cityRiver: {
    label: 'Cities on rivers',
    options: [
      { value: 'beside', label: 'Beside the river (river bows round the icon)' },
      { value: 'overlay', label: 'Over the bank (river runs behind the icon)' },
      { value: 'bridge', label: 'Beside the river, with a bridge' },
      { value: 'islet', label: 'On an islet (river splits round the icon)' },
    ],
  },
  cityCoastMarks: {
    label: 'Coastal edge marks on cities',
    options: [
      { value: false, label: 'Off' },
      { value: true, label: 'On' },
    ],
  },
  subPolities: {
    label: 'Sub-polities',
    options: [
      { value: 'own', label: 'Own colours' },
      { value: 'tints', label: 'Shades of their realm' },
    ],
  },
  lineWeight: {
    label: 'Line thickness',
    options: [
      { value: 0.5, label: 'Fine' },
      { value: 0.75, label: 'Thin' },
      { value: 1, label: 'Standard' },
      { value: 1.5, label: 'Bold' },
      { value: 2, label: 'Heavy' },
    ],
  },
  grain: {
    label: 'Paper grain',
    options: [
      { value: false, label: 'Off' },
      { value: true, label: 'On' },
    ],
  },
};

export const KNOB_ORDER: KnobId[] = ['relief', 'water', 'ripples', 'coast', 'grid', 'land', 'islands', 'ice', 'rivers', 'riverWander', 'polityStyle', 'frontier', 'borders', 'polityTone', 'subPolities', 'lettering', 'realmNames', 'cityNames', 'cityMarkers', 'cityRiver', 'cityCoastMarks', 'lineWeight', 'grain'];

export const DEFAULT_STYLE_CHOICE: MapStyleChoice = { preset: 'classic', overrides: {} };

/** What a new user starts with. Saved choices, and prefs saved before styles existed, keep Classic. */
export const NEW_USER_STYLE_CHOICE: MapStyleChoice = { preset: 'parchment', overrides: {} };

export function resolveStyle(choice: MapStyleChoice | null | undefined): MapStyle {
  const preset = PRESETS[choice?.preset ?? 'classic'] ?? CLASSIC;
  return {
    preset: preset.id,
    palette: preset.palette,
    knobs: { ...preset.knobs, ...(choice?.overrides ?? {}) },
  };
}

export const CLASSIC_STYLE: MapStyle = resolveStyle(DEFAULT_STYLE_CHOICE);

/** Read a stored choice, dropping anything that is not a known preset or knob value. */
export function parseStyleChoice(raw: unknown): MapStyleChoice {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_STYLE_CHOICE, overrides: {} };
  const value = raw as { preset?: unknown; overrides?: unknown };
  const preset = PRESET_ORDER.includes(value.preset as StylePresetId)
    ? (value.preset as StylePresetId)
    : 'classic';
  const overrides: Partial<StyleKnobs> = {};
  const stored = value.overrides && typeof value.overrides === 'object'
    ? (value.overrides as Record<string, unknown>)
    : {};
  for (const knob of KNOB_ORDER) {
    const v = stored[knob];
    if (KNOB_OPTIONS[knob].options.some((o) => o.value === v)) {
      (overrides as Record<string, unknown>)[knob] = v;
    }
  }
  return { preset, overrides };
}

/** Set one knob, dropping the override when it matches the preset again. */
export function withKnob<K extends KnobId>(
  choice: MapStyleChoice,
  knob: K,
  value: StyleKnobs[K],
): MapStyleChoice {
  const overrides = { ...choice.overrides };
  if (PRESETS[choice.preset].knobs[knob] === value) delete overrides[knob];
  else overrides[knob] = value;
  return { ...choice, overrides };
}

/** A key that changes whenever anything the scene draws from the style changes. */
export function styleKey(style: MapStyle): string {
  return `${style.preset}|${KNOB_ORDER.map((k) => String(style.knobs[k])).join(',')}`;
}

/**
 * The older two-way elevation setting a style amounts to: whether elevation
 * tints the hex fills ('colour'), is drawn over them, or is left out ('none').
 * Legends and fill precedence still reason in these terms.
 */
export function elevationStyleOf(style: MapStyle): ElevationStyle {
  const { relief } = style.knobs;
  return relief === 'colour' ? 'colour' : relief === 'none' ? 'none' : 'contours';
}
