/**
 * The generation pipeline: build a prompt, stream a structured response from
 * Claude, decode the compact row-string form back into layer data, then repair
 * and validate it against the layers it depends on.
 *
 * This module is isomorphic on purpose. It runs unchanged in the Express server
 * (key from .env, or from a proxy's secret store) and in the browser (key
 * supplied by the person using the page). Whoever calls it hands in a
 * configured client; nothing here reads an environment variable or knows where
 * the credential came from, so there is exactly one implementation of prompting,
 * decoding and validation regardless of how the app is deployed.
 */

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import * as z from 'zod/v4';

import type { Decision, LayerDataMap, LayerId } from '../shared/types.js';
import type { PromptContext } from './prompts.js';
import {
  decodeLayer,
  extractJsonObject,
  flattenGrid,
  withBriefRecorded,
  type ExistingFeatures,
} from './decode.js';

export { flattenGrid, withBriefRecorded } from './decode.js';
import { mockLayer } from './mock.js';
import { LAYER_META } from '../shared/layers.js';
import {
  clampTaskBudget,
  DEFAULT_TASK_BUDGET,
  lowerEffort,
  MAX_TOKENS,
  TASK_BUDGET_BETA,
  type Effort,
} from './config.js';
import {
  canSplit,
  combinePasses,
  rosterFromContext,
  passLabel,
  passesFor,
  promptForPass,
  rosterFromResponse,
  rosterOnlyResponse,
  schemaForPass,
  type PassId,
  type PassSelection,
} from './passes.js';
import type { Roster } from './rosters.js';
import { checkResponse } from './schemas.js';

export { DEFAULT_EFFORT, DEFAULT_MODEL, type Effort } from './config.js';
export type { PassSelection } from './passes.js';

const LAYER_LABEL = Object.fromEntries(
  Object.entries(LAYER_META).map(([id, meta]) => [id, meta.label]),
) as Record<LayerId, string>;

export interface GenerationConfig {
  /** null runs the offline procedural generator instead of calling the API. */
  client: Anthropic | null;
  model: string;
  effort: Effort;
  /**
   * Advisory token budget the model paces its reasoning against. Optional so
   * existing callers keep working; omitted means the default.
   */
  taskBudget?: number;
}

export interface GenerateResult<K extends LayerId = LayerId> {
  layer: K;
  data: LayerDataMap[K];
  warnings: string[];
  notes: string | null;
  /** The model's account of the choices that shaped this layer. */
  decisions: Decision[];
  /** Model that produced it, or null when the offline generator did. */
  model: string | null;
  usage: Usage | null;
}

/**
 * `thinking` is the part of `output` the model spent on reasoning rather than
 * on the answer. It is the number that explains a truncated response, and the
 * reason the error text below can stop guessing at the cause.
 */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  thinking: number;
}

export type ProgressFn = (event: { phase: string; detail?: string; chars?: number }) => void;

/**
 * A response that arrived complete but could not be used: not JSON at all, or
 * JSON with a field of the wrong type or missing. Distinct from truncation,
 * which has its own error and its own recovery, and from a response that
 * merely miscounted, which is accepted with warnings (see `checkResponse`).
 */
export class MalformedResponseError extends Error {
  readonly details: string[];
  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = 'MalformedResponseError';
    this.details = details;
  }
}

export function isStructuredOutputParseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof MalformedResponseError || error instanceof SyntaxError) return true;
  return /failed to parse structured output|structured output as json|json.*position/i.test(
    error.message,
  );
}

export async function withStructuredOutputRetry<T>(
  operation: () => Promise<T>,
  onRetry: () => void,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isStructuredOutputParseError(error)) throw error;
    onRetry();
    try {
      return await operation();
    } catch (retryError) {
      if (!isStructuredOutputParseError(retryError)) throw retryError;
      const reason = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(
        `The model returned malformed data twice. Please try generating this layer again. Last problem: ${reason}`,
        { cause: retryError },
      );
    }
  }
}

/**
 * Thrown when the model was cut off by `max_tokens`.
 *
 * Carries the token split because that is what says *why*: on a model that
 * thinks by default, reasoning and answer draw on one budget, and a layer whose
 * answer is two thousand tokens can still be truncated after sixty thousand of
 * reasoning. The caller uses this to retry at lower effort rather than giving up.
 */
export class OutputTruncatedError extends Error {
  readonly usage: Usage;
  constructor(usage: Usage, message: string) {
    super(message);
    this.name = 'OutputTruncatedError';
    this.usage = usage;
  }
}

