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

import { LAYER_ORDER, type LayerId } from '../shared/types.js';
import { LAYER_META } from '../shared/layers.js';
import {
  descriptionBlock,
  existingContext,
  gridRules,
  houseStyle,
  layerRules,
  recordDecisions,
  type PromptContext,
} from './prompts.js';
import {
  decodeLayer,
  extractJsonObject,
  proseAround,
  withBriefRecorded,
  type DecodedLayer,
  type ExistingFeatures,
} from './decode.js';
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

/**
 * How the reply is to be laid out.
 *
 * `full` asks for one JSON object holding everything, notes and decisions
 * included, and spells out the whole JSON Schema - the most mechanical form, and
 * the one that brings the decision record into the app intact.
 *
 * `compact` asks for the layer data alone as JSON, with the plan and the
 * decisions written as ordinary chat around it. The prompt is shorter (a field
 * list instead of a schema), and a chat model is better at explaining itself in
 * prose than inside a string field. The prose is kept on import as the layer's
 * notes, so the explanation is not lost.
 */
export type WebchatStyle = 'full' | 'compact';

export interface WebchatPromptOptions {
  layer: LayerId;
  pass: PassId;
  ctx: PromptContext;
  /** Required by a paint pass: the cast the geometry is drawn for. */
  roster?: Roster | null;
  style?: WebchatStyle;
}

/** The context as the webchat prompts use it: row strings, and where the explanation goes. */
function chatContext(ctx: PromptContext, style: WebchatStyle): PromptContext {
  return { ...ctx, gridFormat: 'rows', decisionsInChat: style === 'compact' };
}

export function buildWebchatPrompt(options: WebchatPromptOptions): string {
  const { layer, pass, roster = null, style = 'full' } = options;
  const ctx = chatContext(options.ctx, style);
  const { system, user } = promptForPass(layer, pass, ctx, roster);
  const schema = schemaForPass(layer, pass, ctx.cols, ctx.rows);
  const jsonSchema = z.toJSONSchema(schema) as JsonSchema;
  const returnsRows = Object.hasOwn(jsonSchema.properties ?? {}, 'rows');
  const sizeRule = returnsRows ? rowSizeRule(ctx) : [];

  const reply =
    style === 'compact'
      ? [
          'HOW TO REPLY',
          'Reply in three parts, in this order:',
          '1. In the chat: the scale you are working to, and each statement in the brief that bears on this layer,',
          '   turned into a concrete target on this grid.',
          '2. The layer as ONE JSON object in a ```json code block. It holds only these fields - no notes, no decisions:',
          ...fieldLines(jsonSchema).map((line) => `   ${line}`),
          ...sizeRule.map((line) => `   ${line}`),
          '3. In the chat, after the code block: the decisions that most shaped the layer.',
          '',
          returnsRows ? 'SHAPE OF THE JSON (a 4x3 map - not your answer)' : 'SHAPE OF THE JSON (not your answer)',
          '```json',
          JSON.stringify(dataOnly(exampleFor(layer, pass))),
          '```',
        ]
      : [
          'HOW TO REPLY',
          'Reply with a single JSON object and nothing else - no commentary before or after it, and no',
          'explanation of what you did. Everything you want to say about the map goes in "notes" and',
          '"decisions", which are part of the object.',
          '',
          'Nothing is validating this as you write it, so check the shape yourself before you answer.',
          ...sizeRule,
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
        ];

  return [system, '', divider(), '', user, '', divider(), '', ...reply].join('\n');
}

function rowSizeRule(ctx: PromptContext): string[] {
  return [
    `In particular, every row string must have exactly ${ctx.cols} entries and there must be exactly ${ctx.rows} of them;`,
    'a row that is one short silently shifts a whole band of the map.',
  ];
}

function divider(): string {
  return '─'.repeat(72);
}

/* ------------------------------------------------- several layers at once */

export interface MultiWebchatPromptOptions {
  layers: LayerId[];
  ctx: PromptContext;
  style?: WebchatStyle;
}

/** The selected layers in pipeline order, which is the order they are written and decoded in. */
export function orderLayers(layers: LayerId[]): LayerId[] {
  return LAYER_ORDER.filter((id) => layers.includes(id));
}

