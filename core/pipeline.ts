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
import { decodeLayer, extractJsonObject, type ExistingFeatures } from './decode.js';
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

export function isStructuredOutputParseError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof SyntaxError) return true;
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
      throw new Error('The model returned malformed data twice. Please try generating this layer again.', {
        cause: retryError,
      });
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

/** One structured, streamed call to the Messages API. */
async function callModel<S extends z.ZodType>(
  config: GenerationConfig & { client: Anthropic },
  schema: S,
  system: string,
  user: string,
  onProgress: ProgressFn,
  signal?: AbortSignal,
): Promise<{ parsed: z.infer<S>; usage: Usage }> {
  const budget = clampTaskBudget(config.taskBudget ?? DEFAULT_TASK_BUDGET);
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
        format: betaZodOutputFormat(schema),
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

    const parsed = (message as { parsed_output?: unknown }).parsed_output;
    if (parsed != null) return { parsed: parsed as z.infer<S>, usage };

    // The API constrains the output to the schema, so this is a belt-and-braces
    // path for a response that arrived as plain text anyway.
    const text = message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const json = extractJsonObject(text);
    if (!json) throw new Error('The model returned an empty response.');
    return { parsed: schema.parse(JSON.parse(json)) as z.infer<S>, usage };
  }, () => onProgress({ phase: 'retrying', detail: 'The model returned malformed JSON; retrying once.' }));
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
  let roster: Roster | null = req.roster ?? null;
  let rosterParsed: unknown = null;

  const call = async (pass: PassId): Promise<unknown> => {
    onProgress({ phase: 'prompting', detail: passes.length > 1 ? passLabel(layer, pass) : undefined });
    const { system, user } = promptForPass(layer, pass, ctx, roster);
    const result = await callModel(
      { ...config, client },
      schemaForPass(layer, pass, ctx.cols, ctx.rows),
      system,
      user,
      onProgress,
      signal,
    );
    usages.push(result.usage);
    return result.parsed;
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
    warnings: decoded.warnings,
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