function describeTruncation(usage: Usage, budget: number): string {
  const answer = Math.max(0, usage.output - usage.thinking);
  if (usage.thinking > answer * 2) {
    return (
      `The model spent ${usage.thinking.toLocaleString()} of its ${usage.output.toLocaleString()} ` +
      `output tokens on reasoning and was cut off with only ${answer.toLocaleString()} tokens of ` +
      `answer written. Reasoning and answer share one budget, so this is a thinking-depth problem, ` +
      `not a grid-size one: lower the effort or raise the token budget in Settings ` +
      `(currently ${budget.toLocaleString()}).`
    );
  }
  return (
    `The response was cut off after ${usage.output.toLocaleString()} output tokens ` +
    `(${usage.thinking.toLocaleString()} of them reasoning). Raise the token budget in Settings ` +
    `(currently ${budget.toLocaleString()}), or split the instruction into smaller steps.`
  );
}

/**
 * The output format sent to the API, without the SDK's own parser.
 *
 * `betaZodOutputFormat` attaches a `parse` that the stream runs inside
 * `finalMessage()`, against the full strict schema. That had two effects that
 * between them made every layer after the base one fail as "malformed":
 *
 *  - The length constraints in our schemas are never sent to the API (the SDK
 *    strips them into descriptions), so a model that wrote 29 characters in a
 *    30-column row got a response the API accepted and the SDK then rejected.
 *    Retrying asked for the same miscount-prone grid again.
 *  - It parsed before we could look at `stop_reason`, so a response cut off by
 *    `max_tokens` surfaced as a JSON syntax error and the truncation recovery
 *    below - lower effort, or split into two passes - never ran.
 *
 * It also parsed each text block on its own, so an answer that arrived in two
 * blocks failed even though the two together were valid.
 *
 * So the schema still constrains decoding, and the parsing happens here, after
 * the stop reason has been read, against a check that tolerates miscounts.
 */
function outputFormat(schema: z.ZodType): { type: 'json_schema'; schema: Record<string, unknown> } {
  const { type, schema: jsonSchema } = betaZodOutputFormat(schema);
  return { type, schema: jsonSchema };
}

/** Warnings the decoders already report in their own words. */
function decoderReportsIt(warning: string): boolean {
  return /^rows(\.|:)/.test(warning);
}

/** One structured, streamed call to the Messages API. */
async function callModel<S extends z.ZodType>(
  config: GenerationConfig & { client: Anthropic },
  schema: S,
  system: string,
  user: string,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<{ parsed: z.infer<S>; usage: Usage; warnings: string[] }> {
  const budget = clampTaskBudget(config.taskBudget ?? DEFAULT_TASK_BUDGET);
  const format = outputFormat(schema);
  return withStructuredOutputRetry(async () => {
    const stream = config.client.beta.messages.stream({
      model: config.model,
      max_tokens: MAX_TOKENS,
      betas: [TASK_BUDGET_BETA],
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: user }],
      output_config: {
        effort: config.effort,
        // Advisory, and visible to the model while it works - unlike max_tokens,
        // which it cannot see and is simply cut off by. This is what makes a
        // long think wind up and answer instead of running off the end.
        task_budget: { type: 'tokens', total: budget },
        format,
      },
    }, { signal });

    let chars = 0;
    let lastPing = 0;
    let thinking = false;
    stream.on('streamEvent', (event) => {
      if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
        thinking = true;
        onProgress({ phase: 'thinking' });
      }
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        if (thinking) {
          thinking = false;
          onProgress({ phase: 'writing' });
        }
        chars += event.delta.text.length;
        const now = Date.now();
        if (now - lastPing > 400) {
          lastPing = now;
          onProgress({ phase: 'writing', chars });
        }
      }
    });

    const message = await stream.finalMessage();

    if (message.stop_reason === 'refusal') {
      throw new Error(
        `The model declined this request${message.stop_details && 'category' in message.stop_details ? ` (${message.stop_details.category})` : ''}. Try rewording the description.`,
      );
    }
    const usage: Usage = {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
      thinking: message.usage.output_tokens_details?.thinking_tokens ?? 0,
    };

    if (message.stop_reason === 'max_tokens') {
      throw new OutputTruncatedError(usage, describeTruncation(usage, budget));
    }

    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return { ...parseResponse(schema, text), usage };
  }, () => onProgress({ phase: 'retrying', detail: 'The model returned unusable JSON; retrying once.' }));
}

