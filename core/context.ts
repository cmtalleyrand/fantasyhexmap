/**
 * Building a prompt context from a map.
 *
 * These are pure functions of `MapState`, and they live apart from `pipeline.ts`
 * for one concrete reason: `pipeline.ts` imports the Anthropic SDK at module
 * level, so anything that reaches for it pulls ~300 kB of HTTP client into the
 * importing bundle. The webchat dialog needs a context and never makes a
 * request, and server and proxy deployments must keep shipping no SDK at all -
 * so the two cannot share a module.
 *
 * `pipeline.ts` re-exports both, so existing callers are unaffected.
 */

import type { MapState } from '../shared/types.js';
import { excludedLayers } from '../shared/layers.js';
import type { PromptContext } from './prompts.js';
import type { ExistingFeatures } from './decode.js';

/**
 * Build a prompt context straight from a map. The browser path uses this; the
 * server builds the same shape from its request body, where the input is
 * untrusted and has to be validated field by field first.
 */
export function contextFromMap(map: MapState, instruction: string | null): PromptContext {
  return {
    description: map.description,
    cols: map.cols,
    rows: map.rows,
    base: map.layers.base.data,
    elevation: map.layers.elevation.data,
    climate: map.layers.climate.data,
    vegetation: map.layers.vegetation.data,
    rivers: map.layers.rivers.data,
    cities: map.layers.cities.data,
    polities: map.layers.polities.data,
    population: map.layers.population.data,
    instruction,
    excluded: excludedLayers(map),
  };
}

export function existingFeatures(ctx: PromptContext): ExistingFeatures {
  return {
    rivers: ctx.rivers?.rivers,
    cities: ctx.cities?.cities,
    polities: ctx.polities?.polities,
  };
}
