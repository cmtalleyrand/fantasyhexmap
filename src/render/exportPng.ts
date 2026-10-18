import type { MapState } from '../../shared/types.js';
import { buildExportScene, type ExportOptions } from './exportScene.js';
import type { VisibleLayers } from './scene.js';
import { CLASSIC_STYLE } from './styles.js';

export interface PngExportRequest { map: MapState; visible: VisibleLayers; opts: ExportOptions }
export interface PngExportReply { blob?: Blob; error?: string }

/** One isolated worker owns the scene, paths and raster buffers until download. */
export async function exportPng(map: MapState, visible: VisibleLayers, opts: ExportOptions): Promise<Blob> {
  if (typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined') {
    const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
    try {
      return await new Promise<Blob>((resolve, reject) => {
        worker.onmessage = ({ data }: MessageEvent<PngExportReply>) => {
          if (data.blob) resolve(data.blob);
          else reject(new Error(data.error ?? 'PNG export failed.'));
        };
        worker.onerror = () => reject(new Error('The PNG export worker failed.'));
        worker.onmessageerror = () => reject(new Error('The PNG export worker returned unreadable data.'));
        // Undo history and journals do not affect the picture. Avoid copying
        // potentially hundreds of old maps into an export worker.
        const withoutHistory = <T extends { past: unknown[]; future: unknown[] }>(layer: T): T =>
          ({ ...layer, past: [], future: [] });
        const current: MapState = { ...map, history: { past: [], future: [] }, journal: [],
          layers: {
            base: withoutHistory(map.layers.base), elevation: withoutHistory(map.layers.elevation),
            climate: withoutHistory(map.layers.climate), vegetation: withoutHistory(map.layers.vegetation),
            rivers: withoutHistory(map.layers.rivers), cities: withoutHistory(map.layers.cities),
            polities: withoutHistory(map.layers.polities), population: withoutHistory(map.layers.population),
          } };
        worker.postMessage({ map: current, visible, opts } satisfies PngExportRequest);
      });
    } finally { worker.terminate(); }
  }
  const { loadLettering } = await import('./fontFiles.js');
  const { renderPng } = await import('./png.js');
  await loadLettering((opts.style ?? CLASSIC_STYLE).knobs.lettering);
  return renderPng(buildExportScene(map, visible, opts), opts.scale ?? 2);
}
