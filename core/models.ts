/**
 * The models the app offers, and what each one accepts.
 *
 * Every generation is one streamed, structured Messages call that asks the
 * model to think, paces it with a task budget, and sets an effort level. Those
 * three things are not accepted by every model in the same form - a task budget
 * sent to a model without one, or an effort level sent to Haiku, fails the whole
 * request - so the request is shaped from this table rather than written once.
 *
 * Free of any SDK dependency, like config.ts, so the settings UI can read it
 * without pulling the client into the initial bundle.
 */

import {
  clampTaskBudget,
  EFFORT_LEVELS,
  MAX_TOKENS,
  TASK_BUDGET_BETA,
  type Effort,
} from './config.js';
import type { TokenUsage } from '../shared/types.js';

export interface ModelInfo {
  id: string;
  /** Name shown in Settings. */
  label: string;
  /** One line on what it is for, shown under the picker. */
  note: string;
  /** Effort levels the model accepts, lowest first; null when it takes no effort setting at all. */
  efforts: Effort[] | null;
  /** Whether it accepts `output_config.task_budget`. */
  taskBudget: boolean;
  /**
   * How it is asked to think. `adaptive` models decide for themselves, steered
   * by effort; `budget` models are given a fixed number of reasoning tokens;
   * `default` sends nothing and takes whatever the model does unprompted.
   */
  thinking: 'adaptive' | 'budget' | 'default';
  /** Largest `max_tokens` it accepts. */
  maxOutput: number;
  /** US dollars per million input and output tokens, for estimating what a generation cost. */
  price: { input: number; output: number } | null;
}

const ALL_EFFORTS = EFFORT_LEVELS;

export const MODELS: ModelInfo[] = [
  {
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    note: 'Most capable, and the most expensive ($10 / $50 per million tokens in / out).',
    efforts: ALL_EFFORTS,
    taskBudget: true,
    thinking: 'adaptive',
    maxOutput: 128000,
    price: { input: 10, output: 50 },
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    note: 'Best maps for the money; the default ($4 / $20).',
    efforts: ALL_EFFORTS,
    taskBudget: true,
    thinking: 'adaptive',
    maxOutput: 128000,
    price: { input: 4, output: 20 },
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    note: 'The previous Opus ($5 / $25).',
    efforts: ALL_EFFORTS,
    taskBudget: true,
    thinking: 'adaptive',
    maxOutput: 128000,
    price: { input: 5, output: 25 },
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    note: 'An older Opus ($5 / $25).',
    efforts: ALL_EFFORTS,
    taskBudget: true,
    thinking: 'adaptive',
    maxOutput: 128000,
    price: { input: 5, output: 25 },
  },
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    note: 'Cheaper and faster, with somewhat less coherent geography ($2 / $10).',
    efforts: ALL_EFFORTS,
    taskBudget: true,
    thinking: 'adaptive',
    maxOutput: 128000,
    price: { input: 2, output: 10 },
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    note: 'The previous Sonnet ($2 / $10). No token budget: it is not paced.',
    efforts: ALL_EFFORTS,
    taskBudget: false,
    thinking: 'adaptive',
    maxOutput: 128000,
    price: { input: 2, output: 10 },
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    note: 'An older Sonnet ($3 / $15). No token budget and no xhigh effort.',
    efforts: ['low', 'medium', 'high', 'max'],
    taskBudget: false,
    thinking: 'adaptive',
    maxOutput: 128000,
    price: { input: 3, output: 15 },
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    note: 'Cheapest and roughest ($1 / $5). No effort setting; the token budget becomes its thinking budget.',
    efforts: null,
    taskBudget: false,
    thinking: 'budget',
    maxOutput: 64000,
    price: { input: 1, output: 5 },
  },
];

/**
 * What to assume about a model this table does not know, such as one named in
 * HEXMAP_MODEL: the request the app sent before the table existed. Thinking is
 * left to the model's own default rather than forced on, since an older model
 * may reject the adaptive form.
 */
