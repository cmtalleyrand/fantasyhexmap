/**
 * Zod schemas for every structured response we ask the model for.
 *
 * Each factory builds one of two forms of the same response:
 *
 *  - `grid: 'keyed'` is what the API is given. Every grid row and every cell is
 *    a required property with an enumerated value, which constrained decoding
 *    does enforce - so the grid comes back exactly `cols` x `rows`, every time.
 *  - `grid: 'rows'` (the default) is what the webchat path describes and what
 *    the decoders read: one string per row. Nothing enforces its size, so
 *    `checkResponse` below accepts a miscount as a warning for the decoders to
 *    repair rather than a reason to discard the layer. Name lists are optional
 *    here, so a pasted reply that leaves them out still imports.
 *
 * The pipeline flattens a keyed grid into row strings straight after parsing
 * (see `core/grid.ts`), so everything downstream sees one shape. That is why
 * the response types below describe the rows form.
 *
 * Everything here depends on zod and nothing else, so the browser can validate
 * a pasted response without downloading the Anthropic SDK.
 */

import * as z from 'zod/v4';

import { BASE_CHARS, CLIMATE_EMPTY, ELEVATION_CHARS, POLITY_UNCLAIMED, VEGETATION_CODES, VEGETATION_EMPTY } from '../shared/codec.js';
import { GEO_NAME_KINDS } from '../shared/geoNames.js';
import { BASE_GEO_VALUES, CLIMATE_VALUES, ELEVATION_VALUES, VEGETATION_VALUES, type GeoNameKind } from '../shared/types.js';
import { keyedGrid } from './grid.js';

export interface SchemaOptions {
  /** 'keyed' for the API, where the grammar enforces the grid; 'rows' otherwise. */
  grid?: 'rows' | 'keyed';
  /** The roster keys a polity paint pass may use; narrows its cells to those. */
  polityKeys?: string[];
}

const keyed = (opts: SchemaOptions) => opts.grid === 'keyed';

/**
 * Names for places. A name covers a set of hexes, given as runs along rows
 * because a sea or a range is far shorter to write that way than hex by hex.
 */
const nameSpans = z
  .array(
    z.object({
      row: z.number().int(),
      from: z.number().int(),
      to: z.number().int(),
    }),
  )
  .describe(
    'The hexes the name covers, as runs along rows: every hex in row `row` from column `from` to column `to` inclusive. Use as few runs as the shape needs.',
  );

const nameList = <T extends z.ZodType>(opts: SchemaOptions, entry: T, description: string) =>
  keyed(opts) ? z.array(entry).describe(description) : z.array(entry).optional().describe(description);

/**
 * A grid field. In rows form, one string per row; in keyed form, the enforced
 * object the pipeline flattens back into those strings before anything reads
 * it - hence the cast, which describes the value as the rest of the code sees it.
 */
function gridField(
  cols: number,
  rows: number,
  opts: SchemaOptions,
  kind: 'char' | 'token',
  cell: z.ZodType,
  what: string,
): z.ZodType<string[]> {
  if (keyed(opts)) return keyedGrid(cols, rows, cell, what) as unknown as z.ZodType<string[]>;
  return kind === 'char'
    ? z
        .array(z.string().length(cols))
        .length(rows)
        .describe(
          `Exactly ${rows} strings, north to south; each exactly ${cols} characters, one ${what} per hex, west to east.`,
        )
    : z
        .array(z.string())
        .length(rows)
        .describe(
          `Exactly ${rows} strings, north to south; each holds exactly ${cols} space-separated ${what}s, one per hex, west to east.`,
        );
}

const enumOf = (values: string[]) => z.enum(values as [string, ...string[]]);

const BASE_CELL = enumOf(BASE_GEO_VALUES.map((v) => BASE_CHARS[v]));
const ELEVATION_CELL = enumOf([...ELEVATION_VALUES.map((v) => ELEVATION_CHARS[v]), '.']);
const CLIMATE_CELL = enumOf([...CLIMATE_VALUES, CLIMATE_EMPTY]);
const VEGETATION_CELL = enumOf([...VEGETATION_VALUES.map((v) => VEGETATION_CODES[v]), VEGETATION_EMPTY]);
const POPULATION_CELL = z.number().int();

function polityCell(opts: SchemaOptions): z.ZodType {
  const keys = (opts.polityKeys ?? []).filter((k) => k && k !== POLITY_UNCLAIMED);
  return keys.length > 0 ? enumOf([...new Set(keys), POLITY_UNCLAIMED]) : z.string();
}

