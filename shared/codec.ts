/**
 * Compact row-string encoding used to talk to the model.
 *
 * A 50x50 grid is 2,500 hexes. Sending that as an array of JSON objects costs
 * tens of thousands of output tokens and invites truncation; one string per row
 * costs a few hundred and, just as importantly, lets the model *see* the map as
 * an ASCII picture while it reasons about coastlines and mountain ranges.
 */

import {
  BASE_GEO_VALUES,
  CLIMATE_VALUES,
  ELEVATION_VALUES,
  VEGETATION_VALUES,
  type BaseGeo,
  type Climate,
  type Elevation,
  type Vegetation,
} from './types.js';

export interface DecodeResult<T> {
  data: T;
  warnings: string[];
}

/* ------------------------------------------------------------------ base */

export const BASE_CHARS: Record<BaseGeo, string> = {
  Land: 'L',
  Sea: '~',
  Lake: 'o',
  Ice: '#',
  Island: 'i',
};
const BASE_BY_CHAR = new Map<string, BaseGeo>(
  BASE_GEO_VALUES.map((v) => [BASE_CHARS[v], v]),
);

export const BASE_LEGEND = BASE_GEO_VALUES.map(
  (v) => `${BASE_CHARS[v]} = ${v}`,
).join(', ');

export function encodeBase(data: BaseGeo[], cols: number, rows: number): string[] {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) line += BASE_CHARS[data[r * cols + c] ?? 'Sea'];
    out.push(line);
  }
  return out;
}

export function decodeBase(
  lines: string[],
  cols: number,
  rows: number,
): DecodeResult<BaseGeo[]> {
  const warnings: string[] = [];
  const data: BaseGeo[] = new Array(cols * rows).fill('Sea');
  if (lines.length !== rows) {
    warnings.push(
      `Expected ${rows} rows, model returned ${lines.length}; missing rows filled with Sea.`,
    );
  }
  let badChars = 0;
  for (let r = 0; r < rows; r++) {
    const line = (lines[r] ?? '').replace(/\s+/g, '');
    if (lines[r] !== undefined && line.length !== cols) {
      warnings.push(
        `Row ${r} had ${line.length} cells, expected ${cols}; padded or truncated.`,
      );
    }
    for (let c = 0; c < cols; c++) {
      const ch = line[c];
      const val = ch === undefined ? undefined : BASE_BY_CHAR.get(ch);
      if (val) data[r * cols + c] = val;
      else if (ch !== undefined) badChars++;
    }
  }
  if (badChars > 0) {
    warnings.push(`${badChars} unrecognised base-geography characters defaulted to Sea.`);
  }
  return { data, warnings };
}

/* ------------------------------------------------------- elevation (chars) */

export const ELEVATION_CHARS: Record<Elevation, string> = {
  Lowland: 'l',
  Rolling: 'r',
  Hills: 'h',
  Highland: 'H',
  Mountains: 'M',
  Plateau: 'P',
};
const ELEVATION_BY_CHAR = new Map<string, Elevation>(
  ELEVATION_VALUES.map((v) => [ELEVATION_CHARS[v], v]),
);
export const ELEVATION_LEGEND =
  ELEVATION_VALUES.map((v) => `${ELEVATION_CHARS[v]} = ${v}`).join(', ') +
  ', . = no value (water / ice hex)';

export function encodeElevation(
  data: (Elevation | null)[],
  cols: number,
  rows: number,
): string[] {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const v = data[r * cols + c];
      line += v ? ELEVATION_CHARS[v] : '.';
    }
    out.push(line);
  }
  return out;
}

export function decodeElevation(
  lines: string[],
  cols: number,
  rows: number,
): DecodeResult<(Elevation | null)[]> {
  const warnings: string[] = [];
  const data: (Elevation | null)[] = new Array(cols * rows).fill(null);
  if (lines.length !== rows) {
    warnings.push(`Expected ${rows} rows, model returned ${lines.length}.`);
  }
  let bad = 0;
  for (let r = 0; r < rows; r++) {
    const line = (lines[r] ?? '').replace(/\s+/g, '');
    for (let c = 0; c < cols; c++) {
      const ch = line[c];
      if (ch === undefined || ch === '.') continue;
      const v = ELEVATION_BY_CHAR.get(ch);
      if (v) data[r * cols + c] = v;
      else bad++;
    }
  }
  if (bad > 0) warnings.push(`${bad} unrecognised elevation characters left empty.`);
  return { data, warnings };
}

/* ------------------------------------------------- token-per-hex row codec */

function encodeTokens(
  data: (string | null)[],
  cols: number,
  rows: number,
  empty: string,
): string[] {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) cells.push(data[r * cols + c] ?? empty);
    out.push(cells.join(' '));
  }
  return out;
}

