/**
 * The pass registry: which requests a layer is made of, and how to put the
 * answers back together.
 *
 * Most layers are one request. Polities and rivers can be run as two - a roster
 * pass that decides the cast, then a geometry pass that places it - because
 * doing both at once is what makes them expensive. The two halves are recombined
 * here into exactly the shape a single-request response would have had, so
 * `decodeLayer` stays one implementation and knows nothing about passes.
 *
 * The same table drives the webchat flow, which needs a prompt and a schema for
 * whichever pass the user is running by hand.
 */

import * as z from 'zod/v4';

import type { LayerId } from '../shared/types.js';
import { buildPrompt, type BuiltPrompt, type PromptContext } from './prompts.js';
import {
  keyAt,
  rosterFromPolities,
  rosterFromRivers,
  type PassId,
  type Roster,
} from './rosters.js';
import {
  BaseResponse,
  CitiesResponse,
  ClimateResponse,
  ElevationResponse,
  PolitiesPaintResponse,
  PolitiesResponse,
  PolitiesRosterResponse,
  PopulationResponse,
  RiversPathsResponse,
  RiversResponse,
  RiversRosterResponse,
  VegetationResponse,
} from './schemas.js';

export type { PassId, PassSelection } from './rosters.js';
export { canSplit, passesFor, passLabel } from './rosters.js';

type SchemaFactory = (cols: number, rows: number) => z.ZodType;

const FULL_SCHEMAS: Record<LayerId, SchemaFactory> = {
  base: BaseResponse,
  elevation: ElevationResponse,
  climate: ClimateResponse,
  vegetation: VegetationResponse,
  rivers: RiversResponse,
  cities: CitiesResponse,
  polities: PolitiesResponse,
  population: PopulationResponse,
};

const ROSTER_SCHEMAS: Partial<Record<LayerId, SchemaFactory>> = {
  polities: PolitiesRosterResponse,
  rivers: RiversRosterResponse,
};

const PAINT_SCHEMAS: Partial<Record<LayerId, SchemaFactory>> = {
  polities: PolitiesPaintResponse,
  rivers: RiversPathsResponse,
};

export function schemaForPass(
  layer: LayerId,
  pass: PassId,
  cols: number,
  rows: number,
): z.ZodType {
  const table = pass === 'roster' ? ROSTER_SCHEMAS : pass === 'paint' ? PAINT_SCHEMAS : FULL_SCHEMAS;
  const factory = table[layer];
  if (!factory) throw new Error(`Layer "${layer}" has no "${pass}" pass.`);
  return factory(cols, rows);
}

export function promptForPass(
  layer: LayerId,
  pass: PassId,
  ctx: PromptContext,
  roster: Roster | null = null,
): BuiltPrompt {
  return buildPrompt(layer, ctx, pass, roster);
}

/**
 * The roster the layer already has, if it has one.
 *
 * This is what "repaint the borders, keep the countries" runs against. Because
 * `decodeLayer` matches ids back by name, reusing the roster this way keeps
 * polity ids stable across a repaint rather than minting new ones.
 */
export function rosterFromContext(layer: LayerId, ctx: PromptContext): Roster | null {
  if (layer === 'polities' && ctx.polities && ctx.polities.polities.length > 0) {
    return rosterFromPolities(ctx.polities);
  }
  if (layer === 'rivers' && ctx.rivers && ctx.rivers.rivers.length > 0) {
    return rosterFromRivers(ctx.rivers);
  }
  return null;
}

/* ------------------------------------------------------------ recombination */

/** Pull a roster out of a roster-pass response. */
export function rosterFromResponse(layer: LayerId, parsed: unknown): Roster {
  if (layer === 'polities') {
    const r = parsed as z.infer<ReturnType<typeof PolitiesRosterResponse>>;
    return {
      kind: 'polities',
      entries: (r.polities ?? []).map((p, i) => ({
        key: (p.key ?? '').trim().charAt(0) || keyAt(i),
        name: p.name,
        colour: p.colour,
      })),
    };
  }
  if (layer === 'rivers') {
    const r = parsed as z.infer<ReturnType<typeof RiversRosterResponse>>;
    return { kind: 'rivers', entries: (r.rivers ?? []).map((x) => ({ name: x.name, course: x.course })) };
  }
  throw new Error(`Layer "${layer}" has no roster.`);
}

