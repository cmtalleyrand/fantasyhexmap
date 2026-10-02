import { LAYER_META, hasData, isLayerEnabled } from './layers.js';
import { generationOrder } from './generationQueue.js';
import type { LayerId, MapState } from './types.js';

export interface MultiEditPlan {
  /** Layers that will be rewritten, each after everything it reads (see `generationOrder`). */
  layers: LayerId[];
  /** Selected layers that cannot be edited, because they are not planned or hold no data yet. */
  skipped: LayerId[];
}

/**
 * Which of the selected layers one instruction can be applied to.
 *
 * Order is dependency order, not the order of selection: each layer is
 * rewritten after the layers it reads, as they stand after their own rewrite,
 * so an upstream change reaches the layers that read it within the same run.
 */
export function planMultiLayerEdit(map: MapState, selected: Iterable<LayerId>): MultiEditPlan {
  const chosen = new Set(selected);
  const layers: LayerId[] = [];
  const skipped: LayerId[] = [];
  for (const id of generationOrder(chosen)) {
    (isLayerEnabled(map, id) && hasData(map, id) ? layers : skipped).push(id);
  }
  return { layers, skipped };
}

/**
 * The instruction one layer is sent when the same user instruction is being
 * applied across several. Each layer is a separate request, so each is told what
 * the others are doing and where it stands in the sequence; a layer the
 * instruction does not concern is told to hand back what it was given.
 */
export function instructionForLayer(instruction: string, layers: readonly LayerId[], layer: LayerId): string {
  const text = instruction.trim();
  if (layers.length < 2) return text;
  const names = layers.map((id) => LAYER_META[id].label);
  const index = layers.indexOf(layer);
  const earlier = layers.slice(0, index).map((id) => LAYER_META[id].label);
  const later = layers.slice(index + 1).map((id) => LAYER_META[id].label);
  return [
    text,
    '',
    `This instruction is being applied across several layers, one at a time in this order: ${names.join(', ')}.`,
    `You are doing the ${LAYER_META[layer].label} layer only.`,
    earlier.length > 0
      ? `${earlier.join(', ')} ${earlier.length === 1 ? 'has' : 'have'} already been updated and ${earlier.length === 1 ? 'is' : 'are'} shown above as they now stand: make this layer agree with them.`
      : 'No layer has been updated yet in this sequence.',
    later.length > 0
      ? `${later.join(', ')} will be updated after you, against your result; do not try to edit ${later.length === 1 ? 'it' : 'them'} here.`
      : '',
    `Make only the part of the instruction that belongs in the ${LAYER_META[layer].label} layer. If none of it does, return the layer unchanged.`,
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n')
    .trim();
}
