import { LAYER_META } from './layers.js';
import type { LayerId, MapState } from './types.js';

/** Select the next dependency-safe wave, preserving the map's pipeline order. */
export function nextGenerationWave(
  pending: readonly LayerId[],
  map: MapState,
  concurrency: number,
): LayerId[] {
  const limit = Math.max(1, Math.floor(concurrency));
  return pending
    .filter((id) => LAYER_META[id].requires.every((dep) => map.layers[dep].data !== null))
    .slice(0, limit);
}
