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
import { normaliseRoster, targetHexes, type Roster } from './rosters.js';
import type { PromptContext } from './prompts.js';
import * as z from 'zod/v4';
import { BASE_GEO_VALUES, CHANNEL_WIDTH_VALUES, IRREGULARITY_VALUES } from '../shared/types.js';
import { normaliseHexDimensions } from '../shared/surfaceArea.js';

const percent = z.number().min(0).max(100);
const positive = z.number().positive();
const channel = z.enum(CHANNEL_WIDTH_VALUES as [string, ...string[]]);
const dimensionsSchema = z.object({
  width: positive, height: positive, unit: z.string().trim().min(1),
  coastalLandPercent: percent.optional(), seaLandPercent: percent.optional(), lakeLandPercent: percent.optional(),
  largeIslandPercent: percent.optional(), smallIslandPercent: percent.optional(),
  mainlandPercent: percent.optional(), glacierPercent: percent.optional(),
  isthmusWidth: channel.optional(), straitWidth: channel.optional(),
  isthmusPercent: percent.optional(), straitPercent: percent.optional(),
  areaRounding: positive.optional(), lengthRounding: positive.optional(),
});
const contextSchema = z.object({
  islandSpecs: z.record(z.string(), z.object({
    large: z.number().int().min(0).max(2), small: z.number().int().min(0).max(6),
    arrangement: z.enum(['scattered', 'chain', 'arc', 'barrier', 'ring']).optional(),
    orientation: z.enum(['free', 'along', 'across']).optional(), layoutSeed: z.number().optional(),
    coastal: z.object({ large: z.boolean().optional(), small: z.boolean().optional() }).optional(),
    side: z.number().int().min(0).max(5).optional(),
  })).optional(),
  hexShapes: z.record(z.string(), z.object({
    type: z.enum(BASE_GEO_VALUES as [string, ...string[]]), land: percent.optional(), width: channel.optional(),
    irregular: z.enum(IRREGULARITY_VALUES as [string, ...string[]]).optional(),
    straitJunctionSide: z.number().int().min(0).max(5).optional(),
    concentrationSide: z.number().int().min(0).max(5).optional(), concentration: percent.optional(),
  })).optional(),
  geoNames: z.array(z.object({
    id: z.string(), name: z.string(), kind: z.enum(['sea', 'lake', 'land', 'island']),
    hidden: z.boolean().optional(), hexes: z.array(z.number().int().nonnegative()),
  })).optional(),
  mountainRanges: z.array(z.object({
    id: z.string(), name: z.string(), hexes: z.array(z.number().int().nonnegative()),
  })).optional(),
});

const SELECTIONS: PassSelection[] = ['both', 'roster', 'paint'];

export interface GenerateBody {
  layer?: string;
  description?: string;
  cols?: number;
  rows?: number;
  hexDimensions?: unknown;
  islandSpecs?: unknown;
  hexShapes?: unknown;
  geoNames?: unknown;
  mountainRanges?: unknown;
  instruction?: string | null;
  layers?: Partial<Record<LayerId, unknown>>;
  /** Layers this map has chosen not to have; changes how absent context is described. */
  excluded?: string[];
  /** Cities and polities may occupy Sea and Lake hexes. */
  allowUnderwater?: boolean;
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
            ...(typeof item.previousName === 'string' ? { previousName: item.previousName } : {}),
            colour: typeof item.colour === 'string' ? item.colour.trim() : '',
            ...(typeof item.shortName === 'string' ? { shortName: item.shortName } : {}),
            ...(typeof item.parent === 'string' ? { parent: item.parent } : {}),
            ...targetHexes(item.hexes),
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
          ...(typeof item.previousName === 'string' ? { previousName: item.previousName } : {}),
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
  let hexDimensions: PromptContext['hexDimensions'];
  if (body.hexDimensions !== undefined) {
    const parsed = dimensionsSchema.safeParse(body.hexDimensions);
    if (!parsed.success) return { error: `Invalid hexDimensions: ${parsed.error.message}` };
    hexDimensions = normaliseHexDimensions(parsed.data as Partial<NonNullable<PromptContext['hexDimensions']>>);
  }
  const extra = contextSchema.safeParse(body);
  if (!extra.success) return { error: `Invalid map context: ${extra.error.message}` };
  const ctx: PromptContext = {
    description: String(body.description ?? ''),
    cols,
    rows,
    hexDimensions,
    ...extra.data as Pick<PromptContext, 'islandSpecs' | 'hexShapes' | 'geoNames' | 'mountainRanges'>,
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
    allowUnderwater: body.allowUnderwater === true,
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

