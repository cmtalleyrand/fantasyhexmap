import { LAYER_META } from './layers.js';
import { LAYER_ORDER, type LayerId, type MapState } from './types.js';

/** Everything a layer reads: the layers it cannot be made without, and the ones it uses as context. */
function inputsOf(id: LayerId): LayerId[] {
  return [...LAYER_META[id].requires, ...LAYER_META[id].uses];
}

/**
 * The order to generate layers in so that each is built after everything it
 * reads. `LAYER_ORDER` is the order layers are listed in, and it is not quite
 * this: Vegetation is listed before Rivers but uses them, so generating in list
 * order builds Vegetation without rivers and marks it stale the moment Rivers
 * lands. A topological sort over `requires` and `uses`, with list order as the
 * tie-break, puts Rivers first.
 */
export function generationOrder(layers: Iterable<LayerId> = LAYER_ORDER): LayerId[] {
  const wanted = new Set(layers);
  const placed = new Set<LayerId>();
  const order: LayerId[] = [];
  while (placed.size < LAYER_ORDER.length) {
    const next = LAYER_ORDER.find(
      (id) => !placed.has(id) && inputsOf(id).every((dep) => placed.has(dep)),
    );
    if (!next) throw new Error('The layer dependency graph has a cycle.');
    placed.add(next);
    order.push(next);
  }
  return order.filter((id) => wanted.has(id));
}

/**
 * Select the next wave of layers to generate at the same time.
 *
 * A layer is ready when every layer it requires has data and nothing it reads
 * - required or merely used - is still waiting in this batch. Running a layer
 * alongside one of its own inputs would build it against a version that is
 * about to be replaced, which costs a whole generation and leaves it stale.
 */
export function nextGenerationWave(
  pending: readonly LayerId[],
  map: MapState,
  concurrency: number,
): LayerId[] {
  const limit = Math.max(1, Math.floor(concurrency));
  const waiting = new Set(pending);
  return generationOrder(pending)
    .filter(
      (id) =>
        LAYER_META[id].requires.every((dep) => map.layers[dep].data !== null) &&
        inputsOf(id).every((dep) => !waiting.has(dep)),
    )
    .slice(0, limit);
}