/**
 * Turn the text of a complete response into a checked value.
 *
 * Exported for tests: this is the whole of what decides whether a response is
 * "malformed", and it needs no network to exercise.
 */
export function parseResponse<S extends z.ZodType>(
  schema: S,
  text: string,
): { parsed: z.infer<S>; warnings: string[] } {
  const json = extractJsonObject(text) ?? (text.trim() ? text : null);
  if (!json) throw new MalformedResponseError('The model returned an empty response.');

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    throw new MalformedResponseError(
      `The response was not valid JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  const checked = checkResponse(schema, raw);
  if (!checked.ok) {
    throw new MalformedResponseError(
      `The response did not match the expected shape: ${checked.issues.slice(0, 5).join('; ')}.`,
      checked.issues,
    );
  }
  return {
    parsed: checked.value as z.infer<S>,
    warnings: checked.warnings
      .filter((w) => !decoderReportsIt(w))
      .map((w) => `Response did not match the requested size (${w}); used as returned.`),
  };
}

/* ------------------------------------------------------ response shaping */

/**
 * A 400 that is about the output schema rather than the request as a whole.
 * Anything else - an unknown model, a bad key - fails exactly as before.
 */
function isSchemaRejection(error: unknown): boolean {
  if (!(error instanceof Anthropic.BadRequestError)) return false;
  return /schema|grammar|output_config|output format|too (large|complex)/i.test(error.message);
}

/* ------------------------------------------------------------ the pipeline */

export interface GenerateRequest {
  layer: LayerId;
  ctx: PromptContext;
  /** Existing feature lists, so ids survive a regeneration where names match. */
  existing?: ExistingFeatures;
  /**
   * Which half of a splittable layer to generate. Ignored by layers that do not
   * split; defaults to running both halves in sequence.
   */
  selection?: PassSelection;
  /**
   * A roster supplied rather than generated - from a previous roster pass, from
   * the layer as it stands, or typed out by hand. Lets the paint pass run alone.
   */
  roster?: Roster | null;
}

function sumUsage(parts: (Usage | null)[]): Usage | null {
  const present = parts.filter((u): u is Usage => u != null);
  if (present.length === 0) return null;
  return present.reduce((a, b) => ({
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    thinking: a.thinking + b.thinking,
  }));
}

/**
 * Run one layer, in as many passes as it takes.
 *
 * A truncated response is retried once at one effort level down, and a
 * splittable layer that was asked for in one pass is retried as two. Both are
 * the same move: the response ran out of room because of how much reasoning it
 * did, so give it either less to think with or less to think about. Only when
 * that also fails does the error reach the user, and it says which of the two
 * knobs to turn.
 */
export async function generateLayer(
  config: GenerationConfig,
  req: GenerateRequest,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  try {
    return await runPasses(config, req, onProgress, signal);
  } catch (error) {
    if (!(error instanceof OutputTruncatedError)) throw error;

    const softer = lowerEffort(config.effort);
    const splittable = canSplit(req.layer) && (req.selection ?? 'both') === 'both';
    // Already at the bottom of the ladder with nothing left to split: the user
    // has to raise the budget, and the message already says so.
    if (!softer && !splittable) throw error;

    onProgress({
      phase: 'retrying',
      detail: softer
        ? `The response ran out of room after ${error.usage.thinking.toLocaleString()} reasoning tokens; retrying at ${softer} effort.`
        : 'The response ran out of room; retrying as two smaller passes.',
    });

    try {
      return await runPasses(
        { ...config, effort: softer ?? config.effort },
        req,
        onProgress,
        signal,
      );
    } catch (retryError) {
      if (!(retryError instanceof OutputTruncatedError)) throw retryError;
      throw new OutputTruncatedError(
        retryError.usage,
        `${retryError.message} This was already the second attempt${softer ? `, at ${softer} effort` : ''}. ` +
          `You can also generate this layer in a webchat and import the result.`,
      );
    }
  }
}

/**
 * Fit a whole-layer offline response to the pass that was asked for.
 *
 * A roster pass folds onto the existing geometry; a paint pass keeps the roster
 * it was given and takes the generator's geometry. Where the generator's keys
 * do not all appear in a supplied roster, the surplus hexes fall unclaimed and
 * the decode reports it - which is the same thing that happens when a real model
 * uses a key it never declared.
 */
function projectMock(
  layer: LayerId,
  selection: PassSelection,
  roster: Roster | null,
  full: unknown,
  ctx: PromptContext,
): unknown {
  if (!canSplit(layer)) return full;
  if (selection === 'roster') {
    return rosterOnlyResponse(layer, roster ?? rosterFromResponse(layer, full), full, ctx);
  }
  if (selection === 'paint') {
    const against = roster ?? rosterFromContext(layer, ctx);
    if (!against) {
      throw new Error(
        `Painting ${LAYER_LABEL[layer]} needs a roster. Generate one first, reuse the existing one, or supply your own.`,
      );
    }
    return combinePasses(layer, against, null, full);
  }
  // Both passes, but with a roster supplied: honour it rather than the mock's.
  return roster ? combinePasses(layer, roster, null, full) : full;
}

async function runPasses(
  config: GenerationConfig,
  req: GenerateRequest,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  const { layer, ctx } = req;
  const selection = req.selection ?? 'both';
  const passes = passesFor(layer, selection);

  // The offline generator produces a whole layer in one go, but it still has to
  // respect the pass selection and any roster it was handed - silently ignoring
  // those would make the offline mode useless for exercising the very paths it
  // exists to exercise, and would look to the user like the feature is broken.
  if (!config.client) {
    onProgress({ phase: 'writing', detail: 'offline generator' });
    const full = mockLayer(layer, ctx);
    const decoded = decodeLayer(layer, projectMock(layer, selection, req.roster ?? null, full, ctx), ctx, req.existing);
    return { layer, ...decoded, model: null, usage: null };
  }

  const client = config.client;
  const usages: (Usage | null)[] = [];
  const responseWarnings: string[] = [];
  let roster: Roster | null = req.roster ?? null;
  let rosterParsed: unknown = null;

  // Grids come back keyed cell by cell, which the grammar holds to the exact
  // size (see core/grid.ts). If the API ever refuses that schema, the layer is
  // still generated, as row strings, and the user is told what that costs.
  let grid: 'keyed' | 'rows' = 'keyed';

  const call = async (pass: PassId): Promise<unknown> => {
    onProgress({ phase: 'prompting', detail: passes.length > 1 ? passLabel(layer, pass) : undefined });
    const attempt = async () => {
      const { system, user } = promptForPass(layer, pass, { ...ctx, gridFormat: grid }, roster);
      const schema = schemaForPass(layer, pass, ctx.cols, ctx.rows, {
        grid,
        polityKeys:
          pass === 'paint' && roster?.kind === 'polities' ? roster.entries.map((e) => e.key) : undefined,
      });
      return callModel({ ...config, client }, schema, system, user, onProgress, signal);
    };

    let result: Awaited<ReturnType<typeof attempt>>;
    try {
      result = await attempt();
    } catch (error) {
      if (grid !== 'keyed' || !isSchemaRejection(error)) throw error;
      grid = 'rows';
      responseWarnings.push(
        'The API would not accept the cell-by-cell grid format for this request, so this layer was generated as row strings; row lengths were not enforced and may have been repaired.',
      );
      onProgress({ phase: 'retrying', detail: 'Grid format rejected by the API; retrying with row strings.' });
      result = await attempt();
    }
    usages.push(result.usage);
    responseWarnings.push(...result.warnings);
    return withBriefRecorded(flattenGrid(layer, result.parsed, ctx.cols, ctx.rows));
  };

  let combined: unknown;
  if (passes.length === 1 && passes[0] === 'full') {
    combined = await call('full');
  } else {
    if (passes.includes('roster')) {
      rosterParsed = await call('roster');
      roster = rosterFromResponse(layer, rosterParsed);
    }
    if (passes.includes('paint')) {
      if (!roster) {
        throw new Error(
          `Painting ${LAYER_LABEL[layer]} needs a roster. Generate one first, reuse the existing one, or supply your own.`,
        );
      }
      const painted = await call('paint');
      combined = combinePasses(layer, roster, rosterParsed, painted);
    } else {
      combined = rosterOnlyResponse(layer, roster!, rosterParsed, ctx);
    }
  }

  onProgress({ phase: 'validating' });
  const decoded = decodeLayer(layer, combined, ctx, req.existing);

  return {
    layer,
    data: decoded.data,
    warnings: [...responseWarnings, ...decoded.warnings],
    notes: decoded.notes,
    decisions: decoded.decisions,
    model: config.model,
    usage: sumUsage(usages),
  };
}

// Re-exported so existing callers are unaffected by the move. They live in
// `core/context.ts` because they are pure and this module is not: importing
// them from here would pull the Anthropic SDK into the importing bundle.
export { contextFromMap, existingFeatures } from './context.js';
