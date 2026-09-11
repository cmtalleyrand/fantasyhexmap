/**
 * Generation settings shared by every deployment shape.
 *
 * Deliberately free of any dependency on the Anthropic SDK, so the UI can read
 * defaults without pulling the whole client into the initial bundle - in server
 * and proxy deployments the browser never needs the SDK at all.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * Default reasoning depth.
 *
 * This was `high`, which is what made a 30x30 polity generation fail: thinking
 * is on by default on this model and reasoning tokens are output tokens, so a
 * high-effort think on a 900-hex partition could spend the entire output budget
 * before writing any of the answer. `medium` plus an explicit task budget lands
 * the answer; anyone who wants the old behaviour can raise it in Settings.
 */
export const DEFAULT_EFFORT: Effort = 'medium';

/**
 * Hard output cap per generation, covering reasoning and answer together.
 *
 * This is the model's real maximum. It used to be 64000, chosen against the size
 * of the answer alone - a 50x50 layer is a few thousand tokens of row strings -
 * which missed that the same budget pays for the model's reasoning. Every call
 * streams, so there is no request-timeout reason to sit below the cap.
 *
 * Note this is a ceiling the model cannot see: it is cut off mid-sentence when
 * it runs out. TASK_BUDGET below is the one the model can actually pace against.
 */
export const MAX_TOKENS = 128000;

/**
 * Advisory budget the model paces itself against.
 *
 * Unlike MAX_TOKENS, the model is told how much of this is left while it works,
 * so it winds up its reasoning and produces a complete answer instead of being
 * truncated. This is the actual fix for "hit the output token limit"; the cap
 * above is just headroom behind it.
 */
export const DEFAULT_TASK_BUDGET = 40000;

/** The API rejects a task budget below this. */
export const MIN_TASK_BUDGET = 20000;

/** No point offering a budget above the hard cap it sits behind. */
export const MAX_TASK_BUDGET = MAX_TOKENS;

/** Beta flag required for `output_config.task_budget`. */
export const TASK_BUDGET_BETA = 'task-budgets-2026-03-13';

export function clampTaskBudget(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? NaN)) return DEFAULT_TASK_BUDGET;
  return Math.min(MAX_TASK_BUDGET, Math.max(MIN_TASK_BUDGET, Math.round(value as number)));
}

/** One step down the effort ladder, for the retry after a truncated response. */
export function lowerEffort(effort: Effort): Effort | null {
  const index = EFFORT_LEVELS.indexOf(effort);
  return index > 0 ? EFFORT_LEVELS[index - 1]! : null;
}
