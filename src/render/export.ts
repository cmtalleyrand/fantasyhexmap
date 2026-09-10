/**
 * Export entry points. PNG and SVG are produced from the same Scene, so a raster
 * export and a vector export of the same view are the same picture.
 */

import type { LayerId, MapState } from '../../shared/types.js';
import { LAYER_META } from '../../shared/layers.js';
import { LAYER_ORDER } from '../../shared/types.js';
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

/**
 * The decision record as a document. A generated world is only defensible if the
 * reasoning behind it survives outside the app, so this is a first-class export
 * rather than a debug dump.
 */
export function exportDecisions(map: MapState, opts: { aiOnly: boolean }): void {
  const entries = (map.journal ?? []).filter(
    (e) => !opts.aiOnly || e.kind === 'generate' || e.kind === 'instruct',
  );

  const lines: string[] = [
    `# ${map.name} - how the map was decided`,
    '',
    `${map.cols} x ${map.rows} hexes. Record covers ${entries.length} change${entries.length === 1 ? '' : 's'}, oldest first.`,
    '',
    '## The brief',
    '',
    map.description.trim() || '_(no description was given)_',
    '',
  ];

  const byLayer = new Map<LayerId, typeof entries>();
  for (const entry of entries) {
    byLayer.set(entry.layer, [...(byLayer.get(entry.layer) ?? []), entry]);
  }

  for (const id of LAYER_ORDER) {
    const forLayer = byLayer.get(id);
    if (!forLayer || forLayer.length === 0) continue;
    lines.push(`## ${LAYER_META[id].label}`, '');
    for (const entry of forLayer) {
      const who =
        entry.kind === 'manual' || entry.kind === 'undo' || entry.kind === 'redo'
          ? 'by hand'
          : entry.model
            ? entry.model
            : 'offline generator';
      const stamp = new Date(entry.at).toISOString().replace('T', ' ').slice(0, 16);
      lines.push(`### ${stamp} - ${entry.kind} (${who})`, '');
      if (entry.instruction) lines.push(`> ${entry.instruction}`, '');
      if (entry.summary) lines.push(entry.summary, '');
      for (const d of entry.decisions) {
        const where = d.hexes && d.hexes.length > 0 ? ` _(${d.hexes.join('; ')})_` : '';
        lines.push(`- **${d.title}**${where}`);
        if (d.detail) lines.push(`  ${d.detail}`);
      }
      if (entry.decisions.length > 0) lines.push('');
      if (entry.warnings > 0) {
        lines.push(`_${entry.warnings} validation note${entry.warnings === 1 ? '' : 's'} raised on this pass._`, '');
      }
    }
  }

  if (entries.length === 0) {
    lines.push('_Nothing has been generated yet._', '');
  }

  download(new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }), `${slug(map.name)}-decisions.md`);
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
