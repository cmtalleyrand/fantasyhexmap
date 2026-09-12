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
import type { PassSelection } from './passes.js';
import { canSplit, rosterFromContext } from './passes.js';
import { MAX_POLITIES, normaliseRoster, type Roster } from './rosters.js';
import type { PromptContext } from './prompts.js';

const SELECTIONS: PassSelection[] = ['both', 'roster', 'paint'];

export interface GenerateBody {
  layer?: string;
  description?: string;
  cols?: number;
  rows?: number;
  instruction?: string | null;
  layers?: Partial<Record<LayerId, unknown>>;
  /** Layers this map has chosen not to have; changes how absent context is described. */
  excluded?: string[];
  /** Which half of a splittable layer to run; ignored by layers that do not split. */
  selection?: string;
  /** A roster supplied instead of generated, for a paint-only run. */
  roster?: unknown;
}

/**
 * Validate an untrusted roster.
 *
 * Keys are reassigned by position regardless of what arrived, because a roster
 * with duplicate or skipped letters would silently drop hexes when the painted
 * rows are decoded against it.
 */
function validateRoster(layer: LayerId, raw: unknown): { error: string } | { roster: Roster | null } {
  if (raw == null) return { roster: null };
  if (!canSplit(layer)) return { roster: null };
  const entries = (raw as { entries?: unknown })?.entries;
  if (!Array.isArray(entries)) return { error: 'roster.entries must be an array.' };
  if (entries.length === 0) return { error: 'The roster has no entries.' };
  // 64 was a made-up number sitting well above the usable key space, so it waved
  // through exactly the rosters that then collapsed onto duplicate keys.
  if (layer === 'polities' && entries.length > MAX_POLITIES) {
    return {
      error: `That roster has ${entries.length} polities; a map can show at most ${MAX_POLITIES}.`,
    };
  }
  if (entries.length > 64) return { error: 'That roster has more entries than a map can use.' };

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') return { error: 'Every roster entry must be an object.' };
    if (typeof (entry as { name?: unknown }).name !== 'string' || !(entry as { name: string }).name.trim()) {
      return { error: 'Every roster entry needs a name.' };
    }
  }

  if (layer === 'polities') {
    return {
      roster: normaliseRoster({
        kind: 'polities',
        entries: entries.map((e) => {
          const item = e as Record<string, unknown>;
          return {
            key: '',
            name: String(item.name).trim(),
            colour: typeof item.colour === 'string' ? item.colour.trim() : '',
          };
        }),
      }),
    };
  }
  return {
    roster: {
      kind: 'rivers',
      entries: entries.map((e) => {
        const item = e as Record<string, unknown>;
        return {
          name: String(item.name).trim(),
          course: typeof item.course === 'string' ? item.course.trim() : '',
        };
      }),
    },
  };
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

  const selection = SELECTIONS.includes(body.selection as PassSelection)
    ? (body.selection as PassSelection)
    : 'both';

  const rosterResult = validateRoster(layer, body.roster);
  if ('error' in rosterResult) return rosterResult;
  // A paint-only run with no roster supplied falls back to the one the layer
  // already has, which is what "redraw the borders, keep the countries" means.
  const roster = rosterResult.roster ?? (selection === 'paint' ? rosterFromContext(layer, ctx) : null);
  if (selection === 'paint' && !roster) {
    return {
      error: `Painting ${LAYER_META[layer].label} needs a roster: generate one first, or supply your own.`,
    };
  }

  return {
    req: {
      layer,
      ctx,
      selection,
      roster,
      existing: {
        rivers: ctx.rivers?.rivers,
        cities: ctx.cities?.cities,
        polities: ctx.polities?.polities,
      },
    },
  };
}

