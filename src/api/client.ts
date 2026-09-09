/**
 * Client for the local Express server. The browser never holds an API key and
 * never talks to api.anthropic.com; everything goes through /api here.
 */

import type { LayerDataMap, LayerId, MapState } from '../../shared/types.js';

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
  usage: { input: number; output: number; cacheRead: number } | null;
  elapsedMs: number;
}

export interface HealthInfo {
  ok: boolean;
  model: string;
  mock: boolean;
  credentials: boolean;
}

export async function fetchHealth(): Promise<HealthInfo> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error(`Server responded ${res.status}`);
  return (await res.json()) as HealthInfo;
}

export async function generateLayer(
  map: MapState,
  layer: LayerId,
  instruction: string | null,
  onProgress: (event: ProgressEvent) => void,
  signal?: AbortSignal,
): Promise<GenerateResult> {
  const layers: Partial<Record<LayerId, unknown>> = {};
  for (const [id, state] of Object.entries(map.layers)) {
    if (state.data !== null) layers[id as LayerId] = state.data;
  }

  const res = await fetch('/api/generate', {
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