/**
 * Why this selection cannot be generated together, or null if it can. A layer
 * needs each of its hard dependencies either on the map already or in the same
 * reply ahead of it.
 */
export function multiLayerProblem(layers: LayerId[], ctx: PromptContext): string | null {
  if (layers.length === 0) return 'Choose at least one layer.';
  // With an instruction the layers are edited, so each has to exist already.
  if (ctx.instruction?.trim()) {
    const absent = orderLayers(layers).filter((id) => !ctx[id as keyof PromptContext]);
    if (absent.length > 0) {
      return `There is an edit instruction, and ${absent.map((id) => LAYER_META[id].label).join(', ')} ${absent.length === 1 ? 'has' : 'have'} no data to edit yet. Deselect ${absent.length === 1 ? 'it' : 'them'}, or clear the instruction to generate instead.`;
    }
  }
  for (const layer of orderLayers(layers)) {
    for (const dep of LAYER_META[layer].requires) {
      if (!layers.includes(dep) && !ctx[dep as keyof PromptContext]) {
        return `${LAYER_META[layer].label} needs ${LAYER_META[dep].label}, which this map does not have yet. Add it to the selection.`;
      }
    }
  }
  return null;
}

/**
 * One prompt for several layers, answered in one reply.
 *
 * The parts every layer shares - the brief, the grid, the house rules - are
 * stated once, then each layer's own rules follow in pipeline order. A layer
 * later in the list is told to build on the ones written before it in the same
 * reply, which stand in for the context grids it would otherwise be shown; that
 * is what keeps, say, climate consistent with an elevation layer that did not
 * exist when the prompt was written. Every layer runs as a single full pass.
 */
