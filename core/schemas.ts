/**
 * Zod schemas for every structured response we ask the model for.
 * These are handed to the API via `betaZodOutputFormat`, so the model is
 * constrained to the shape at generation time, and re-validated here before we
 * trust it.
 *
 * The per-hex schemas are built from the grid dimensions rather than being
 * constants, so "exactly `rows` strings of exactly `cols` characters" is a
 * property the API enforces during decoding instead of an instruction the model
 * has to verify by hand. That matters for more than tidiness: counting cells is
 * reasoning, reasoning is output tokens, and output tokens are the budget that
 * ran out. The prompts still say to count, because a webchat model pasting into
 * the import path has no constrained decoding to lean on.
 *
 * Everything here depends on zod and nothing else, so the browser can validate
 * a pasted response without downloading the Anthropic SDK.
 */

import * as z from 'zod/v4';

const notes = z
  .string()
  .describe('One or two sentences summarising this layer as a whole. Shown to the user.');

/** A decision about more hexes than this is really a decision about the map. */
const MAX_DECISION_HEXES = 40;

/**
 * The model's own account of the choices it made. This is not decoration: it is
 * the record of why the map looks the way it does, which nothing else captures,
 * and it is shown to the user and exported alongside the map.
 *
 * Capped, but not floored. The ceiling is what protects the token budget: it
 * stops an uncertain model padding the tail of a response it is already
 * struggling to finish. A floor would buy nothing and cost robustness - it would
 * reject an otherwise good layer that simply had less to say, which matters most
 * on the import path, where the reply is not being regenerated on demand. The
 * prompt still asks for three to eight.
 */
const decisions = z
  .array(
    z.object({
      title: z
        .string()
        .describe('Short headline for the decision, e.g. "Rain shadow east of the Kelder Spine".'),
      detail: z
        .string()
        .describe(
          'One to three sentences: what you decided, and why - the reasoning, the cue in the brief you followed, or the trade-off you made. Not a restatement of the data.',
        ),
      hexes: z
        .array(z.string())
        .max(MAX_DECISION_HEXES)
        .describe('Hexes this decision is about as "col,row" strings. Omit or leave empty if it is about the map as a whole.'),
    }),
  )
  .max(8)
  .describe(
    'The 3 to 8 decisions that most shaped this layer. Include any place you departed from the obvious answer, resolved a conflict in the brief, or made something up because the brief was silent.',
  );

/** One string per grid row, one character per hex - no separators. */
const charRows = (cols: number, rows: number) =>
  z
    .array(z.string().length(cols))
    .length(rows)
    .describe(
      `Exactly ${rows} strings, north to south; each exactly ${cols} characters, one per hex, west to east.`,
    );

/** One string per grid row, space-separated tokens - length varies per token. */
const tokenRows = (cols: number, rows: number, what: string) =>
  z
    .array(z.string())
    .length(rows)
    .describe(
      `Exactly ${rows} strings, north to south; each holds exactly ${cols} space-separated ${what}, one per hex, west to east.`,
    );

export const BaseResponse = (cols: number, rows: number) =>
  z.object({ rows: charRows(cols, rows), notes, decisions });
export type BaseResponse = z.infer<ReturnType<typeof BaseResponse>>;

export const ElevationResponse = (cols: number, rows: number) =>
  z.object({ rows: charRows(cols, rows), notes, decisions });
export type ElevationResponse = z.infer<ReturnType<typeof ElevationResponse>>;

export const ClimateResponse = (cols: number, rows: number) =>
  z.object({
    latitudeBand: z
      .string()
      .describe('The latitude band you decided the map spans, e.g. "roughly 15N to 60N".'),
    rows: tokenRows(cols, rows, 'Köppen codes'),
    notes,
    decisions,
  });
export type ClimateResponse = z.infer<ReturnType<typeof ClimateResponse>>;

export const VegetationResponse = (cols: number, rows: number) =>
  z.object({ rows: tokenRows(cols, rows, 'two-letter vegetation codes'), notes, decisions });
export type VegetationResponse = z.infer<ReturnType<typeof VegetationResponse>>;

export const PopulationResponse = (cols: number, rows: number) =>
  z.object({
    rows: tokenRows(cols, rows, 'integers ("-" for water)'),
    notes,
    decisions,
  });
export type PopulationResponse = z.infer<ReturnType<typeof PopulationResponse>>;

/* ------------------------------------------------------------------ rivers */

const riverPath = z
  .array(z.object({ col: z.number().int(), row: z.number().int() }))
  .describe(
    'Ordered source-to-mouth list of adjacent hexes. Every consecutive pair must share an edge. End with the Sea or Lake hex the river empties into, or with the border hex it leaves the map through.',
  );

const riverNavigable = z
  .array(z.boolean())
  .describe('One entry per hex in path: is the river navigable through that hex?');

export const RiversResponse = (_cols: number, _rows: number) =>
  z.object({
    rivers: z.array(z.object({ name: z.string(), path: riverPath, navigable: riverNavigable })),
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
export const RiversRosterResponse = (_cols: number, _rows: number) =>
  z.object({
    rivers: z.array(
      z.object({
        name: z.string(),
        course: z
          .string()
          .describe(
            'One clause: where it rises, roughly where it runs, and what it empties into. No hex coordinates.',
          ),
      }),
    ),
    notes,
    decisions,
  });
export type RiversRosterResponse = z.infer<ReturnType<typeof RiversRosterResponse>>;

/** Rivers, second pass: the hex geometry for an already-named set of rivers. */
export const RiversPathsResponse = (_cols: number, _rows: number) =>
  z.object({
    rivers: z.array(z.object({ name: z.string(), path: riverPath, navigable: riverNavigable })),
    notes,
    decisions,
  });
export type RiversPathsResponse = z.infer<ReturnType<typeof RiversPathsResponse>>;

/* ------------------------------------------------------------------ cities */

export const CitiesResponse = (_cols: number, _rows: number) =>
  z.object({
    cities: z.array(
      z.object({
        name: z.string(),
        col: z.number().int(),
        row: z.number().int(),
        population: z.number().int().min(0),
        reason: z.string().describe('Why the settlement is here - one short clause.'),
      }),
    ),
    notes,
    decisions,
  });
export type CitiesResponse = z.infer<ReturnType<typeof CitiesResponse>>;

/* ---------------------------------------------------------------- polities */

const polityEntry = z.object({
  key: z.string().length(1).describe('The single character used for this polity in the rows.'),
  name: z.string(),
  colour: z.string().describe('Hex colour such as #a33b2e.'),
});

export const PolitiesResponse = (cols: number, rows: number) =>
  z.object({
    polities: z.array(polityEntry),
    rows: charRows(cols, rows),
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
export const PolitiesRosterResponse = (_cols: number, _rows: number) =>
  z.object({
    polities: z.array(polityEntry),
    notes,
    decisions,
  });
export type PolitiesRosterResponse = z.infer<ReturnType<typeof PolitiesRosterResponse>>;

/** Polities, second pass: the partition, against a roster that is already fixed. */
export const PolitiesPaintResponse = (cols: number, rows: number) =>
  z.object({
    rows: charRows(cols, rows),
    notes,
    decisions,
  });
export type PolitiesPaintResponse = z.infer<ReturnType<typeof PolitiesPaintResponse>>;
