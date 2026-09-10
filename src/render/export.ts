/**
 * Export entry points. PNG and SVG are produced from the same Scene, so a raster
 * export and a vector export of the same view are the same picture.
 */

import type { LayerId, MapState } from '../../shared/types.js';
import { LAYER_META } from '../../shared/layers.js';
import { renderToCanvas } from './canvas.js';
import { buildScene, singleLayerVisibility, type VisibleLayers } from './scene.js';
import { sceneToSvg } from './svg.js';

export interface ExportOptions {
  format: 'png' | 'svg';
  labels: boolean;
  /** Hex circumradius in px used to lay the scene out. */
  size?: number;
  /** PNG pixel multiplier on top of `size`. */
  scale?: number;
  transparentBackground?: boolean;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';
}

async function emit(
  map: MapState,
  visible: VisibleLayers,
  opts: ExportOptions,
  nameSuffix: string,
): Promise<void> {
  const scene = buildScene(map, {
    size: opts.size ?? 32,
    visible,
    labels: opts.labels,
    selection: null,
    hover: null,
    transparentBackground: opts.transparentBackground ?? false,
  });
  const filename = `${slug(map.name)}-${nameSuffix}.${opts.format}`;
  if (opts.format === 'svg') {
    download(new Blob([sceneToSvg(scene, `${map.name} - ${nameSuffix}`)], {
      type: 'image/svg+xml;charset=utf-8',
    }), filename);
    return;
  }
  const canvas = renderToCanvas(scene, opts.scale ?? 2);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('The browser could not encode the PNG.');
  download(blob, filename);
}

export function exportLayer(map: MapState, layer: LayerId, opts: ExportOptions): Promise<void> {
  return emit(map, singleLayerVisibility(layer), opts, slug(LAYER_META[layer].label));
}

export function exportComposite(
  map: MapState,
  visible: VisibleLayers,
  opts: ExportOptions,
): Promise<void> {
  return emit(map, visible, opts, 'composite');
}

export function exportJson(map: MapState, includeHistory: boolean): void {
  const payload = includeHistory
    ? map
    : {
        ...map,
        layers: Object.fromEntries(
          Object.entries(map.layers).map(([id, layer]) => [id, { ...layer, past: [], future: [] }]),
        ),
      };
  download(
    new Blob([JSON.stringify({ format: 'fantasyhexmap/v1', map: payload }, null, 2)], {
      type: 'application/json',
    }),
    `${slug(map.name)}.json`,
  );
}
