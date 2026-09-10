/**
 * Zod schemas for every structured response we ask the model for.
 * These are handed to the API via `zodOutputFormat`, so the model is constrained
 * to the shape at generation time, and re-validated here before we trust it.
 */

import * as z from 'zod/v4';

const notes = z
  .string()
  .describe('One or two sentences summarising this layer as a whole. Shown to the user.');

/**
 * The model's own account of the choices it made. This is not decoration: it is
 * the record of why the map looks the way it does, which nothing else captures,
 * and it is shown to the user and exported alongside the map.
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
        .describe('Hexes this decision is about as "col,row" strings. Omit or leave empty if it is about the map as a whole.'),
    }),
  )
  .describe(
    'The 3 to 8 decisions that most shaped this layer. Include any place you departed from the obvious answer, resolved a conflict in the brief, or made something up because the brief was silent.',
  );

export const BaseResponse = z.object({
  rows: z
    .array(z.string())
    .describe('One string per grid row, north to south; one legend character per hex, west to east.'),
  notes,
  decisions,
});
export type BaseResponse = z.infer<typeof BaseResponse>;

export const ElevationResponse = z.object({
  rows: z.array(z.string()).describe('One string per grid row; one legend character per hex.'),
  notes,
  decisions,
});
export type ElevationResponse = z.infer<typeof ElevationResponse>;

export const ClimateResponse = z.object({
  latitudeBand: z
    .string()
    .describe('The latitude band you decided the map spans, e.g. "roughly 15N to 60N".'),
  rows: z
    .array(z.string())
    .describe('One string per grid row; space-separated Köppen codes, one per hex.'),
  notes,
  decisions,
});
export type ClimateResponse = z.infer<typeof ClimateResponse>;

export const VegetationResponse = z.object({
  rows: z
    .array(z.string())
    .describe('One string per grid row; space-separated two-letter vegetation codes, one per hex.'),
  notes,
  decisions,
});
export type VegetationResponse = z.infer<typeof VegetationResponse>;

export const RiversResponse = z.object({
  rivers: z.array(
    z.object({
      name: z.string(),
      path: z
        .array(z.object({ col: z.number().int(), row: z.number().int() }))
        .describe(
          'Ordered source-to-mouth list of adjacent hexes. Every consecutive pair must share an edge. End with the Sea or Lake hex the river empties into, or with the border hex it leaves the map through.',
        ),
      navigable: z
        .array(z.boolean())
        .describe('One entry per hex in path: is the river navigable through that hex?'),
    }),
  ),
  notes,
  decisions,
});
export type RiversResponse = z.infer<typeof RiversResponse>;

export const CitiesResponse = z.object({
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
export type CitiesResponse = z.infer<typeof CitiesResponse>;

export const PolitiesResponse = z.object({
  polities: z.array(
    z.object({
      key: z.string().describe('The single character used for this polity in the rows below.'),
      name: z.string(),
      colour: z.string().describe('Hex colour such as #a33b2e.'),
    }),
  ),
  rows: z
    .array(z.string())
    .describe('One string per grid row; one polity key per hex, or "." for unclaimed.'),
  notes,
  decisions,
});
export type PolitiesResponse = z.infer<typeof PolitiesResponse>;

export const PopulationResponse = z.object({
  rows: z
    .array(z.string())
    .describe('One string per grid row; space-separated integers, one per hex, "-" for water.'),
  notes,
  decisions,
});
export type PopulationResponse = z.infer<typeof PopulationResponse>;