function decodeTokens<T extends string>(
  lines: string[],
  cols: number,
  rows: number,
  empty: string,
  lookup: (token: string) => T | undefined,
  label: string,
): DecodeResult<(T | null)[]> {
  const warnings: string[] = [];
  const data: (T | null)[] = new Array(cols * rows).fill(null);
  if (lines.length !== rows) {
    warnings.push(`Expected ${rows} rows of ${label}, model returned ${lines.length}.`);
  }
  let bad = 0;
  for (let r = 0; r < rows; r++) {
    const raw = lines[r];
    if (raw === undefined) continue;
    const cells = raw.trim().split(/\s+/).filter((s) => s.length > 0);
    if (cells.length !== cols) {
      warnings.push(
        `Row ${r} of ${label} had ${cells.length} cells, expected ${cols}.`,
      );
    }
    for (let c = 0; c < cols; c++) {
      const tok = cells[c];
      if (tok === undefined || tok === empty) continue;
      const v = lookup(tok);
      if (v) data[r * cols + c] = v;
      else bad++;
    }
  }
  if (bad > 0) warnings.push(`${bad} unrecognised ${label} values left empty.`);
  return { data, warnings };
}

/* --------------------------------------------------------------- climate */

const CLIMATE_SET = new Set<string>(CLIMATE_VALUES);
export const CLIMATE_EMPTY = '--';
export const CLIMATE_LEGEND =
  CLIMATE_VALUES.join(' ') + `, plus ${CLIMATE_EMPTY} for no value (water / ice hex)`;

export const encodeClimate = (d: (Climate | null)[], cols: number, rows: number) =>
  encodeTokens(d, cols, rows, CLIMATE_EMPTY);

export const decodeClimate = (lines: string[], cols: number, rows: number) =>
  decodeTokens<Climate>(
    lines,
    cols,
    rows,
    CLIMATE_EMPTY,
    (t) => (CLIMATE_SET.has(t) ? (t as Climate) : undefined),
    'climate',
  );

/* ------------------------------------------------------------ vegetation */

export const VEGETATION_CODES: Record<Vegetation, string> = {
  'Barren Desert': 'BD',
  Scrubland: 'SC',
  Wetland: 'WL',
  Tundra: 'TU',
  Steppe: 'ST',
  Prairie: 'PR',
  Savanna: 'SV',
  Veld: 'VE',
  'Boreal Forest': 'BF',
  'Coniferous Forest': 'CF',
  'Deciduous Forest': 'DF',
  'Tropical Rainforest': 'TR',
  'Subtropical Rainforest': 'SR',
  'Flood Plain': 'FP',
  Breadbasket: 'BB',
  'Black Earth': 'BE',
  Assart: 'AS',
  'Paddy Fields': 'PF',
  'Desert Oasis': 'DO',
};
const VEGETATION_BY_CODE = new Map<string, Vegetation>(
  VEGETATION_VALUES.map((v) => [VEGETATION_CODES[v], v]),
);
export const VEGETATION_EMPTY = '--';

export const encodeVegetation = (d: (Vegetation | null)[], cols: number, rows: number) =>
  encodeTokens(
    d.map((v) => (v ? VEGETATION_CODES[v] : null)),
    cols,
    rows,
    VEGETATION_EMPTY,
  );

export const decodeVegetation = (lines: string[], cols: number, rows: number) =>
  decodeTokens<Vegetation>(
    lines,
    cols,
    rows,
    VEGETATION_EMPTY,
    (t) => VEGETATION_BY_CODE.get(t),
    'vegetation',
  );

/* ------------------------------------------------------------ population */

export const POPULATION_EMPTY = '-';

export function encodePopulation(
  data: (number | null)[],
  cols: number,
  rows: number,
): string[] {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      const v = data[r * cols + c];
      cells.push(v === null || v === undefined ? POPULATION_EMPTY : String(Math.round(v)));
    }
    out.push(cells.join(' '));
  }
  return out;
}

export function decodePopulation(
  lines: string[],
  cols: number,
  rows: number,
): DecodeResult<(number | null)[]> {
  const warnings: string[] = [];
  const data: (number | null)[] = new Array(cols * rows).fill(null);
  if (lines.length !== rows) {
    warnings.push(`Expected ${rows} rows of population, model returned ${lines.length}.`);
  }
  let bad = 0;
  let negative = 0;
  for (let r = 0; r < rows; r++) {
    const raw = lines[r];
    if (raw === undefined) continue;
    const cells = raw.trim().split(/\s+/).filter((s) => s.length > 0);
    if (cells.length !== cols) {
      warnings.push(`Row ${r} of population had ${cells.length} cells, expected ${cols}.`);
    }
    for (let c = 0; c < cols; c++) {
      const tok = cells[c];
      if (tok === undefined || tok === POPULATION_EMPTY) continue;
      const n = Number(tok.replace(/[_,]/g, ''));
      if (!Number.isFinite(n)) {
        bad++;
        continue;
      }
      if (n < 0) {
        negative++;
        data[r * cols + c] = 0;
      } else {
        data[r * cols + c] = Math.round(n);
      }
    }
  }
  if (bad > 0) warnings.push(`${bad} unparseable population values left empty.`);
  if (negative > 0) warnings.push(`${negative} negative population values clamped to 0.`);
  return { data, warnings };
}

/* -------------------------------------------------------------- polities */

/** Keys the model uses to paint polity ownership; '.' means unclaimed. */
export const POLITY_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const POLITY_UNCLAIMED = '.';

export function encodePolityRows(
  owner: (string | null)[],
  keyOf: Map<string, string>,
  cols: number,
  rows: number,
): string[] {
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const id = owner[r * cols + c];
      line += id ? (keyOf.get(id) ?? POLITY_UNCLAIMED) : POLITY_UNCLAIMED;
    }
    out.push(line);
  }
  return out;
}