export const BaseResponse = (cols: number, rows: number, opts: SchemaOptions = {}) =>
  z.object({
    rows: gridField(cols, rows, opts, 'char', BASE_CELL, 'base-geography character'),
    names: nameList(
      opts,
      z.object({
        kind: z.enum(GEO_NAME_KINDS as [GeoNameKind, ...GeoNameKind[]]),
        name: z.string(),
        previousName: z.string().optional().describe('For a rename only, the exact existing name.'),
        spans: nameSpans,
      }),
      'Names for seas, lakes, islands and land regions, one entry per named place. Empty when nothing is named.',
    ),
  });
export type BaseResponse = z.infer<ReturnType<typeof BaseResponse>>;

export const ElevationResponse = (cols: number, rows: number, opts: SchemaOptions = {}) =>
  z.object({
    rows: gridField(cols, rows, opts, 'char', ELEVATION_CELL, 'elevation character'),
    ranges: nameList(
      opts,
      z.object({
        name: z.string(),
        previousName: z.string().optional().describe('For a rename only, the exact existing name.'),
        spans: nameSpans,
      }),
      'Names for mountain ranges and upland massifs, one entry per range, covering its Mountains and Highland hexes. Empty when nothing is named.',
    ),
  });
export type ElevationResponse = z.infer<ReturnType<typeof ElevationResponse>>;

export const ClimateResponse = (cols: number, rows: number, opts: SchemaOptions = {}) =>
  z.object({
    rows: gridField(cols, rows, opts, 'token', CLIMATE_CELL, 'Köppen code'),
  });
export type ClimateResponse = z.infer<ReturnType<typeof ClimateResponse>>;

export const VegetationResponse = (cols: number, rows: number, opts: SchemaOptions = {}) =>
  z.object({
    rows: gridField(cols, rows, opts, 'token', VEGETATION_CELL, 'two-letter vegetation code'),
  });
export type VegetationResponse = z.infer<ReturnType<typeof VegetationResponse>>;

export const PopulationResponse = (cols: number, rows: number, opts: SchemaOptions = {}) =>
  z.object({
    rows: gridField(
      cols,
      rows,
      opts,
      'token',
      POPULATION_CELL,
      keyed(opts) ? 'integer (0 for water)' : 'integer ("-" for water)',
    ),
  });
export type PopulationResponse = z.infer<ReturnType<typeof PopulationResponse>>;

/* ------------------------------------------------------------------ rivers */

const riverPath = z
  .array(z.object({ col: z.number().int(), row: z.number().int() }))
  .describe(
    'Ordered source-to-mouth list of adjacent hexes. Every consecutive pair must share an edge. Start with the Lake hex the river flows out of, if it rises in a lake. End with the Sea or Lake hex the river empties into, with the hex where it joins the river named in `joins`, or with the border hex it leaves the map through.',
  );

const riverLinks = {
  joins: z
    .string()
    .optional()
    .describe('A tributary: the name of the river it flows into. Its path ends on a hex of that river.'),
  branchOf: z
    .string()
    .optional()
    .describe('A distributary (a delta arm): the name of the river it splits from. Its path starts on a hex of that river. A distributary needs no name of its own: leave its `name` empty unless the brief names it.'),
};

const riverNavigable = z
  .array(z.boolean())
  .describe('One entry per hex in path: is the river navigable through that hex?');

export const RiversResponse = () =>
  z.object({
    rivers: z.array(z.object({ name: z.string(), previousName: z.string().optional().describe('For a rename only, the exact existing river name.'), path: riverPath, navigable: riverNavigable, ...riverLinks })),
  });
export type RiversResponse = z.infer<ReturnType<typeof RiversResponse>>;

/**
 * Rivers, first pass: what the rivers are, before any hex is committed to.
 *
 * `course` carries just enough for the second pass to draw the geometry without
 * re-deciding the hydrology from scratch.
 */
export const RiversRosterResponse = () =>
  z.object({
    rivers: z.array(
      z.object({
        name: z.string(),
        previousName: z.string().optional().describe('For a rename only, the exact existing river name.'),
        course: z
          .string()
          .describe(
            'One or two clauses: where it rises, roughly where it runs (by rows and columns if that helps), what it empties into, and any length the brief gives it.',
          ),
      }),
    ),
  });
export type RiversRosterResponse = z.infer<ReturnType<typeof RiversRosterResponse>>;

/** Rivers, second pass: the hex geometry for an already-named set of rivers. */
export const RiversPathsResponse = () =>
  z.object({
    rivers: z.array(z.object({ name: z.string(), previousName: z.string().optional().describe('For a rename only, the exact existing river name.'), path: riverPath, navigable: riverNavigable, ...riverLinks })),
  });
export type RiversPathsResponse = z.infer<ReturnType<typeof RiversPathsResponse>>;

/* ------------------------------------------------------------------ cities */

