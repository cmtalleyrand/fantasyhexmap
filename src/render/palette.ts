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
  Glacier: '#e4eef3',
  // Frozen sea: pale, with a cold tint of the water under it.
  'Sea Ice': '#c9dde8',
  // Sea substrate: the islands are drawn on top.
  Islands: '#1d3b57',
  // Split hexes: the colour of their land; the water in them is drawn over it.
  'Mainland and islands': '#d9c58f',
  Isthmus: '#d9c58f',
  // A channel of sea: its banks take the colours of the land they face.
  Strait: '#1d3b57',
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
  elevationContour: 'rgba(37,30,22,0.72)',
  city: '#1a1410',
  cityRing: '#f6f1e4',
  label: '#14100c',
  labelHalo: '#f7f3e7',
  riverLabel: '#1f5f99',
  rangeLabel: '#4a3a2c',
  selection: '#ffd166',
  hover: 'rgba(255,255,255,0.55)',
  stale: '#e6a33c',
};

export const POLITY_PALETTE = [
  '#2f6fbb', '#e84a5f', '#16843b', '#d2ad20', '#a52878', '#28a9cc',
  '#ed7048', '#064f9b', '#b63f5b', '#008c7a', '#d88c16', '#7529a3',
];

export type PolityTone = 'vivid' | 'muted' | 'pastel';

