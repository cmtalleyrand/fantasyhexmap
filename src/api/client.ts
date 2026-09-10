/**
 * Generation transport.
 *
 * The same build runs in three arrangements and picks between them at boot by
 * asking whether a backend answers:
 *
 *   1. Local development - the Express server on the same origin holds the key
 *      in .env. The browser posts to /api/generate and never sees a credential.
 *   2. A deployed proxy - VITE_API_BASE points at a small worker that holds the
 *      key as a platform secret. Identical to (1) from the browser's side, and
 *      the arrangement to use if other people will use the page.
 *   3. Static hosting with no backend (GitHub Pages) - there is nowhere to hide
 *      a key, so there is no shared key at all: whoever opens the page supplies
 *      their own, it stays in their browser, and the page calls Anthropic
 *      directly. See src/api/direct.ts.
 *
 * What the app must never do is ship a key inside the bundle: a static site
 * cannot keep a secret, and a build-time secret would be readable by every
 * visitor.
 */

import type { Decision, LayerDataMap, LayerId, MapState } from '../../shared/types.js';
import type { DirectOptions } from './direct.js';

/** Empty means "same origin", which is what the local dev proxy expects. */
export const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

export type TransportMode = 'server' | 'browser';

export interface ProgressEvent {
  phase: string;
  detail?: string;
  chars?: number;
  layer?: string;
  model?: string;
}

export interface GenerateResult<K extends LayerId = LayerId> {
  layer: K;
  data: LayerDataMap[K];
  warnings: string[];
  notes: string | null;
  decisions: Decision[];
  model: string | null;
  usage: { input: number; output: number; cacheRead: number } | null;
  elapsedMs: number;
}

export interface HealthInfo {
  ok: boolean;
  model: string;
  mock: boolean;
  credentials: boolean;
}

export interface Transport {
  mode: TransportMode;
  health: HealthInfo | null;
  /** Why the browser is talking to Anthropic itself, when it is. */
  reason: string | null;
}

/**
 * Probe for a backend. A static deployment simply has nothing at /api/health,
 * so the failure is expected rather than an error, and the app falls back to
 * bring-your-own-key mode.
 */
export async function detectTransport(timeoutMs = 4000): Promise<Transport> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}/api/health`, { signal: controller.signal });
    if (!res.ok) throw new Error(`Server responded ${res.status}`);
    const health = (await res.json()) as HealthInfo;
    if (!health?.ok) throw new Error('Server health check returned an unexpected body.');
    return { mode: 'server', health, reason: null };
  } catch {
    return {
      mode: 'browser',
      health: null,
      reason: 'No generation server answered, so this page will call Anthropic directly with a key you supply.',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function generateLayer(
  map: MapState,
  layer: LayerId,
  instruction: string | null,
  transport: TransportMode,
  direct: DirectOptions,
  onProgress: (event: ProgressEvent) => void,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  if (transport === 'browser') {
    // Dynamic import: the Anthropic SDK is only needed when this page is the
    // one calling the API, so server and proxy deployments never download it.
    const { generateDirect } = await import('./direct.js');
    return generateDirect(map, layer, instruction, direct, onProgress, signal);
  }

  const layers: Partial<Record<LayerId, unknown>> = {};
  for (const [id, state] of Object.entries(map.layers)) {
    if (state.data !== null) layers[id as LayerId] = state.data;
  }

  const res = await fetch(`${API_BASE}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      layer,
      description: map.description,
      cols: map.cols,
      rows: map.rows,
      instruction,
      layers,
    }),
    signal: signal ?? null,
  });

  if (!res.ok) {
    let message = `Server responded ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  if (!res.body) throw new Error('The server returned no response stream.');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: GenerateResult | null = null;
  let failure: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const eventMatch = /^event: (.+)$/m.exec(frame);
      const dataMatch = /^data: (.+)$/m.exec(frame);
      if (!eventMatch || !dataMatch) continue;
      const payload = JSON.parse(dataMatch[1]!) as unknown;
      switch (eventMatch[1]) {
        case 'progress':
          onProgress(payload as ProgressEvent);
          break;
        case 'result':
          result = payload as GenerateResult;
          break;
        case 'error':
          failure = (payload as { error: string }).error;
          break;
      }
    }
  }

  if (failure) throw new Error(failure);
  if (!result) throw new Error('The generation stream ended without a result.');
  return result;
}