export function buildMultiWebchatPrompt(options: MultiWebchatPromptOptions): string {
  const style = options.style ?? 'full';
  const layers = orderLayers(options.layers);
  // An instruction turns this into an edit of layers that already exist: they
  // are shown as they stand, and the instruction is stated once for all of them.
  const instruction = options.ctx.instruction?.trim() || null;
  const ctx = chatContext({ ...options.ctx, instruction }, style);
  const labels = layers.map((id) => `${LAYER_META[id].label} ("${id}")`);
  const existing = existingContext(ctx, instruction ? [] : layers);
  const excluded = (ctx.excluded ?? []).filter((id) => !layers.includes(id));

  const parts: string[] = [
    instruction
      ? `You are editing ${layers.length} layers of a fantasy hex map in a single reply: ${labels.join(', ')}.`
      : `You are generating ${layers.length} layers of a fantasy hex map in a single reply: ${labels.join(', ')}.`,
    'Produce them in that order. Each layer must be consistent with every layer before it, including the ones you',
    'write earlier in this same reply: treat those as the context grids you would otherwise be shown.',
    '',
    gridRules(ctx.cols, ctx.rows),
    '',
    houseStyle(ctx),
  ];
  layers.forEach((id, i) => {
    parts.push('', divider(), `LAYER ${i + 1} OF ${layers.length}: ${LAYER_META[id].label.toUpperCase()} ("${id}")`, '', layerRules(id, ctx));
  });
  parts.push('', divider(), '', recordDecisions(ctx), '', divider(), '', descriptionBlock(ctx.description));
  if (existing.length > 0) {
    parts.push(
      '',
      instruction
        ? 'THE MAP AS IT STANDS (the layers you are editing, and the others they sit among)'
        : 'THE MAP SO FAR (layers you are not regenerating)',
      ...existing,
    );
  }
  if (instruction) {
    parts.push(
      '',
      divider(),
      '',
      'EDIT INSTRUCTION',
      `The layers named above already exist and are shown above as they stand. The user asks for this change:`,
      '<instruction>',
      instruction,
      '</instruction>',
      '',
      `Apply it across ${layers.map((id) => LAYER_META[id].label).join(', ')}, in that order, and return the COMPLETE updated`,
      'layer for every one of them, not only the hexes you changed. A layer is updated against the layers before it',
      'as you have just changed them, so a change made early reaches the later layers in this reply. Make only the',
      'part of the instruction that belongs in each layer, change nothing it does not touch, and where none of it',
      'belongs in a layer, return that layer exactly as it stands.',
    );
  }
  if (excluded.length > 0) {
    parts.push(
      '',
      `This map will never have these layers: ${excluded.map((id) => LAYER_META[id].label).join(', ')}. Anything that would depend on them, settle yourself and say what you assumed.`,
    );
  }

  const combinedExample = Object.fromEntries(layers.map((id) => [id, exampleFor(id, 'full')]));
  const hasRows = layers.some((id) => Object.hasOwn(layerJsonSchema(id, ctx).properties ?? {}, 'rows'));

  if (style === 'compact') {
    parts.push(
      '',
      divider(),
      '',
      'HOW TO REPLY',
      'Reply in three parts, in this order:',
      '1. In the chat: the scale you are working to, and for each layer, each statement in the brief that bears on it',
      '   turned into a concrete target on this grid.',
      `2. ONE JSON object in a \`\`\`json code block with one key per layer - ${layers.map((id) => `"${id}"`).join(', ')} - each holding`,
      '   only that layer\'s data, no notes and no decisions:',
    );
    for (const id of layers) {
      parts.push(`   "${id}":`, ...fieldLines(layerJsonSchema(id, ctx)).map((line) => `     ${line}`));
    }
    if (hasRows) parts.push(...rowSizeRule(ctx).map((line) => `   ${line}`));
    parts.push(
      '3. In the chat, after the code block: for each layer, under its name, the decisions that most shaped it.',
      '',
      hasRows ? 'SHAPE OF THE JSON (a 4x3 map - not your answer)' : 'SHAPE OF THE JSON (not your answer)',
      '```json',
      JSON.stringify(Object.fromEntries(Object.entries(combinedExample).map(([id, v]) => [id, dataOnly(v)]))),
      '```',
    );
  } else {
    const combinedSchema = z.object(
      Object.fromEntries(layers.map((id) => [id, schemaForPass(id, 'full', ctx.cols, ctx.rows)])),
    );
    parts.push(
      '',
      divider(),
      '',
      'HOW TO REPLY',
      `Reply with a single JSON object and nothing else, with one key per layer: ${layers.map((id) => `"${id}"`).join(', ')}.`,
      'Each value is that layer\'s complete object, with its own "brief", "notes" and "decisions".',
      '',
      'Nothing is validating this as you write it, so check the shape yourself before you answer.',
      ...(hasRows ? rowSizeRule(ctx) : []),
      '',
      'JSON SCHEMA',
      '```json',
      JSON.stringify(z.toJSONSchema(combinedSchema), null, 2),
      '```',
      '',
      'WORKED EXAMPLE (a 4x3 map, to show the shape only - not your answer)',
      '```json',
      JSON.stringify(combinedExample, null, 2),
      '```',
    );
  }
  return parts.join('\n');
}

/* ------------------------------------------------------- describing fields */

interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
}

const NOT_DATA = new Set(['brief', 'notes', 'decisions']);

function layerJsonSchema(layer: LayerId, ctx: PromptContext): JsonSchema {
  return z.toJSONSchema(schemaForPass(layer, 'full', ctx.cols, ctx.rows)) as JsonSchema;
}

/** The data fields of a response, one line each - the compact style's stand-in for a schema. */
function fieldLines(schema: JsonSchema): string[] {
  return Object.entries(schema.properties ?? {})
    .filter(([key]) => !NOT_DATA.has(key))
    .map(([key, value]) => `- "${key}": ${describeField(value)}`);
}

function describeField(field: JsonSchema): string {
  const own = field.description ? `${field.description} ` : '';
  if (field.type === 'array' && field.items?.type === 'object') {
    const inner = Object.entries(field.items.properties ?? {})
      .map(([key, p]) => `"${key}"${p.description ? ` (${p.description})` : ''}`)
      .join(', ');
    return `${own}A list of objects, each with ${inner}.`;
  }
  return (own || field.type || 'a value').trim();
}