export const CitiesResponse = () =>
  z.object({
    cities: z.array(
      z.object({
        name: z.string(),
        previousName: z.string().optional().describe('For a rename only, the exact existing city name.'),
        col: z.number().int(),
        row: z.number().int(),
        population: z.number().int().min(0),
        capital: z
          .boolean()
          .optional()
          .describe('True for the seat of a realm or kingdom the brief names; omit for every other settlement.'),
      }),
    ),
  });
export type CitiesResponse = z.infer<ReturnType<typeof CitiesResponse>>;

/* ---------------------------------------------------------------- polities */

/**
 * A polity as declared. `hexes` is the size it is meant to have, which is what
 * lets a stated area survive from the roster pass - where the brief is read -
 * to the paint pass that draws the borders, and lets the result be checked.
 */
const polityEntry = (opts: SchemaOptions) =>
  z.object({
    key: z.string().length(1).describe('The single character used for this polity in the grid.'),
    name: z.string(),
    previousName: z.string().optional().describe('For a rename only, the exact existing polity name; preserve existing keys on edits.'),
    shortName: z.string().optional().describe('A short map label without generic polity-type wording.'),
    parent: z.string().optional().describe('Name of the larger polity this one is part of, if any.'),
    colour: z.string().describe('Hex colour such as #a33b2e.'),
    hexes: (keyed(opts) ? z.number().int() : z.number().int().optional()).describe(
      'Approximate count of directly held hexes, accounting for effective land fractions. Zero for a pure umbrella parent. Small polities may exceed stated area at whole-hex resolution.',
    ),
  });

/** Additional ownership only where exclusive allocation causes a material contradiction. */
const sharedHexes = z.array(z.object({
  col: z.number().int(), row: z.number().int(),
  with: z.string().length(1).nullable().describe('Second polity key, or null to clear existing sharing.'),
  share: z.literal(0.5),
})).optional().describe('Normally empty. Exceptional 50/50 allocations, not area-only adjustments. Existing manual shares are retained unless explicitly changed or their primary owner changes.');

export const PolitiesResponse = (cols: number, rows: number, opts: SchemaOptions = {}) =>
  z.object({
    polities: z.array(polityEntry(opts)),
    rows: gridField(cols, rows, opts, 'char', polityCell(opts), 'polity key'),
    sharedHexes,
  });
export type PolitiesResponse = z.infer<ReturnType<typeof PolitiesResponse>>;

/**
 * Polities, first pass: who exists, before any border is drawn.
 *
 * Splitting this off is the single biggest saving available. Deciding the roster
 * and partitioning 900 hexes are mutually constraining problems, and asking for
 * both at once is what made this layer spend its whole budget on reasoning.
 */
export const PolitiesRosterResponse = (_cols: number, _rows: number, opts: SchemaOptions = {}) =>
  z.object({
    polities: z.array(polityEntry(opts)),
  });
export type PolitiesRosterResponse = z.infer<ReturnType<typeof PolitiesRosterResponse>>;

/** Polities, second pass: the partition, against a roster that is already fixed. */
export const PolitiesPaintResponse = (cols: number, rows: number, opts: SchemaOptions = {}) =>
  z.object({
    rows: gridField(cols, rows, opts, 'char', polityCell(opts), 'polity key'),
    sharedHexes,
  });
export type PolitiesPaintResponse = z.infer<ReturnType<typeof PolitiesPaintResponse>>;

/* ------------------------------------------------------ checking a response */

/**
 * Zod issue codes that are about how many of something there are, not what it
 * is: a row one character short, 29 rows instead of 30, nine polities instead
 * of eight. The decoders already pad, truncate and report exactly these, so
 * they are warnings about a usable layer, not reasons to throw it away.
 */
const COUNT_ISSUES = new Set(['too_small', 'too_big']);

export type ResponseCheck =
  | { ok: true; value: unknown; warnings: string[] }
  | { ok: false; issues: string[] };

/**
 * Check a parsed response against its schema, tolerating miscounts.
 *
 * The API does not enforce the length constraints in these schemas - the SDK
 * strips `minLength`, `maxLength`, `maxItems` and any `minItems` above 1 before
 * sending, and only writes them into the field descriptions - so a model
 * that miscounts one row of a 30x30 grid produces a response the API accepted
 * but a strict parse rejects. Rejecting it discarded an otherwise complete
 * layer; only a wrong type or a missing field is fatal here.
 */
export function checkResponse(schema: z.ZodType, raw: unknown): ResponseCheck {
  const result = schema.safeParse(raw);
  if (result.success) return { ok: true, value: result.data, warnings: [] };

  const fatal = result.error.issues.filter((issue) => !COUNT_ISSUES.has(issue.code));
  if (fatal.length > 0) return { ok: false, issues: fatal.map(describeIssue) };
  // Nothing transforms in these schemas, so the input is already the output shape.
  return { ok: true, value: raw, warnings: result.error.issues.map(describeIssue) };
}

export function describeIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
  return `${path}: ${issue.message}`;
}
