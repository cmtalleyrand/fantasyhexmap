/**
 * Post-generation validation and repair.
 *
 * Two different jobs live here and they are deliberately kept apart:
 *   - REPAIR: silently fix data that would be structurally invalid (elevation on
 *     a sea hex, two polities claiming the same hex) and note what was fixed.
 *   - FLAG: report coherence problems (a rainforest in a desert climate, a river
 *     running uphill) as warnings without changing anything. These are judgement
 *     calls and the user may have made them on purpose.
 */

import { edgeBetween, hexIndex, inBounds, neighbourOf } from './hex.js';
import {
  ELEVATION_FLOW_RANK,
  edgesToOffMap,
  isLandLike,
  isWater,
  recomputeCityFacts,
  waterEdgesOf,
} from './derive.js';
import type {
  BaseData,
  City,
  Climate,
  ClimateData,
  Elevation,
  ElevationData,
  Polity,
  PolitiesData,
  PopulationData,
  River,
  RiverSegment,
  Vegetation,
  VegetationData,
} from './types.js';

export interface Repaired<T> {
  data: T;
  warnings: string[];
}

const MAX_LISTED = 6;

function summarise(warnings: string[], items: string[], template: (n: number) => string) {
  if (items.length === 0) return;
  const shown = items.slice(0, MAX_LISTED).join(', ');
  warnings.push(
    template(items.length) +
      ` (${shown}${items.length > MAX_LISTED ? `, +${items.length - MAX_LISTED} more` : ''})`,
  );
}

const at = (cols: number, i: number) => `${i % cols},${Math.floor(i / cols)}`;

/* --------------------------------------------------- land-only per-hex data */

function repairLandOnly<T>(
  data: (T | null)[],
  base: BaseData,
  cols: number,
  rows: number,
  label: string,
  fillMissing: (index: number) => T | null,
): Repaired<(T | null)[]> {
  const warnings: string[] = [];
  const out: (T | null)[] = new Array(cols * rows).fill(null);
  const strays: string[] = [];
  const gaps: string[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const land = isLandLike(base[i]);
    const v = data[i] ?? null;
    if (!land) {
      if (v !== null) strays.push(at(cols, i));
      out[i] = null;
      continue;
    }
    if (v === null) {
      const filled = fillMissing(i);
      out[i] = filled;
      if (filled !== null) gaps.push(at(cols, i));
    } else {
      out[i] = v;
    }
  }
  summarise(warnings, strays, (n) => `Dropped ${label} from ${n} non-land hexes`);
  summarise(warnings, gaps, (n) => `Filled ${n} land hexes that had no ${label}`);
  return { data: out, warnings };
}

export function validateElevation(
  data: ElevationData,
  base: BaseData,
  cols: number,
  rows: number,
): Repaired<ElevationData> {
  // Missing values (and the small landmass inside an Island hex) default to Lowland.
  return repairLandOnly<Elevation>(data, base, cols, rows, 'elevation', () => 'Lowland');
}

export function validateClimate(
  data: ClimateData,
  base: BaseData,
  elevation: ElevationData | null,
  cols: number,
  rows: number,
): Repaired<ClimateData> {
  const repaired = repairLandOnly<Climate>(data, base, cols, rows, 'climate', () => null);
  const warnings = [...repaired.warnings];
  const missing = repaired.data.filter((v, i) => v === null && isLandLike(base[i])).length;
  if (missing > 0) warnings.push(`${missing} land hexes have no climate value.`);

  if (elevation) {
    const odd: string[] = [];
    for (let i = 0; i < cols * rows; i++) {
      const c = repaired.data[i];
      const e = elevation[i];
      if (!c || !e) continue;
      // Alpine hexes in a tropical climate are possible but usually a mistake.
      if (e === 'Mountains' && (c === 'Af' || c === 'Am')) odd.push(at(cols, i));
    }
    summarise(
      warnings,
      odd,
      (n) => `${n} Mountains hexes carry a lowland-tropical climate (Af/Am)`,
    );
  }
  return { data: repaired.data, warnings };
}

/* ---------------------------------------------------- vegetation coherence */

const C_OR_D = (c: Climate) => c.startsWith('C') || c.startsWith('D');
const DECIDUOUS_CAPABLE: Climate[] = [
  'Cfa', 'Cfb', 'Cwa', 'Csa', 'Csb', 'Dfa', 'Dfb', 'Dwa', 'Dwb',
];

