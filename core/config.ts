/**
 * Generation settings shared by every deployment shape.
 *
 * Deliberately free of any dependency on the Anthropic SDK, so the UI can read
 * defaults without pulling the whole client into the initial bundle - in server
 * and proxy deployments the browser never needs the SDK at all.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const EFFORT_LEVELS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The model every layer is generated with unless Settings or HEXMAP_MODEL says
 * otherwise. Opus 5.5 is the current Opus: the same 1M context and 128k output
 * as Opus 5 at a lower price. Its own default effort is medium, but the app
 * always sends an effort explicitly, so that does not apply here.
 */
export const DEFAULT_MODEL = 'claude-opus-5-5';

/** The default model before Opus 5.5, for recognising prefs nobody chose. */
export const PREVIOUS_DEFAULT_MODEL = 'claude-opus-5';

/**
 * Default reasoning depth.
 *
 * This was cut from `high` to `medium` when a 30x30 polity generation ran out
 * of output tokens mid-thought. That diagnosis was right, but the cut was paid
 * for in exactly what users then complained about - areas the brief stated
 * ignored, explicit constraints missed - and the safety net meant to catch a
 * too-long think never actually ran: the SDK's structured-output parser turned
 * every truncated response into a "malformed JSON" error before the truncation
 * retry could see it. With that fixed, a `high` run that does overrun is retried
 * automatically one level down, so the default can go back to the depth a
 * whole-map spatial problem needs.
 */
export const DEFAULT_EFFORT: Effort = 'high';

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
 * truncated. It covers reasoning and answer together, and the answer is no
 * longer small: a grid now comes back cell by cell (see core/grid.ts), which is
 * roughly 12,000 tokens for a 50x50 layer. 40,000 left too little room to think
 * about a detailed brief on a large map; 96,000 leaves ample reasoning room and
 * still sits well inside the hard cap.
 */
export const DEFAULT_TASK_BUDGET = 96000;

/** The defaults before this version, for recognising prefs nobody chose. */
export const PREVIOUS_DEFAULTS = { effort: 'medium' as Effort, taskBudget: 40000 };

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
