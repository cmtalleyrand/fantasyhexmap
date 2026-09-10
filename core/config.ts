/**
 * Generation settings shared by every deployment shape.
 *
 * Deliberately free of any dependency on the Anthropic SDK, so the UI can read
 * defaults without pulling the whole client into the initial bundle - in server
 * and proxy deployments the browser never needs the SDK at all.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const DEFAULT_MODEL = 'claude-opus-5';
export const DEFAULT_EFFORT: Effort = 'high';

/** Output cap per generation. A 50x50 layer is well under this. */
export const MAX_TOKENS = 64000;
