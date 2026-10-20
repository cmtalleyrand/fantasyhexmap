/**
 * Zod schemas for every structured response we ask the model for.
 *
 * Each factory builds one of two forms of the same response:
 *
 *  - `grid: 'keyed'` is what the API is given. Every grid row and every cell is
 *    a required property with an enumerated value, which constrained decoding
 *    does enforce - so the grid comes back exactly `cols` x `rows`, every time.
 *    The `brief` checklist is required and comes first, so the model commits to
 *    a scale and to what the brief demands before it writes a single cell.
 *  - `grid: 'rows'` (the default) is what the webchat path describes and what
 *    the decoders read: one string per row. Nothing enforces its size, so
 *    `checkResponse` below accepts a miscount as a warning for the decoders to
 *    repair rather than a reason to discard the layer. `brief` is optional
 *    here, so a pasted reply that leaves it out still imports.
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
import { BASE_GEO_VALUES, CLIMATE_VALUES, ELEVATION_VALUES, VEGETATION_VALUES } from '../shared/types.js';
import { keyedGrid } from './grid.js';

export interface SchemaOptions {
  /** 'keyed' for the API, where the grammar enforces the grid; 'rows' otherwise. */
  grid?: 'rows' | 'keyed';
  /** The roster keys a polity paint pass may use; narrows its cells to those. */
  polityKeys?: string[];
}

const keyed = (opts: SchemaOptions) => opts.grid === 'keyed';

const notes = z
  .string()
  .describe('Normally empty. At most two short sentences total across notes and decisions, only for a material conflict or consequential assumption.');

/** Saved scale plus exceptional conflicts only; the historical field remains import-compatible. */
const briefCheck = z
  .object({
    scale: z
      .string()
      .describe(
        'Only the saved physical scale supplied by the app; do not infer a different scale from the brief.',
      ),
    requirements: z
      .array(
        z.object({
          requirement: z
            .string()
            .describe('One thing the brief states or clearly implies that bears on THIS layer, quoted or closely paraphrased.'),
          target: z
            .string()
            .describe(
              'What it means on this grid, as concretely as possible: a hex count (converted from any stated area with the scale), a location in rows and columns, a relative size.',
            ),
        }),
      )
      .describe(
        'Normally empty. Include only an unavoidable material conflict; do not restate the brief or write a checklist.',
      ),
  })
  .describe('Keep this minimal: saved scale and normally an empty requirements list.');

const briefField = (opts: SchemaOptions) => (keyed(opts) ? briefCheck : briefCheck.optional());

/** A decision about more hexes than this is really a decision about the map. */
const MAX_DECISION_HEXES = 40;

/** Keep older records importable; new prompts normally request an empty list. */
const decisions = z
  .array(
    z.object({
      title: z
        .string()
        .describe('Short headline for the decision, e.g. "Rain shadow east of the Kelder Spine".'),
      detail: z
        .string()
        .describe(
          'One short sentence only for an unavoidable conflict or consequential assumption.',
        ),
      hexes: z
        .array(z.string())
        .max(MAX_DECISION_HEXES)
        .describe('Hexes this decision is about as "col,row" strings. Omit or leave empty if it is about the map as a whole.'),
    }),
  )
  .max(8)
  .describe(
    'Normally empty. At most two short sentences total across decisions and notes; no routine explanations.',
  );

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
    brief: briefField(opts),
    rows: gridField(cols, rows, opts, 'char', BASE_CELL, 'base-geography character'),
    notes,
    decisions,
  });
export type BaseResponse = z.infer<ReturnType<typeof BaseResponse>>;

export const ElevationResponse = (cols: number, rows: number, opts: SchemaOptions = {}) =>
  z.object({
    brief: briefField(opts),
    rows: gridField(cols, rows, opts, 'char', ELEVATION_CELL, 'elevation character'),
    notes,
    decisions,
  });
export type ElevationResponse = z.infer<ReturnType<typeof ElevationResponse>>;

export const ClimateResponse = (cols: number, rows: number, opts: SchemaOptions = {}) =>
  z.object({
    brief: briefField(opts),
    latitudeBand: z
      .string()
      .describe('The latitude band you decided the map spans, e.g. "roughly 15N to 60N".'),
    rows: gridField(cols, rows, opts, 'token', CLIMATE_CELL, 'Köppen code'),
    notes,
    decisions,
  });
