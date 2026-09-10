/**
 * Zod schemas for every structured response we ask the model for.
 * These are handed to the API via `zodOutputFormat`, so the model is constrained
 * to the shape at generation time, and re-validated here before we trust it.
 */

import * as z from 'zod/v4';

const notes = z
  .string()
  .describe('One or two sentences explaining the main choices you made. Shown to the user.');

export const BaseResponse = z.object({
  rows: z
    .array(z.string())
    .describe('One string per grid row, north to south; one legend character per hex, west to east.'),
  notes,
});
export type BaseResponse = z.infer<typeof BaseResponse>;

export const ElevationResponse = z.object({
  rows: z.array(z.string()).describe('One string per grid row; one legend character per hex.'),
  notes,
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
});
export type ClimateResponse = z.infer<typeof ClimateResponse>;

export const VegetationResponse = z.object({
  rows: z
    .array(z.string())
    .describe('One string per grid row; space-separated two-letter vegetation codes, one per hex.'),
  notes,
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
});
export type PolitiesResponse = z.infer<typeof PolitiesResponse>;

export const PopulationResponse = z.object({
  rows: z
    .array(z.string())
    .describe('One string per grid row; space-separated integers, one per hex, "-" for water.'),
  notes,
});
export type PopulationResponse = z.infer<typeof PopulationResponse>;
