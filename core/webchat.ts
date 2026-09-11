/**
 * Generating a layer somewhere else and bringing it back.
 *
 * The in-app path and this one ask for the same thing; they differ only in who
 * carries the message. So this module builds the same prompt the API would have
 * received, flattens it into one block of text a person can paste into a chat
 * window, and appends the response shape - because a webchat has no structured
 * outputs to constrain the answer with, the shape has to be described rather
 * than enforced.
 *
 * Both halves of that description are derived rather than written: the JSON
 * Schema comes from the same Zod schema the API is given, and the worked example
 * from the offline generator that already produces schema-shaped output. Neither
 * can drift out of step with the real contract when a layer changes, which a
 * hand-maintained copy of either certainly would.
 *
 * Nothing here imports the Anthropic SDK, so this works on a static deployment
 * with no key at all - which is rather the point.
 */

import * as z from 'zod/v4';

import type { LayerId } from '../shared/types.js';
import { LAYER_META } from '../shared/layers.js';
import type { PromptContext } from './prompts.js';
import { decodeLayer, extractJsonObject, type DecodedLayer, type ExistingFeatures } from './decode.js';
import { mockLayer } from './mock.js';
import {
  combinePasses,
  passLabel,
  promptForPass,
  rosterFromResponse,
  rosterOnlyResponse,
  schemaForPass,
  type PassId,
} from './passes.js';
import type { Roster } from './rosters.js';

/* ------------------------------------------------------------ the prompt */

export interface WebchatPromptOptions {
  layer: LayerId;
  pass: PassId;
  ctx: PromptContext;
  /** Required by a paint pass: the cast the geometry is drawn for. */
  roster?: Roster | null;
}

export function buildWebchatPrompt(options: WebchatPromptOptions): string {
  const { layer, pass, ctx, roster = null } = options;
  const { system, user } = promptForPass(layer, pass, ctx, roster);
  const schema = schemaForPass(layer, pass, ctx.cols, ctx.rows);
  const jsonSchema = z.toJSONSchema(schema) as { properties?: Record<string, unknown> };
  const returnsRows = Object.hasOwn(jsonSchema.properties ?? {}, 'rows');

  return [
    system,
    '',
    divider(),
    '',
    user,
    '',
    divider(),
    '',
    'HOW TO REPLY',
    'Reply with a single JSON object and nothing else - no commentary before or after it, and no',
    'explanation of what you did. Everything you want to say about the map goes in "notes" and',
    '"decisions", which are part of the object.',
    '',
    'Nothing is validating this as you write it, so check the shape yourself before you answer.',
    ...(returnsRows
      ? [
          `In particular every row string must have exactly ${ctx.cols} entries and there must be exactly`,
          `${ctx.rows} of them; a row that is one short silently shifts a whole band of the map.`,
        ]
      : []),
    '',
    'JSON SCHEMA',
    '```json',
    JSON.stringify(jsonSchema, null, 2),
    '```',
    '',
    returnsRows
      ? 'WORKED EXAMPLE (a 4x3 map, to show the shape only - not your answer)'
      : 'WORKED EXAMPLE (to show the shape only - not your answer)',
    '```json',
    JSON.stringify(exampleFor(layer, pass), null, 2),
    '```',
  ].join('\n');
}

function divider(): string {
  return '─'.repeat(72);
}

/** A one-line reminder of what the user is about to paste into where. */
export function webchatPromptTitle(layer: LayerId, pass: PassId): string {
  const label = LAYER_META[layer].label;
  return pass === 'full' ? label : `${label} — ${passLabel(layer, pass)}`;
}

/* --------------------------------------------------------- worked example */

/**
 * A miniature of the real thing, produced by the offline generator on a 4x3
 * grid and then projected onto whichever pass is being run. Using the generator
 * rather than a hand-written literal is what keeps the example honest: it is
 * built by the same code that has to satisfy the same schema.
 */