function unknownModel(id: string): ModelInfo {
  return {
    id,
    label: id,
    note: 'Not a model this app knows; sent with the same settings as the newest models.',
    efforts: ALL_EFFORTS,
    taskBudget: true,
    thinking: 'default',
    maxOutput: MAX_TOKENS,
    price: null,
  };
}

export function modelInfo(id: string): ModelInfo {
  return MODELS.find((m) => m.id === id) ?? unknownModel(id);
}

/**
 * The effort level a model will actually be sent: the one asked for if it
 * accepts it, otherwise the nearest it accepts below it (or, failing that,
 * above). Null for a model that takes no effort setting.
 */
export function effortFor(model: ModelInfo, effort: Effort): Effort | null {
  if (!model.efforts) return null;
  if (model.efforts.includes(effort)) return effort;
  const rank = EFFORT_LEVELS.indexOf(effort);
  const below = model.efforts.filter((e) => EFFORT_LEVELS.indexOf(e) < rank);
  return below.at(-1) ?? model.efforts[0] ?? null;
}

/** One step down this model's effort ladder, for the retry after a truncated response. */
export function lowerEffortFor(model: ModelInfo, effort: Effort): Effort | null {
  const current = effortFor(model, effort);
  if (!model.efforts || !current) return null;
  const index = model.efforts.indexOf(current);
  return index > 0 ? model.efforts[index - 1]! : null;
}

/** Room left for the answer itself when a fixed thinking budget is set. */
const ANSWER_HEADROOM = 16000;
const MIN_THINKING_BUDGET = 1024;

/** The fixed thinking budget a `budget` model gets from the token-budget setting. */
export function thinkingBudgetFor(model: ModelInfo, taskBudget: number): number {
  const ceiling = model.maxOutput - ANSWER_HEADROOM;
  const asked = Number.isFinite(taskBudget) ? Math.round(taskBudget) : ceiling;
  return Math.max(MIN_THINKING_BUDGET, Math.min(ceiling, asked));
}

/** The parts of a generation request that depend on the model. */
export interface ModelRequestShape {
  max_tokens: number;
  betas?: string[];
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budget_tokens: number };
  output_config: {
    effort?: Effort;
    task_budget?: { type: 'tokens'; total: number };
  };
}

/**
 * Shape a request for this model. `withTaskBudget: false` drops the task budget
 * even where the table says the model has one, for the retry after the API
 * turns it down.
 */
export function requestShape(
  modelId: string,
  effort: Effort,
  taskBudget: number,
  withTaskBudget = true,
): ModelRequestShape {
  const model = modelInfo(modelId);
  const shape: ModelRequestShape = { max_tokens: model.maxOutput, output_config: {} };
  const level = effortFor(model, effort);
  if (level) shape.output_config.effort = level;
  if (model.taskBudget && withTaskBudget) {
    shape.betas = [TASK_BUDGET_BETA];
    shape.output_config.task_budget = { type: 'tokens', total: clampTaskBudget(taskBudget) };
  }
  if (model.thinking === 'adaptive') shape.thinking = { type: 'adaptive' };
  else if (model.thinking === 'budget') {
    shape.thinking = { type: 'enabled', budget_tokens: thinkingBudgetFor(model, taskBudget) };
  }
  return shape;
}


/**
 * Roughly what a generation cost, in US dollars, from the token counts and the
 * model's list price; null for a model whose price is not known. Cache reads
 * are billed at a tenth of the input price. Cache writes are a little dearer
 * than plain input but are not reported separately, so this slightly
 * understates the cost of a first call.
 */
export function estimateCost(modelId: string | null, usage: TokenUsage | null): number | null {
  if (!modelId || !usage) return null;
  const price = modelInfo(modelId).price;
  if (!price) return null;
  return (usage.input * price.input + usage.cacheRead * price.input * 0.1 + usage.output * price.output) / 1e6;
}
