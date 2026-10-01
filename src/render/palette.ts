import type {
  BaseGeo,
  Climate,
  Elevation,
  Vegetation,
} from '../../shared/types.js';

export const BASE_COLOURS: Record<BaseGeo, string> = {
  Sea: '#1d3b57',
  Lake: '#2f6f8f',
  Land: '#c4d49b',
  'Coastal Land': '#d9c58f',
  Ice: '#e4eef3',
  Island: '#1d3b57', // sea substrate; the landmass is drawn as a dot on top
};

export const ISLAND_DOT = '#cbbd93';

/**
 * Elevation is not a single ordered ramp, so Plateau deliberately sits off the
 * green-to-brown ladder: it is high ground with low ruggedness, and colouring it
 * as a step between Hills and Mountains would be a lie the map keeps telling.
 */
export const ELEVATION_COLOURS: Record<Elevation, string> = {
  Lowland: '#d8e3b0',
  Rolling: '#bcd08c',
  Hills: '#a3b06e',
  Highland: '#8f8d5c',
  Mountains: '#7d6d59',
  Plateau: '#cbab74',
};

/** The conventional Köppen-Geiger map colours, so the layer reads like an atlas. */
export const CLIMATE_COLOURS: Record<Climate, string> = {
  Af: '#0000fe', Am: '#0077ff', Aw: '#46a9fa',
  BWh: '#fe0000', BWk: '#ff9695', BSh: '#f5a300', BSk: '#ffdb63',
  Csa: '#ffff00', Csb: '#c6c700', Cfa: '#c6ff4e', Cfb: '#66ff33', Cwa: '#96ff96',
  Dfa: '#33c7ff', Dfb: '#009ffe', Dfc: '#007e7d',
  Dsa: '#ff00fe', Dsb: '#c600c7', Dwa: '#abb1ff', Dwb: '#5a77db',
  ET: '#b2b2b2', EF: '#686868',
};

export const VEGETATION_COLOURS: Record<Vegetation, string> = {
  'Barren Desert': '#e8d7a8',
  Scrubland: '#c4bb7c',
  Wetland: '#6f8f79',
  Tundra: '#bcc7c0',
  Steppe: '#cfc684',
  Prairie: '#b6c96b',
  Savanna: '#d6c76c',
  Veld: '#a9bb6d',
  'Boreal Forest': '#2f5d4a',
  'Coniferous Forest': '#2c6b4f',
  'Deciduous Forest': '#4c8c3f',
  'Tropical Rainforest': '#14572a',
  'Subtropical Rainforest': '#2b7d45',
  'Flood Plain': '#9fc27a',
  Breadbasket: '#e2c24c',
  'Black Earth': '#6b5136',
  Assart: '#8fae5a',
  'Paddy Fields': '#7fbf8f',
  'Desert Oasis': '#4fae86',
};

const POPULATION_RAMP = [
  '#f6f2e4', '#e8dcc0', '#dcc194', '#cf9f6e', '#bf7a52', '#a8543f', '#7f2f28',
];

/** Log scale: population per hex spans orders of magnitude. */
export function populationColour(value: number, max: number): string {
  if (max <= 0 || value <= 0) return POPULATION_RAMP[0]!;
  const t = Math.log10(1 + value) / Math.log10(1 + max);
  const i = Math.min(POPULATION_RAMP.length - 1, Math.floor(t * POPULATION_RAMP.length));
  return POPULATION_RAMP[i]!;
}

export const POPULATION_LEGEND_RAMP = POPULATION_RAMP;

export const MAP_COLOURS = {
  background: '#101418',
  paper: '#0f1418',
  hexOutline: 'rgba(0,0,0,0.20)',
  emptyHex: '#242c33',
  river: '#3f8fd0',
  coastMark: '#9fe0ff',
  riverNonNavigable: '#5aa6de',
  city: '#1a1410',
  cityRing: '#f6f1e4',
  label: '#14100c',
  labelHalo: '#f7f3e7',
  selection: '#ffd166',
  hover: 'rgba(255,255,255,0.55)',
  stale: '#e6a33c',
};

export const POLITY_PALETTE = [
  '#4477aa', '#ee6677', '#228833', '#ccbb44', '#aa3377', '#66ccee',
  '#ee8866', '#004488', '#bb5566', '#009988', '#ddaa33', '#772288',
];

/** Greedily maximises RGB distance between adjacent polity colours. */
export function contrastingPolityColours(
  polityIds: string[], owner: Array<string | null>, cols: number, rows: number,
): Map<string, string> {
  const neighbours = new Map(polityIds.map((id) => [id, new Set<string>()]));
  const connect = (a: string | null, b: string | null) => {
    if (!a || !b || a === b || !neighbours.has(a) || !neighbours.has(b)) return;
    neighbours.get(a)!.add(b);
    neighbours.get(b)!.add(a);
  };
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const here = owner[row * cols + col] ?? null;
    if (col + 1 < cols) connect(here, owner[row * cols + col + 1] ?? null);
    if (row + 1 < rows) {
      connect(here, owner[(row + 1) * cols + col] ?? null);
      const diagonal = col + (row % 2 === 0 ? -1 : 1);
      if (diagonal >= 0 && diagonal < cols) connect(here, owner[(row + 1) * cols + diagonal] ?? null);
    }
  }
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const distance = (a: string, b: string) => rgb(a).reduce((sum, v, i) => sum + (v - rgb(b)[i]!) ** 2, 0);
  const result = new Map<string, string>();
  const ordered = [...polityIds].sort((a, b) => neighbours.get(b)!.size - neighbours.get(a)!.size || a.localeCompare(b));
  for (const id of ordered) {
    const adjacent = [...neighbours.get(id)!].map((n) => result.get(n)).filter((c): c is string => Boolean(c));
    const comparison = adjacent.length ? adjacent : [...result.values()];
    const score = (colour: string) => Math.min(...comparison.map((c) => distance(colour, c)), Infinity);
    result.set(id, POLITY_PALETTE.reduce((best, colour) => score(colour) > score(best) ? colour : best));
  }
  return result;
}

export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Pick black or white text for legibility on a given background. */
export function contrastInk(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#000';
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const luminance = (0.299 * r! + 0.587 * g! + 0.114 * b!) / 255;
  return luminance > 0.55 ? '#14100c' : '#f7f3e7';
}