/** Saturation and lightness cycles (percent) the generated colours step through, per tone. */
const TONE_CYCLES: Record<PolityTone, { saturation: number[]; lightness: number[] }> = {
  vivid: { saturation: [72, 82, 66], lightness: [46, 56, 38] },
  muted: { saturation: [38, 46, 32], lightness: [48, 58, 40] },
  pastel: { saturation: [55, 65, 45], lightness: [76, 82, 70] },
};

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const s = saturation / 100;
  const l = lightness / 100;
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
  const m = l - chroma / 2;
  const [r, g, b] =
    hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] :
    hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] :
    hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return `#${[r, g, b].map((channel) => Math.round((channel + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * At least `count` distinct candidate colours: the curated set first (for the
 * vivid tone), then golden-angle hues stepping through the tone's saturation
 * and lightness cycles so successive colours differ in more than hue.
 */
function candidatePolityColours(count: number, tone: PolityTone): string[] {
  const colours = tone === 'vivid' ? [...POLITY_PALETTE] : [];
  const seen = new Set(colours);
  const { saturation, lightness } = TONE_CYCLES[tone];
  for (let i = 0; colours.length < count; i++) {
    const colour = hslToHex(
      (i * 137.508) % 360,
      saturation[i % saturation.length]!,
      lightness[Math.floor(i / saturation.length) % lightness.length]!,
    );
    if (!seen.has(colour)) {
      seen.add(colour);
      colours.push(colour);
    }
  }
  return colours;
}

/** sRGB #rrggbb to CIELAB (D65). */
export function toLab(hex: string): [number, number, number] {
  const lin = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = lin as [number, number, number];
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** Pairs nearer than this (perceptual units) are penalised when they share a border. */
const BORDER_TARGET = 48;
/** Pairs nearer than this are mildly penalised even when apart, so the whole legend stays readable. */
const GLOBAL_TARGET = 26;
const GLOBAL_WEIGHT = 0.02;

/**
 * Assigns each polity a fill colour so that bordering polities are as easy to
 * tell apart as possible. Greedy placement (busiest borders first) is followed
 * by local search that reassigns colours, and swaps them between polities,
 * whenever that lowers a cost made of:
 *  - a heavy penalty for each border whose two colours are closer than
 *    `BORDER_TARGET`, weighted by the border's length;
 *  - a light penalty for any two colours closer than `GLOBAL_TARGET`.
 * Distance is perceptual (CIELAB) with lightness down-weighted, because fills
 * that differ only in lightness are the ones hardest to tell apart on a map.
 * Deterministic: the same input always gives the same colours.
 */
export function contrastingPolityColours(
  polityIds: string[], owner: Array<string | null>, cols: number, rows: number,
  options: { tone?: PolityTone } = {},
): Map<string, string> {
  const n = polityIds.length;
  const index = new Map(polityIds.map((id, i) => [id, i]));
  // Shared-edge counts between polities: a longer frontier needs more contrast.
  const border = Array.from({ length: n }, () => new Map<number, number>());
  const connect = (a: string | null, b: string | null) => {
    if (!a || !b || a === b) return;
    const i = index.get(a);
    const j = index.get(b);
    if (i === undefined || j === undefined) return;
    border[i]!.set(j, (border[i]!.get(j) ?? 0) + 1);
    border[j]!.set(i, (border[j]!.get(i) ?? 0) + 1);
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

  // Twice as many candidates as polities gives the search room to choose.
  const pool = candidatePolityColours(Math.max(2 * n, 24), options.tone ?? 'vivid');
  const labs = pool.map(toLab);
  const dist = (a: number, b: number) => {
    const [l1, a1, b1] = labs[a]!;
    const [l2, a2, b2] = labs[b]!;
    return Math.sqrt((0.7 * (l1 - l2)) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
  };
  const shortfall = (d: number, target: number) => (d < target ? (target - d) ** 2 : 0);

  const order = polityIds
    .map((_, i) => i)
    .sort((a, b) => {
      const weight = (i: number) => [...border[i]!.values()].reduce((x, y) => x + y, 0);
      return weight(b) - weight(a) || polityIds[a]!.localeCompare(polityIds[b]!);
    });

  // Greedy: the colour whose nearest bordering colour is farthest, then the one
  // that stands furthest from everything placed so far.
  const assigned: number[] = new Array(n).fill(-1);
  const used = new Set<number>();
  for (const i of order) {
    let best = -1;
    let bestScore = -Infinity;
    for (let c = 0; c < pool.length; c++) {
      if (used.has(c)) continue;
      let nearestBorder = Infinity;
      for (const j of border[i]!.keys()) if (assigned[j]! >= 0) nearestBorder = Math.min(nearestBorder, dist(c, assigned[j]!));
      let nearestAny = Infinity;
      for (const j of used) nearestAny = Math.min(nearestAny, dist(c, j));
      const score = Math.min(nearestBorder, 90) + 0.1 * Math.min(nearestAny, 90);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    assigned[i] = best;
    used.add(best);
  }

  // Cost of polity i wearing colour c, given everyone else's current colour.
  const costOf = (i: number, c: number, skip = -1) => {
    let cost = 0;
    for (const [j, length] of border[i]!) {
      if (j !== skip && assigned[j]! >= 0) cost += length * shortfall(dist(c, assigned[j]!), BORDER_TARGET);
    }
    for (let j = 0; j < n; j++) {
      if (j !== i && j !== skip) cost += GLOBAL_WEIGHT * shortfall(dist(c, assigned[j]!), GLOBAL_TARGET);
    }
    return cost;
  };
  for (let pass = 0; pass < 5; pass++) {
    let improved = false;
    for (const i of order) {
      const current = assigned[i]!;
      let bestColour = current;
      let bestCost = costOf(i, current);
      for (let c = 0; c < pool.length; c++) {
        if (used.has(c)) {
          // Swapping with its holder: both ends are costed with the other already moved.
          const holder = assigned.indexOf(c);
          if (holder < 0 || holder === i) continue;
          const before = costOf(i, current) + costOf(holder, c);
          assigned[i] = c;
          assigned[holder] = current;
          const after = costOf(i, c) + costOf(holder, current);
          assigned[i] = current;
          assigned[holder] = c;
          if (after < before - 1e-9) {
            assigned[i] = c;
            assigned[holder] = current;
            bestColour = c;
            bestCost = costOf(i, c);
            improved = true;
            break;
          }
          continue;
        }
        const cost = costOf(i, c);
        if (cost < bestCost - 1e-9) {
          bestCost = cost;
          bestColour = c;
        }
      }
      if (bestColour !== assigned[i]) {
        used.delete(assigned[i]!);
        used.add(bestColour);
        assigned[i] = bestColour;
        improved = true;
      }
    }
    if (!improved) break;
  }

  return new Map(polityIds.map((id, i) => [id, pool[assigned[i]!]!]));
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
