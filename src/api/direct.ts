/**
 * Browser-direct generation, for the static deployment.
 *
 * The same core pipeline the server runs, driven by a client the page builds
 * from the viewer's own key. `dangerouslyAllowBrowser` is exactly as advertised
 * - it is only reasonable because the key belongs to whoever is looking at the
 * page, was typed in by them, and is stored only in their browser. Shipping
 * somebody else's key this way would expose it to every visitor.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  contextFromMap,
  existingFeatures,
  generateLayer,
  type Effort,
  type GenerationConfig,
} from '../../core/pipeline.js';
import { LAYER_META } from '../../shared/layers.js';
import { MAX_DIM, MIN_DIM, type LayerId, type MapState } from '../../shared/types.js';
import { canSplit, rosterFromContext, type PassSelection } from '../../core/passes.js';
import type { Roster } from '../../core/rosters.js';
import type { GenerateResult, ProgressEvent } from './client.js';

export interface DirectOptions {
  apiKey: string | null;
  model: string;
  effort: Effort;
  taskBudget: number;
  offline: boolean;
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'Anthropic rejected that API key. Check it in Settings.';
  }
  if (err instanceof Anthropic.PermissionDeniedError) {
    return 'That API key does not have access to this model. Try a different model in Settings.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Rate limited by the Anthropic API. Wait a moment and try again.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach api.anthropic.com from this browser. Check your connection, and any extension that blocks requests.';
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error ${err.status}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function generateDirect(
  map: MapState,
  layer: LayerId,
  instruction: string | null,
  options: DirectOptions,
  onProgress: (event: ProgressEvent) => void,
  signal?: AbortSignal,
  selection: PassSelection = 'both',
  roster: Roster | null = null,
): Promise<GenerateResult> {
  if (map.cols < MIN_DIM || map.rows < MIN_DIM || map.cols > MAX_DIM || map.rows > MAX_DIM) {
    throw new Error(`Grid must be between ${MIN_DIM}x${MIN_DIM} and ${MAX_DIM}x${MAX_DIM}.`);
  }
  for (const dep of LAYER_META[layer].requires) {
    if (!map.layers[dep].data) {
      throw new Error(`${LAYER_META[layer].label} needs the ${LAYER_META[dep].label} layer first.`);
    }
  }
  if (!options.offline && !options.apiKey) {
    throw new Error('No API key set. Open Settings to add one, or switch on the offline generator.');
  }

  const config: GenerationConfig = {
    client: options.offline
      ? null
      : new Anthropic({ apiKey: options.apiKey!, dangerouslyAllowBrowser: true }),
    model: options.model,
    effort: options.effort,
    taskBudget: options.taskBudget,
  };

  const ctx = contextFromMap(map, instruction);
  // A paint-only run falls back to the roster the layer already has, which is
  // what "redraw the borders, keep the countries" means.
  const effectiveRoster =
    canSplit(layer) && selection === 'paint' ? roster ?? rosterFromContext(layer, ctx) : roster;
  if (canSplit(layer) && selection === 'paint' && !effectiveRoster) {
    throw new Error(
      `Painting ${LAYER_META[layer].label} needs a roster: generate one first, or supply your own.`,
    );
  }
  const started = Date.now();
  try {
    const request = {
      layer,
      ctx,
      existing: existingFeatures(ctx),
      selection,
      roster: effectiveRoster,
    };
    const result = await generateLayer(config, request, (event) => {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      onProgress(event);
    }, signal);
    return { ...result, elapsedMs: Date.now() - started };
  } catch (err) {
    if (signal?.aborted || (err as Error)?.name === 'AbortError') {
      throw new DOMException('Aborted', 'AbortError');
    }
    throw new Error(describeError(err));
  }
}