export type ClimateResponse = z.infer<ReturnType<typeof ClimateResponse>>;

export const VegetationResponse = (cols: number, rows: number, opts: SchemaOptions = {}) =>
  z.object({
    brief: briefField(opts),
    rows: gridField(cols, rows, opts, 'token', VEGETATION_CELL, 'two-letter vegetation code'),
    notes,
    decisions,
  });
export type VegetationResponse = z.infer<ReturnType<typeof VegetationResponse>>;

export const PopulationResponse = (cols: number, rows: number, opts: SchemaOptions = {}) =>
  z.object({
    brief: briefField(opts),
    rows: gridField(
      cols,
      rows,
      opts,
      'token',
      POPULATION_CELL,
      keyed(opts) ? 'integer (0 for water)' : 'integer ("-" for water)',
    ),
    notes,
    decisions,
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

export const RiversResponse = (_cols: number, _rows: number, opts: SchemaOptions = {}) =>
  z.object({
    brief: briefField(opts),
    rivers: z.array(z.object({ name: z.string(), previousName: z.string().optional().describe('For a rename only, the exact existing river name.'), path: riverPath, navigable: riverNavigable, ...riverLinks })),
    notes,
    decisions,
  });
export type RiversResponse = z.infer<ReturnType<typeof RiversResponse>>;

/**
 * Rivers, first pass: what the rivers are, before any hex is committed to.
 *
 * `course` carries just enough for the second pass to draw the geometry without
 * re-deciding the hydrology from scratch.
 */
export const RiversRosterResponse = (_cols: number, _rows: number, opts: SchemaOptions = {}) =>
  z.object({
    brief: briefField(opts),
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
    notes,
    decisions,
  });
export type RiversRosterResponse = z.infer<ReturnType<typeof RiversRosterResponse>>;

/** Rivers, second pass: the hex geometry for an already-named set of rivers. */
export const RiversPathsResponse = (_cols: number, _rows: number, opts: SchemaOptions = {}) =>
  z.object({
    brief: briefField(opts),
    rivers: z.array(z.object({ name: z.string(), previousName: z.string().optional().describe('For a rename only, the exact existing river name.'), path: riverPath, navigable: riverNavigable, ...riverLinks })),
    notes,
    decisions,
  });
export type RiversPathsResponse = z.infer<ReturnType<typeof RiversPathsResponse>>;

/* ------------------------------------------------------------------ cities */

export const CitiesResponse = (_cols: number, _rows: number, opts: SchemaOptions = {}) =>
  z.object({
    brief: briefField(opts),
    cities: z.array(
      z.object({
        name: z.string(),
        previousName: z.string().optional().describe('For a rename only, the exact existing city name.'),
        col: z.number().int(),
        row: z.number().int(),
        population: z.number().int().min(0),
        reason: z.string().describe('Normally empty; at most a few words for an exceptional placement.'),
        capital: z
          .boolean()
          .optional()
          .describe('True for the seat of a realm or kingdom the brief names; omit for every other settlement.'),
      }),
    ),
    notes,
    decisions,
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
    brief: briefField(opts),
    polities: z.array(polityEntry(opts)),
    rows: gridField(cols, rows, opts, 'char', polityCell(opts), 'polity key'),
    sharedHexes,
    notes,
    decisions,
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
    brief: briefField(opts),
    polities: z.array(polityEntry(opts)),
    notes,
    decisions,
  });
export type PolitiesRosterResponse = z.infer<ReturnType<typeof PolitiesRosterResponse>>;

/** Polities, second pass: the partition, against a roster that is already fixed. */
export const PolitiesPaintResponse = (cols: number, rows: number, opts: SchemaOptions = {}) =>
  z.object({
    brief: briefField(opts),
    rows: gridField(cols, rows, opts, 'char', polityCell(opts), 'polity key'),
    sharedHexes,
    notes,
    decisions,
  });
export type PolitiesPaintResponse = z.infer<ReturnType<typeof PolitiesPaintResponse>>;

/* ------------------------------------------------------ checking a response */

/**
 * Zod issue codes that are about how many of something there are, not what it
 * is: a row one character short, 29 rows instead of 30, nine decisions instead
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