interface VegRule {
  climateOk?: (c: Climate) => boolean;
  elevationOk?: (e: Elevation) => boolean;
  message: string;
}

const VEG_RULES: Partial<Record<Vegetation, VegRule>> = {
  Breadbasket: {
    climateOk: C_OR_D,
    elevationOk: (e) => e === 'Lowland' || e === 'Rolling',
    message: 'Breadbasket belongs in temperate/continental climates at Lowland-to-Rolling elevation',
  },
  'Black Earth': {
    climateOk: C_OR_D,
    elevationOk: (e) => e === 'Lowland' || e === 'Rolling',
    message: 'Black Earth belongs in temperate/continental climates at Lowland-to-Rolling elevation',
  },
  Assart: {
    climateOk: (c) => DECIDUOUS_CAPABLE.includes(c),
    message: 'Assart requires a climate that would otherwise support Deciduous Forest',
  },
  'Paddy Fields': {
    climateOk: (c) => c.startsWith('A') || ['Cfa', 'Cwa', 'Cfb', 'Dwa'].includes(c),
    message: 'Paddy Fields require a wet climate',
  },
  'Desert Oasis': {
    climateOk: (c) => c.startsWith('B'),
    message: 'Desert Oasis requires a B-group arid climate',
  },
  'Barren Desert': {
    climateOk: (c) => c.startsWith('B') || c === 'EF',
    message: 'Barren Desert expects a B-group arid climate',
  },
  'Tropical Rainforest': {
    climateOk: (c) => c === 'Af' || c === 'Am',
    message: 'Tropical Rainforest expects an Af/Am climate',
  },
  'Subtropical Rainforest': {
    climateOk: (c) => ['Cfa', 'Cwa', 'Cfb', 'Am'].includes(c),
    message: 'Subtropical Rainforest expects a humid subtropical climate',
  },
  Savanna: {
    climateOk: (c) => c === 'Aw' || c === 'BSh',
    message: 'Savanna expects an Aw or BSh climate',
  },
  'Boreal Forest': {
    climateOk: (c) => ['Dfc', 'Dfb', 'Dwb', 'ET'].includes(c),
    message: 'Boreal Forest expects a subarctic climate',
  },
  Tundra: {
    climateOk: (c) => c.startsWith('E') || c === 'Dfc',
    message: 'Tundra expects a polar or subarctic climate',
  },
};

export function validateVegetation(
  data: VegetationData,
  base: BaseData,
  climate: ClimateData | null,
  elevation: ElevationData | null,
  rivers: River[] | null,
  cols: number,
  rows: number,
): Repaired<VegetationData> {
  const repaired = repairLandOnly<Vegetation>(data, base, cols, rows, 'vegetation', () => null);
  const warnings = [...repaired.warnings];

  const byRule = new Map<string, string[]>();
  const push = (msg: string, where: string) => {
    const list = byRule.get(msg) ?? [];
    list.push(where);
    byRule.set(msg, list);
  };

  const riverHexes = new Set<string>();
  if (rivers) {
    for (const r of rivers) for (const s of r.segments) riverHexes.add(`${s.col},${s.row}`);
  }

  for (let i = 0; i < cols * rows; i++) {
    const v = repaired.data[i];
    if (!v) continue;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const where = `${col},${row}`;
    const rule = VEG_RULES[v];
    const c = climate ? climate[i] : null;
    const e = elevation ? elevation[i] : null;
    if (rule) {
      if (rule.climateOk && c && !rule.climateOk(c)) push(`${rule.message} - found in ${c}`, where);
      if (rule.elevationOk && e && !rule.elevationOk(e)) push(`${rule.message} - found on ${e}`, where);
    }
    if (c && (c === 'ET' || c === 'EF') && v !== 'Tundra' && v !== 'Barren Desert') {
      push(`Polar climate (${c}) should trend toward Tundra`, where);
    }
    if (c === 'Af' && v === 'Barren Desert') {
      push('Barren Desert in an Af tropical climate', where);
    }
    if ((v === 'Flood Plain' || v === 'Paddy Fields') && rivers) {
      const adjacent =
        riverHexes.has(where) ||
        [0, 1, 2, 3, 4, 5].some((edge) => {
          const n = neighbourOf(col, row, edge);
          return inBounds(cols, rows, n.col, n.row) && riverHexes.has(`${n.col},${n.row}`);
        });
      if (!adjacent) push(`${v} is not on or beside a river`, where);
    }
  }

  for (const [msg, list] of byRule) {
    summarise(warnings, list, (n) => `${msg}: ${n} hex${n === 1 ? '' : 'es'}`);
  }
  return { data: repaired.data, warnings };
}