function exampleFor(layer: LayerId, pass: PassId): unknown {
  const ctx = exampleContext();
  const full = mockLayer(layer, ctx) as Record<string, unknown>;
  const notes = 'One or two sentences about the layer as a whole.';
  const decisions = EXAMPLE_DECISIONS;

  if (pass === 'full') return { ...full, notes, decisions };

  if (layer === 'polities') {
    return pass === 'roster'
      ? { polities: full.polities, notes, decisions }
      : { rows: full.rows, notes, decisions };
  }
  if (layer === 'rivers') {
    const rivers = (full.rivers ?? []) as { name: string; path: unknown; navigable: unknown }[];
    return pass === 'roster'
      ? {
          rivers: rivers.map((r) => ({
            name: r.name,
            course: 'rises in the northern hills, runs south-west into the sea',
          })),
          notes,
          decisions,
        }
      : { rivers, notes, decisions };
  }
  return { ...full, notes, decisions };
}

const EXAMPLE_DECISIONS = [
  {
    title: 'A short headline for the choice',
    detail: 'One to three sentences on what you decided and why. Not a restatement of the data.',
    hexes: ['1,0', '2,0'],
  },
  {
    title: 'Where the brief pulled two ways',
    detail: 'Which cue you followed and what you gave up to follow it.',
    hexes: [],
  },
  {
    title: 'Something you invented',
    detail: 'What the brief was silent about, and what you decided instead.',
    hexes: [],
  },
];

/**
 * A 4x3 world for the example to be generated against.
 *
 * The base layer has to be real rather than null: every layer above it reads it,
 * so a context without one cannot produce an example at all. Building it through
 * the same decode path the app uses keeps this from being a special case.
 */
function exampleContext(): PromptContext {
  const empty: PromptContext = {
    description: 'An example world.',
    cols: 4,
    rows: 3,
    base: null,
    elevation: null,
    climate: null,
    vegetation: null,
    rivers: null,
    cities: null,
    polities: null,
    population: null,
    instruction: null,
    excluded: [],
  };
  const base = decodeLayer('base', mockLayer('base', empty), empty).data as PromptContext['base'];
  return { ...empty, base };
}

/* ------------------------------------------------------------- the import */

export class WebchatImportError extends Error {}

export interface WebchatImportOptions {
  layer: LayerId;
  pass: PassId;
  ctx: PromptContext;
  /** The whole reply, prose and fences included. */
  text: string;
  /** The roster a paint pass was drawn against, or one to fold a roster pass into. */
  roster?: Roster | null;
  existing?: ExistingFeatures;
}

export interface WebchatImportResult extends DecodedLayer {
  /** Present when the pasted response was a roster, so the UI can chain to paint. */
  roster: Roster | null;
}

/**
 * Validate a pasted reply and turn it into layer data.
 *
 * A roster pass is folded onto the layer's existing geometry rather than being
 * rejected as unapplicable, so pasting a roster renames and recolours in place -
 * the same thing the in-app roster-only pass does.
 */
export function importWebchatResponse(options: WebchatImportOptions): WebchatImportResult {
  const { layer, pass, ctx, text, roster = null, existing } = options;

  const json = extractJsonObject(text);
  if (!json) {
    throw new WebchatImportError(
      'No JSON object found in that reply. Paste the whole answer, including the braces.',
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new WebchatImportError(
      `That is not valid JSON: ${error instanceof Error ? error.message : String(error)}. ` +
        'Ask the model to reply with the JSON object only.',
    );
  }

  const schema = schemaForPass(layer, pass, ctx.cols, ctx.rows);
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new WebchatImportError(
      `The reply does not match the expected shape:\n${describeIssues(result.error)}\n\n` +
        'Paste that back to the model and ask it to correct those fields.',
    );
  }
  const parsed = result.data;

  if (pass === 'roster') {
    const produced = rosterFromResponse(layer, parsed);
    const folded = rosterOnlyResponse(layer, produced, parsed, ctx);
    return { ...decodeLayer(layer, folded, ctx, existing), roster: produced };
  }

  if (pass === 'paint') {
    if (!roster) {
      throw new WebchatImportError(
        'Importing painted geometry needs the roster it was drawn for. Import or supply the roster first.',
      );
    }
    const combined = combinePasses(layer, roster, null, parsed);
    return { ...decodeLayer(layer, combined, ctx, existing), roster };
  }

  return { ...decodeLayer(layer, parsed, ctx, existing), roster: null };
}

/**
 * Name the fields that were wrong. A chat model can fix "rows.7: expected
 * length 30, received 29"; it cannot do much with "malformed".
 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `  - ${path}: ${issue.message}`;
    })
    .join('\n');
}
