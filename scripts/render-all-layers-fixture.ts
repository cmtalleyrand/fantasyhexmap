import { createMapState } from '../shared/layers.ts';
import { LAYER_ORDER, type LayerId } from '../shared/types.ts';
import { mockLayer } from '../core/mock.ts';
import { decodeLayer } from '../core/decode.ts';
import type { PromptContext } from '../core/prompts.ts';
import { buildScene, type VisibleLayers } from '../src/render/scene.ts';
import { drawScene } from '../src/render/canvas.ts';
import { resolveStyle } from '../src/render/styles.ts';
export function fixture(seed: string, span = 40) {
  const context: PromptContext = { description: 'A continent with mountains, forests, lakes and many kingdoms', cols: span, rows: span, base: null, elevation: null, climate: null, vegetation: null, rivers: null, cities: null, polities: null, population: null };
  const map = createMapState(context.description, span, span);
  map.id = seed;
  for (const id of LAYER_ORDER) {
    const { data } = decodeLayer(id, mockLayer(id, context), context);
    // The discriminator and data are paired by decodeLayer above.
    (map.layers[id] as { data: unknown }).data = data;
    (context as unknown as Record<LayerId, unknown>)[id] = data;
  }
  return map;
}
export function options() {
  return { size: 26, visible: Object.fromEntries(LAYER_ORDER.map(id => [id, true])) as VisibleLayers, labels: true, riverNames: true, rangeNames: true, seaNames: true, landNames: true, style: resolveStyle({ preset: 'parchment', overrides: { coast: 'smooth' } }) };
}
export { buildScene, drawScene };
