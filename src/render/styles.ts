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

import type { LetteringId } from './lettering.js';
import { BASE_COLOURS, ISLAND_DOT, MAP_COLOURS } from './palette.js';

export type StylePresetId = 'classic' | 'parchment' | 'atlas' | 'night';

export interface StyleKnobs {
  /** Sea surface: one flat colour, shading that deepens away from land, or ripple lines along the coast. */
  water: 'flat' | 'depth' | 'ripples';
  /** How many ripple lines follow the sea coast (lakes always take one). */
  ripples: 1 | 2 | 3;
  /** Coastline: none, traced along hex edges, or smoothed (never more than an eighth of a hex off the data). */
  coast: 'none' | 'hex' | 'smooth';
  /** Hex grid: on every hex, on land only, or off. */
  grid: 'all' | 'land' | 'none';
  /** Coastal Land as its own band of colour, or the same colour as inland Land. */
  land: 'band' | 'uniform';
  /** Island hexes: a round dot, or an irregular islet with its own shore. */
  islands: 'dot' | 'blob';
  /** Ice: flat fill, or glacier shading with crevasses. */
  ice: 'flat' | 'glacier';
  /** Rivers: even strokes through hex centres, or a meandering course that widens downstream. */
  rivers: 'classic' | 'tapered';
  /**
   * How height is shown when the Elevation layer is visible: hexes tinted by
   * height, stacked marks per hex, drawn hills and peaks, or shading as if lit
   * from the north-west.
   */
  relief: 'colour' | 'marks' | 'illustrated' | 'hillshade';
  /** Realms as solid fills, as a wash of colour along their borders, or as outlines only. */
  polityStyle: 'fill' | 'tint' | 'wash' | 'outline';
  /** The ink line between realms: none, solid, dashed or dash-dot. Parts of one realm are always divided by a fine dashed line. */
  frontier: 'none' | 'solid' | 'dashed' | 'dashdot';
  /** Realm colours as chosen, lightened, or greyed. */
  polityTone: 'vivid' | 'pastel' | 'muted';
  /** Realm names in moderate type, or grown to fill their territory. */
  realmNames: 'moderate' | 'fill';
  /** Where a city's name goes first: beside its marker or below it. */
  cityNames: 'beside' | 'below';
  /** The typefaces names are set in: a pairing for realms, water and cities. */
  lettering: LetteringId;
  /** The dashed water-coloured marks on a city's coastal edges. */
  cityCoastMarks: boolean;
  /** Paper grain over the whole map. */
  grain: boolean;
  /** Polities that are part of another: in their own colours, or as shades of their parent's. */
  subPolities: 'own' | 'tints';
}

export type KnobId = keyof StyleKnobs;

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
  /** Crevasses and shading on glacier ice. */
  iceShade: string;
  grid: string;
  /** Grid line width, in hex sizes. */
  gridWidth: number;
  river: string;
  riverNonNavigable: string;
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
    coastWidth: 0.07,
    land: BASE_COLOURS.Land,
    coastalLand: BASE_COLOURS['Coastal Land'],
    island: ISLAND_DOT,
    ice: BASE_COLOURS.Ice,
    iceShade: '#b9cfdc',
    grid: MAP_COLOURS.hexOutline,
    gridWidth: 0.03,
    river: MAP_COLOURS.river,
    riverNonNavigable: MAP_COLOURS.riverNonNavigable,
    riverLabel: MAP_COLOURS.riverLabel,
    grain: '#000000',
    ink: '#2f2a22',
    grainStrength: 0.12,
    label: MAP_COLOURS.label,
    labelHalo: MAP_COLOURS.labelHalo,
    rangeLabel: MAP_COLOURS.rangeLabel,
    frontier: 'rgba(47, 42, 34, 0.8)',
    cityFill: MAP_COLOURS.city,
    cityRing: MAP_COLOURS.cityRing,
  },
  knobs: {
    water: 'flat',
    ripples: 2,
    coast: 'hex',
    grid: 'all',
    land: 'band',
    islands: 'dot',
    ice: 'flat',
    rivers: 'classic',
    grain: false,
    subPolities: 'own',
    relief: 'colour',
    polityStyle: 'fill',
    frontier: 'none',
    polityTone: 'vivid',
    cityCoastMarks: true,
    realmNames: 'moderate',
    cityNames: 'beside',
    lettering: 'classic',
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
    coastWidth: 0.07,
    land: '#e5d09c',
    coastalLand: '#d6b77c',
    island: '#d6b77c',
    ice: '#f4f2ea',
    iceShade: '#c9d4d2',
    grid: 'rgba(84, 62, 34, 0.20)',
    gridWidth: 0.025,
    river: '#3f7488',
    riverNonNavigable: '#4c8193',
    riverLabel: '#2c4b58',
    grain: '#5c4426',
    ink: '#3a2b1b',
    grainStrength: 0.14,
    label: '#2a1d10',
    labelHalo: '#efe3c2',
    rangeLabel: '#4a3a2c',
    frontier: 'rgba(58, 43, 27, 0.8)',
    cityFill: '#2a1d10',
    cityRing: '#f1e6c8',
  },
  knobs: {
    water: 'ripples',
    ripples: 2,
    coast: 'smooth',
    grid: 'land',
    // Coastal Land is data the rest of the map relies on, so it stays visible.
    land: 'band',
    islands: 'blob',
    ice: 'glacier',
    rivers: 'tapered',
    grain: true,
    subPolities: 'tints',
    relief: 'illustrated',
    polityStyle: 'wash',
    frontier: 'solid',
    polityTone: 'vivid',
    cityCoastMarks: false,
    realmNames: 'moderate',
    cityNames: 'beside',
    lettering: 'storybook',
  },
};