/* ------------------------------------------------------------------ rivers */

export interface RiverPathInput {
  name: string;
  path: { col: number; row: number }[];
  navigable?: boolean[];
}

/**
 * Turn a model-supplied hex path into edge-addressed segments.
 *
 * We derive every edge ourselves from consecutive hexes rather than trusting the
 * model to keep entry/exit edges consistent - the shared edge between two
 * adjacent hexes is uniquely determined, so there is nothing to guess.
 */
export function buildRiverFromPath(
  input: RiverPathInput,
  id: string,
  base: BaseData,
  elevation: ElevationData | null,
  cols: number,
  rows: number,
  warnings: string[],
): River | null {
  const raw = input.path.filter((p) => inBounds(cols, rows, p.col, p.row));
  if (raw.length !== input.path.length) {
    warnings.push(`River "${input.name}": dropped ${input.path.length - raw.length} off-map path hexes.`);
  }
  if (raw.length === 0) {
    warnings.push(`River "${input.name}" had no usable path and was discarded.`);
    return null;
  }

  // Truncate at the first break in adjacency rather than inventing a crossing.
  const path = [raw[0]!];
  for (let i = 1; i < raw.length; i++) {
    const prev = path[path.length - 1]!;
    const cur = raw[i]!;
    if (prev.col === cur.col && prev.row === cur.row) continue;
    if (edgeBetween(prev, cur) === -1) {
      warnings.push(
        `River "${input.name}": path jumps from ${prev.col},${prev.row} to ${cur.col},${cur.row}; truncated there.`,
      );
      break;
    }
    path.push(cur);
  }

  // A trailing water hex is the mouth, not a traversed hex.
  let terminus: River['terminus'] = 'Unresolved';
  let mouth: { col: number; row: number } | null = null;
  while (path.length > 1 && isWater(base[hexIndex(cols, path[path.length - 1]!.col, path[path.length - 1]!.row)])) {
    const last = path.pop()!;
    mouth = last;
    terminus = base[hexIndex(cols, last.col, last.row)] === 'Lake' ? 'Lake' : 'Sea';
  }
  if (path.length === 0) {
    warnings.push(`River "${input.name}" ran entirely through water and was discarded.`);
    return null;
  }

  const segments: RiverSegment[] = [];
  for (let i = 0; i < path.length; i++) {
    const hex = path[i]!;
    const prev = i > 0 ? path[i - 1]! : null;
    const next = i + 1 < path.length ? path[i + 1]! : null;
    const entryEdge = prev ? edgeBetween(hex, prev) : null;
    let exitEdge = next ? edgeBetween(hex, next) : null;
    if (exitEdge === null) {
      // Last land hex: leave through the mouth, or over the map edge.
      if (mouth) exitEdge = edgeBetween(hex, mouth);
      if (exitEdge === null || exitEdge === -1) {
        const water = waterEdgesOf(base, cols, rows, hex.col, hex.row);
        if (water.length > 0) {
          exitEdge = water[0]!;
          terminus = base[hexIndex(cols, neighbourOf(hex.col, hex.row, water[0]!).col, neighbourOf(hex.col, hex.row, water[0]!).row)] === 'Lake' ? 'Lake' : 'Sea';
        } else {
          const off = edgesToOffMap(cols, rows, hex.col, hex.row);
          if (off.length > 0) {
            exitEdge = off[0]!;
            terminus = 'OffMap';
          } else {
            warnings.push(
              `River "${input.name}" ends at ${hex.col},${hex.row}, which touches neither water nor the map edge.`,
            );
            terminus = 'Unresolved';
          }
        }
      }
    }
    const navigable = input.navigable?.[i] ?? false;
    segments.push({
      col: hex.col,
      row: hex.row,
      entryEdge: entryEdge === -1 ? null : entryEdge,
      exitEdge: exitEdge === -1 ? null : exitEdge,
      navigable,
    });
  }

  if (elevation) flagUphill(input.name, segments, elevation, cols, warnings);
  return { id, name: input.name.trim() || 'Unnamed river', segments, terminus };
}

