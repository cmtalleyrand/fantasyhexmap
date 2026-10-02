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

import { BASE_COLOURS, ISLAND_DOT, MAP_COLOURS } from './palette.js';

export type StylePresetId = 'classic' | 'parchment';

export interface StyleKnobs {
  /** Sea surface: one flat colour, shading that deepens away from land, or ripple lines along the coast. */
  water: 'flat' | 'depth' | 'ripples';
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
  /** Paper grain over the whole map. */
  grain: boolean;
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
  /** Peak opacity of the grain, 0-1. */
  grainStrength: number;
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
    grainStrength: 0.12,
  },
  knobs: {
    water: 'flat',
    coast: 'hex',
    grid: 'all',
    land: 'band',
    islands: 'dot',
    ice: 'flat',
    rivers: 'classic',
    grain: false,
  },
};

const PARCHMENT: PresetInfo = {
  id: 'parchment',
  label: 'Parchment (draft)',
  description: 'Inked coasts and rippled seas on aged paper, in the manner of a novel’s endpapers',
  palette: {
    sea: '#a9c0b8',
    seaShallow: '#c2d3c6',
    lake: '#a3bdb6',
    ripple: '#3e5450',
    rippleAlpha: 0.5,
    coast: '#3b2f22',
    coastWidth: 0.07,
    land: '#eadcb4',
    coastalLand: '#e2cf9f',
    island: '#eadcb4',
    ice: '#f4f2ea',
    iceShade: '#c9d4d2',
    grid: 'rgba(84, 62, 34, 0.20)',
    gridWidth: 0.025,
    river: '#4f7f91',
    riverNonNavigable: '#5f8c9c',
    riverLabel: '#2c4b58',
    grain: '#5c4426',
    grainStrength: 0.14,
  },
  knobs: {
    water: 'ripples',
    coast: 'smooth',
    grid: 'land',
    land: 'uniform',
    islands: 'blob',
    ice: 'glacier',
    rivers: 'tapered',
    grain: true,
  },
};

export const PRESETS: Record<StylePresetId, PresetInfo> = {
  classic: CLASSIC,
  parchment: PARCHMENT,
};

export const PRESET_ORDER: StylePresetId[] = ['classic', 'parchment'];

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
  grain: {
    label: 'Paper grain',
    options: [
      { value: false, label: 'Off' },
      { value: true, label: 'On' },
    ],
  },
};

export const KNOB_ORDER: KnobId[] = ['water', 'coast', 'grid', 'land', 'islands', 'ice', 'rivers', 'grain'];

export const DEFAULT_STYLE_CHOICE: MapStyleChoice = { preset: 'classic', overrides: {} };

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