const ATLAS: PresetInfo = {
  id: 'atlas',
  label: 'Political atlas',
  description: 'Pale seas shading to the coast, every realm tinted in its colour with a strong border band and a crisp frontier, hill-shaded relief',
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
    iceShade: '#cfdde4',
    grid: 'rgba(60, 70, 80, 0.12)',
    gridWidth: 0.025,
    river: '#4f8fb5',
    riverNonNavigable: '#6aa3c4',
    riverLabel: '#2e5f80',
    grain: '#000000',
    ink: '#3b3a36',
    grainStrength: 0.08,
    label: '#22201c',
    labelHalo: '#f8f5ea',
    rangeLabel: '#5a4a3a',
    frontier: 'rgba(40, 38, 34, 0.85)',
    cityFill: '#22201c',
    cityRing: '#f8f5ea',
  },
  knobs: {
    water: 'depth',
    ripples: 2,
    coast: 'smooth',
    grid: 'none',
    land: 'band',
    islands: 'blob',
    ice: 'glacier',
    rivers: 'tapered',
    grain: false,
    subPolities: 'tints',
    relief: 'hillshade',
    polityStyle: 'tint',
    frontier: 'solid',
    polityTone: 'vivid',
    cityCoastMarks: false,
    realmNames: 'moderate',
    cityNames: 'beside',
    lettering: 'atlas',
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
    iceShade: '#6d8594',
    grid: 'rgba(160, 200, 220, 0.12)',
    gridWidth: 0.025,
    river: '#5fb4e0',
    riverNonNavigable: '#4a9ccc',
    riverLabel: '#bfe6ff',
    grain: '#000000',
    ink: '#0b1016',
    grainStrength: 0.1,
    label: '#e8eef0',
    labelHalo: '#0f1a26',
    rangeLabel: '#d6d0c0',
    frontier: 'rgba(220, 232, 240, 0.7)',
    cityFill: '#e8eef0',
    cityRing: '#0f1a26',
  },
  knobs: {
    water: 'ripples',
    ripples: 2,
    coast: 'smooth',
    grid: 'all',
    land: 'band',
    islands: 'blob',
    ice: 'flat',
    rivers: 'tapered',
    grain: false,
    subPolities: 'tints',
    relief: 'hillshade',
    polityStyle: 'outline',
    frontier: 'solid',
    polityTone: 'muted',
    cityCoastMarks: false,
    realmNames: 'moderate',
    cityNames: 'beside',
    lettering: 'storybook',
  },
};

export const PRESETS: Record<StylePresetId, PresetInfo> = {
  classic: CLASSIC,
  parchment: PARCHMENT,
  atlas: ATLAS,
  night: NIGHT,
};

export const PRESET_ORDER: StylePresetId[] = ['classic', 'parchment', 'atlas', 'night'];

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
      { value: 'glacier', label: 'Glacier' },
    ],
  },
  rivers: {
    label: 'Rivers',
    options: [
      { value: 'classic', label: 'Even strokes' },
      { value: 'tapered', label: 'Meandering, widening' },
    ],
  },
  relief: {
    label: 'Elevation shown as',
    options: [
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
      { value: 'atlas', label: 'Atlas (Alegreya)' },
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
  grain: {
    label: 'Paper grain',
    options: [
      { value: false, label: 'Off' },
      { value: true, label: 'On' },
    ],
  },
};

export const KNOB_ORDER: KnobId[] = ['relief', 'water', 'ripples', 'coast', 'grid', 'land', 'islands', 'ice', 'rivers', 'polityStyle', 'frontier', 'polityTone', 'subPolities', 'lettering', 'realmNames', 'cityNames', 'cityCoastMarks', 'grain'];

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
 * tints the hex fills ('colour') or is drawn over them (everything else).
 * Legends and fill precedence still reason in these terms.
 */
export function elevationStyleOf(style: MapStyle): 'colour' | 'contours' {
  return style.knobs.relief === 'colour' ? 'colour' : 'contours';
}