/** Flag, don't block: a segment whose next hex is higher ground. */
function flagUphill(
  name: string,
  segments: RiverSegment[],
  elevation: ElevationData,
  cols: number,
  warnings: string[],
) {
  const bad: string[] = [];
  for (let i = 0; i + 1 < segments.length; i++) {
    const a = elevation[hexIndex(cols, segments[i]!.col, segments[i]!.row)];
    const b = elevation[hexIndex(cols, segments[i + 1]!.col, segments[i + 1]!.row)];
    if (!a || !b) continue;
    if (ELEVATION_FLOW_RANK[b] > ELEVATION_FLOW_RANK[a]) {
      bad.push(`${segments[i]!.col},${segments[i]!.row}->${segments[i + 1]!.col},${segments[i + 1]!.row} (${a}->${b})`);
    }
  }
  summarise(
    warnings,
    bad,
    (n) =>
      `River "${name}" appears to run uphill on ${n} segment${n === 1 ? '' : 's'} (Plateau ranked with Highland for this check)`,
  );
}

export function validateRivers(
  rivers: River[],
  base: BaseData,
  cols: number,
  rows: number,
): Repaired<River[]> {
  const warnings: string[] = [];
  const out: River[] = [];
  const overWater: string[] = [];
  for (const r of rivers) {
    const segs = r.segments.filter((s) => inBounds(cols, rows, s.col, s.row));
    for (const s of segs) {
      if (isWater(base[hexIndex(cols, s.col, s.row)])) overWater.push(`${s.col},${s.row}`);
    }
    if (segs.length === 0) {
      warnings.push(`River "${r.name}" had no on-map segments and was dropped.`);
      continue;
    }
    out.push({ ...r, segments: segs });
  }
  summarise(warnings, overWater, (n) => `${n} river segments run across water hexes`);
  return { data: out, warnings };
}

/* ------------------------------------------------------------------ cities */

export function validateCities(
  cities: City[],
  base: BaseData,
  rivers: River[] | null,
  cols: number,
  rows: number,
): Repaired<City[]> {
  const warnings: string[] = [];
  const out: City[] = [];
  const offLand: string[] = [];
  const seen = new Set<string>();
  for (const c of cities) {
    if (!inBounds(cols, rows, c.col, c.row)) {
      warnings.push(`City "${c.name}" at ${c.col},${c.row} is off the map and was dropped.`);
      continue;
    }
    if (!isLandLike(base[hexIndex(cols, c.col, c.row)])) {
      offLand.push(`${c.name} @ ${c.col},${c.row}`);
      continue;
    }
    let id = c.id;
    while (seen.has(id)) id = `${id}_`;
    seen.add(id);
    out.push(
      recomputeCityFacts(
        { ...c, id, population: Math.max(0, Math.round(c.population || 0)) },
        base,
        cols,
        rows,
        rivers,
      ),
    );
  }
  summarise(warnings, offLand, (n) => `Dropped ${n} cities placed on water or ice`);
  return { data: out, warnings };
}

/* ---------------------------------------------------------------- polities */

/** Enforce the strict partition: land hexes get at most one owner, water none. */
export function validatePolities(
  polities: Polity[],
  owner: (string | null)[],
  base: BaseData,
  cols: number,
  rows: number,
): Repaired<PolitiesData> {
  const warnings: string[] = [];
  const known = new Set(polities.map((p) => p.id));
  const out: (string | null)[] = new Array(cols * rows).fill(null);
  const onWater: string[] = [];
  let unknownRefs = 0;
  for (let i = 0; i < cols * rows; i++) {
    const id = owner[i] ?? null;
    if (!id) continue;
    if (!known.has(id)) {
      unknownRefs++;
      continue;
    }
    if (!isLandLike(base[i])) {
      onWater.push(at(cols, i));
      continue;
    }
    out[i] = id;
  }
  summarise(warnings, onWater, (n) => `Cleared polity claims from ${n} non-land hexes`);
  if (unknownRefs > 0) {
    warnings.push(`${unknownRefs} hexes referenced a polity that was not declared; left unclaimed.`);
  }
  const used = new Set(out.filter((v): v is string => v !== null));
  const empty = polities.filter((p) => !used.has(p.id));
  if (empty.length > 0) {
    warnings.push(`${empty.length} polities own no hexes: ${empty.map((p) => p.name).join(', ')}.`);
  }
  return { data: { polities, owner: out }, warnings };
}

/* -------------------------------------------------------------- population */

export function validatePopulation(
  data: PopulationData,
  base: BaseData,
  cols: number,
  rows: number,
): Repaired<PopulationData> {
  const repaired = repairLandOnly<number>(data, base, cols, rows, 'population', () => 0);
  return { data: repaired.data, warnings: repaired.warnings };
}