/** An example response with the parts the compact style moves into the chat taken out. */
function dataOnly(example: unknown): unknown {
  return Object.fromEntries(
    Object.entries(example as Record<string, unknown>).filter(([key]) => !NOT_DATA.has(key)),
  );
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
  const brief = EXAMPLE_BRIEF;

  if (pass === 'full') return { brief, ...full, notes, decisions };

  if (layer === 'polities') {
    return pass === 'roster'
      ? { brief, polities: full.polities, notes, decisions }
      : { brief, rows: full.rows, notes, decisions };
  }
  if (layer === 'rivers') {
    const rivers = (full.rivers ?? []) as { name: string; path: unknown; navigable: unknown }[];
    return pass === 'roster'
      ? {
          brief,
          rivers: rivers.map((r) => ({
            name: r.name,
            course: 'rises in the northern hills, runs south-west into the sea',
          })),
          notes,
          decisions,
        }
      : { brief, rivers, notes, decisions };
  }
  return { brief, ...full, notes, decisions };
}

const EXAMPLE_BRIEF = {
  scale: '~50 km per hex (~2,165 km^2 each), from the 1,500 km width the brief gives the continent',
  requirements: [
    {
      requirement: 'The inland sea covers about 90,000 km^2',
      target: 'about 42 Lake hexes, centred near column 20, row 14',
    },
  ],
};

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

/** Longest stretch of chat prose kept as a layer's notes. */
const MAX_PROSE_NOTES = 6000;

/** Find, parse and return the reply's JSON object, and the prose around it. */
function readReply(text: string): { raw: Record<string, unknown>; prose: string } {
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new WebchatImportError('The reply\'s JSON is not an object.');
  }
  return { raw: raw as Record<string, unknown>, prose: proseAround(text, json) };
}

/**
 * A compact-style reply carries no notes or decisions in its JSON; the
 * explanation is the chat around it. Keep that prose as the layer's notes, so
 * the decision record still says why, and supply the empty decision list the
 * schema expects. A full-style reply is left exactly as it came.
 */
function withChatNotes(raw: unknown, prose: string): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  const notes =
    typeof obj.notes === 'string'
      ? obj.notes
      : prose.length > MAX_PROSE_NOTES
        ? `${prose.slice(0, MAX_PROSE_NOTES).trimEnd()} …`
        : prose;
  return { ...obj, notes, decisions: Array.isArray(obj.decisions) ? obj.decisions : [] };
}

function checkShape(layer: LayerId, pass: PassId, ctx: PromptContext, raw: unknown, where = ''): unknown {
  const schema = schemaForPass(layer, pass, ctx.cols, ctx.rows);
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new WebchatImportError(
      `The reply${where} does not match the expected shape:\n${describeIssues(result.error)}\n\n` +
        'Paste that back to the model and ask it to correct those fields.',
    );
  }
  return withBriefRecorded(result.data);
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
  const { raw, prose } = readReply(text);
  const parsed = checkShape(layer, pass, ctx, withChatNotes(raw, prose));

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

export interface MultiWebchatImportOptions {
  layers: LayerId[];
  ctx: PromptContext;
  text: string;
  existing?: ExistingFeatures;
}

export interface MultiWebchatImportResult {
  layer: LayerId;
  result: DecodedLayer;
}

/**
 * Import a reply holding several layers.
 *
 * Every layer is checked before any is returned, so a reply with one bad layer
 * applies nothing rather than half a map. Layers are decoded in pipeline order,
 * each against a context that already holds the ones decoded before it - the
 * climate is validated against the elevation in the same reply, not the one the
 * map had before.
 */
export function importMultiWebchatResponse(options: MultiWebchatImportOptions): MultiWebchatImportResult[] {
  const layers = orderLayers(options.layers);
  const { raw, prose } = readReply(options.text);

  const missing = layers.filter((id) => raw[id] == null);
  if (missing.length > 0) {
    throw new WebchatImportError(
      `The reply has no ${missing.map((id) => `"${id}"`).join(', ')} ${missing.length === 1 ? 'layer' : 'layers'}. ` +
        `The JSON needs one key per layer: ${layers.map((id) => `"${id}"`).join(', ')}.`,
    );
  }

  let ctx = options.ctx;
  const out: MultiWebchatImportResult[] = [];
  for (const layer of layers) {
    const parsed = checkShape(layer, 'full', ctx, withChatNotes(raw[layer], prose), ` for "${layer}"`);
    const result = decodeLayer(layer, parsed, ctx, options.existing);
    out.push({ layer, result });
    ctx = { ...ctx, [layer]: result.data };
  }
  return out;
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