/**
 * Fold a roster and a geometry response into the single-request shape.
 *
 * Notes and decisions from both halves are kept: the roster pass is where the
 * "why these powers" reasoning lives and the paint pass is where "why this
 * border" lives, and losing either would leave the decision record with a hole
 * exactly where a two-pass generation is most interesting.
 */
export function combinePasses(
  layer: LayerId,
  roster: Roster | null,
  rosterParsed: unknown | null,
  paintParsed: unknown,
): unknown {
  const decisions = [
    ...asDecisions(rosterParsed),
    ...asDecisions(paintParsed),
  ];
  const notes = [asNotes(rosterParsed), asNotes(paintParsed)].filter(Boolean).join(' ');

  if (layer === 'polities') {
    const paint = paintParsed as z.infer<ReturnType<typeof PolitiesPaintResponse>>;
    const entries = roster?.kind === 'polities' ? roster.entries : [];
    return {
      polities: entries.map((e) => ({ key: e.key, name: e.name, colour: e.colour })),
      rows: paint.rows ?? [],
      notes,
      decisions,
    };
  }
  if (layer === 'rivers') {
    const paint = paintParsed as z.infer<ReturnType<typeof RiversPathsResponse>>;
    return { rivers: paint.rivers ?? [], notes, decisions };
  }
  throw new Error(`Layer "${layer}" does not run in passes.`);
}

/**
 * The roster pass on its own still has to produce something applicable, so it
 * is folded into the layer's existing geometry rather than replacing it. For
 * polities that means renaming and recolouring in place; for rivers, renaming.
 */
export function rosterOnlyResponse(
  layer: LayerId,
  roster: Roster,
  rosterParsed: unknown,
  ctx: PromptContext,
): unknown {
  const decisions = asDecisions(rosterParsed);
  const notes = asNotes(rosterParsed);

  if (layer === 'polities') {
    const entries = roster.kind === 'polities' ? roster.entries : [];
    const existing = ctx.polities;
    // Re-key the existing partition onto the new roster by position, which is
    // how the prompts have always encoded an existing layer.
    const keyByOldId = new Map(
      (existing?.polities ?? []).map((p, i) => [p.id, entries[i]?.key ?? keyAt(i)]),
    );
    const rows: string[] = [];
    for (let row = 0; row < ctx.rows; row++) {
      let line = '';
      for (let col = 0; col < ctx.cols; col++) {
        const owner = existing?.owner[row * ctx.cols + col] ?? null;
        line += owner ? keyByOldId.get(owner) ?? '.' : '.';
      }
      rows.push(line);
    }
    return {
      polities: entries.map((e) => ({ key: e.key, name: e.name, colour: e.colour })),
      rows,
      notes,
      decisions,
    };
  }
  if (layer === 'rivers') {
    const entries = roster.kind === 'rivers' ? roster.entries : [];
    const existing = ctx.rivers?.rivers ?? [];
    return {
      rivers: existing.map((river, i) => ({
        name: entries[i]?.name ?? river.name,
        path: river.segments.map((s) => ({ col: s.col, row: s.row })),
        navigable: river.segments.map((s) => s.navigable),
      })),
      notes,
      decisions,
    };
  }
  throw new Error(`Layer "${layer}" does not run in passes.`);
}

function asDecisions(parsed: unknown): unknown[] {
  const raw = (parsed as { decisions?: unknown } | null)?.decisions;
  return Array.isArray(raw) ? raw : [];
}

function asNotes(parsed: unknown): string {
  const raw = (parsed as { notes?: unknown } | null)?.notes;
  return typeof raw === 'string' ? raw.trim() : '';
}
