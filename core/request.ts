/**
 * Validation of an untrusted /api/generate request body.
 *
 * Extracted from the Express app so that any backend which speaks the same
 * contract - the local dev server, or a deployed proxy that holds the API key -
 * validates identically. The browser-direct path does not come through here: it
 * builds a typed context from its own in-memory map instead.
 */

import { LAYER_ORDER, MAX_DIM, MIN_DIM, type LayerId } from '../shared/types.js';
import { LAYER_META } from '../shared/layers.js';
import type { GenerateRequest } from './pipeline.js';
import type { PromptContext } from './prompts.js';

export interface GenerateBody {
  layer?: string;
  description?: string;
  cols?: number;
  rows?: number;
  instruction?: string | null;
  layers?: Partial<Record<LayerId, unknown>>;
  /** Layers this map has chosen not to have; changes how absent context is described. */
  excluded?: string[];
}

export function validateGenerateBody(body: GenerateBody): { error: string } | { req: GenerateRequest } {
  const layer = body.layer as LayerId | undefined;
  if (!layer || !LAYER_ORDER.includes(layer)) {
    return { error: `Unknown layer "${String(body.layer)}".` };
  }
  const cols = Number(body.cols);
  const rows = Number(body.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    return { error: 'cols and rows must be integers.' };
  }
  if (cols < MIN_DIM || rows < MIN_DIM || cols > MAX_DIM || rows > MAX_DIM) {
    return { error: `Grid must be between ${MIN_DIM}x${MIN_DIM} and ${MAX_DIM}x${MAX_DIM}.` };
  }

  const supplied = (body.layers ?? {}) as Record<string, unknown>;
  const ctx: PromptContext = {
    description: String(body.description ?? ''),
    cols,
    rows,
    base: (supplied.base as PromptContext['base']) ?? null,
    elevation: (supplied.elevation as PromptContext['elevation']) ?? null,
    climate: (supplied.climate as PromptContext['climate']) ?? null,
    vegetation: (supplied.vegetation as PromptContext['vegetation']) ?? null,
    rivers: (supplied.rivers as PromptContext['rivers']) ?? null,
    cities: (supplied.cities as PromptContext['cities']) ?? null,
    polities: (supplied.polities as PromptContext['polities']) ?? null,
    population: (supplied.population as PromptContext['population']) ?? null,
    instruction: body.instruction ?? null,
    excluded: (body.excluded ?? []).filter((id): id is LayerId =>
      LAYER_ORDER.includes(id as LayerId),
    ),
  };

  for (const dep of LAYER_META[layer].requires) {
    if (!ctx[dep as keyof PromptContext]) {
      return { error: `Layer "${layer}" requires the ${LAYER_META[dep].label} layer, which was not supplied.` };
    }
  }
  if (ctx.base && ctx.base.length !== cols * rows) {
    return { error: `Base geography has ${ctx.base.length} hexes but the grid is ${cols * rows}.` };
  }

  return {
    req: {
      layer,
      ctx,
      existing: {
        rivers: ctx.rivers?.rivers,
        cities: ctx.cities?.cities,
        polities: ctx.polities?.polities,
      },
    },
  };
}

