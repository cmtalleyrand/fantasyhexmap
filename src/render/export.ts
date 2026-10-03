/**
 * Export entry points. PNG and SVG are produced from the same Scene, so a raster
 * export and a vector export of the same view are the same picture.
 */

import type { LayerId, MapState } from '../../shared/types.js';
import { LAYER_META } from '../../shared/layers.js';
import {
  BASE_GEO_VALUES,
  CLIMATE_VALUES,
  ELEVATION_VALUES,
  LAND_LIKE,
  LAYER_ORDER,
  VEGETATION_GROUPS,
  VEGETATION_VALUES,
} from '../../shared/types.js';
import type { PolityNameMin } from './labels.js';
import { straitSharers } from '../../shared/straits.js';
import { renderToCanvas } from './canvas.js';
import { appendLegend, legendSections, type LegendOptions } from './legend.js';
import { buildScene, singleLayerVisibility, type Scene, type VisibleLayers } from './scene.js';
import { sceneToSvg } from './svg.js';
import { CLASSIC_STYLE, elevationStyleOf, type MapStyle } from './styles.js';

export interface ExportOptions {
  format: 'png' | 'svg';
  labels: boolean;
  riverNames?: boolean;
  rangeNames?: boolean;
  seaNames?: boolean;
  landNames?: boolean;
  polityNames?: PolityNameMin;
  elevationStyle?: 'colour' | 'contours';
  polityOpacity?: number;
  uniformLand?: boolean;
  style?: MapStyle;
  /** Hex circumradius in px used to lay the scene out. */
  size?: number;
  /** PNG pixel multiplier on top of `size`. */
  scale?: number;
  transparentBackground?: boolean;
  /** Append a legend panel to the right of the map. Omit or null for a bare map. */
  legend?: LegendOptions | null;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  // Keep both the element and its object URL alive until the browser has had a
  // chance to begin reading the download. Removing the element synchronously
  // causes JSON exports to be discarded by some browser/webview combinations.
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 2000);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'map';
}

/** The scene an export draws: the map, plus its legend when one is requested. */
export function buildExportScene(map: MapState, visible: VisibleLayers, opts: ExportOptions): Scene {
  const size = opts.size ?? 32;
  const scene = buildScene(map, {
    size,
    visible,
    labels: opts.labels,
    riverNames: opts.riverNames,
    rangeNames: opts.rangeNames,
    seaNames: opts.seaNames,
    landNames: opts.landNames,
    polityNames: opts.polityNames,
    elevationStyle: opts.elevationStyle,
    polityOpacity: opts.polityOpacity,
    uniformLand: opts.uniformLand,
    style: opts.style,
    selection: null,
    hover: null,
    transparentBackground: opts.transparentBackground ?? false,
  });
  if (!opts.legend) return scene;
  const sections = legendSections(
    map,
    visible,
    opts.elevationStyle ?? elevationStyleOf(opts.style ?? CLASSIC_STYLE),
    opts.legend,
    opts.style,
  );
  return appendLegend(scene, sections, opts.legend.title ? map.name : null, size);
}

async function emit(
  map: MapState,
  visible: VisibleLayers,
  opts: ExportOptions,
  nameSuffix: string,
): Promise<void> {
  // The bundled fonts are loaded before the scene is laid out, so names are
  // measured and drawn in them (the module is browser-only, hence the import).
  const fonts = await import('./fontFiles.js');
  await fonts.loadLettering((opts.style ?? CLASSIC_STYLE).knobs.lettering);
  const scene = buildExportScene(map, visible, opts);
  const filename = `${slug(map.name)}-${nameSuffix}.${opts.format}`;
  if (opts.format === 'svg') {
    download(new Blob([sceneToSvg(scene, `${map.name} - ${nameSuffix}`, await fonts.embeddedFontCss(scene))], {
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

export function serializeMapExport(map: MapState, includeHistory: boolean): string {
  const payload = includeHistory
    ? map
    : {
        ...map,
        layers: Object.fromEntries(
          Object.entries(map.layers).map(([id, layer]) => [id, { ...layer, past: [], future: [] }]),
        ),
      };
  return JSON.stringify({ format: 'fantasyhexmap/v1', map: payload }, null, 2);
}

const EDGE_NAMES = ['E', 'SE', 'SW', 'W', 'NW', 'NE'];

/**
 * A JSON export for programs to read. It carries the map's current state only:
 * no journal, no decisions, no undo/redo history, no model notes or validation
 * warnings. In their place it adds a `guide` describing how to read the data
 * and, for the enabled layers, a flat `hexes` list so a consumer does not have
 * to work out the `row * cols + col` indexing itself. The `map` block keeps the
 * normal export shape, so the file still imports back into the app.
 */
export function serializeParseFriendlyExport(map: MapState): string {
  const layerIds = LAYER_ORDER.filter((id) => map.enabledLayers.includes(id) || map.layers[id].data !== null);
  const layers = Object.fromEntries(
    LAYER_ORDER.map((id) => {
      const layer = map.layers[id];
      return [id, { data: layer.data, version: layer.version }];
    }),
  );
  const { journal: _journal, ...rest } = map;
  void _journal;

  const perHex = layerIds.filter((id) => LAYER_META[id].perHex && map.layers[id].data !== null);
  const polityById = new Map(
    (map.layers.polities.data?.polities ?? []).map((p) => [p.id, p]),
  );
  const hexes = [];
  for (let row = 0; row < map.rows; row++) {
    for (let col = 0; col < map.cols; col++) {
      const index = row * map.cols + col;
      const hex: Record<string, unknown> = { index, col, row };
      for (const id of perHex) {
        if (id === 'polities') {
          const owner = map.layers.polities.data?.owner[index] ?? null;
          hex.polity = owner;
          hex.polityName = owner ? (polityById.get(owner)?.name ?? null) : null;
          const base = map.layers.base.data;
          if (!owner && base) {
            const sharers = straitSharers(base, map.layers.polities.data?.owner ?? [], map.cols, map.rows, index);
            if (sharers.size > 0) hex.sharedPolities = [...sharers.keys()];
          }
        } else {
          hex[id] = (map.layers[id].data as unknown[])[index] ?? null;
        }
      }
      hexes.push(hex);
    }
  }

  const guide = {
    purpose:
      'Current state of a fantasy hex map. Contains no decision log, generation history, undo history or model commentary.',
    grid: {
      cols: map.cols,
      rows: map.rows,
      hexCount: map.cols * map.rows,
      orientation: 'pointy-top',
      coordinates:
        'Odd-r offset. col 0..cols-1 runs west to east; row 0..rows-1 runs north to south (row 0 is the northern edge). Odd-numbered rows are shifted half a hex east.',
      flatIndex: 'index = row * cols + col',
      edges: EDGE_NAMES,
      edgeNote:
        'Edge numbers 0..5 are E, SE, SW, W, NW, NE. Edge e of a hex is shared with the neighbour in direction e, which sees the same edge as (e + 3) % 6.',
    },
    layersPresent: layerIds.filter((id) => map.layers[id].data !== null),
    layersEnabled: map.enabledLayers,
    layerOrder: LAYER_ORDER,
    layerShapes: {
      base: 'map.layers.base.data: array of hexCount strings (see values.base)',
      elevation: 'array of hexCount strings or null (null on non-land hexes)',
      climate: 'array of hexCount Koeppen codes or null',
      vegetation: 'array of hexCount strings or null',
      population: 'array of hexCount numbers or null',
      rivers:
        'data.rivers: [{id, name, terminus, branchOf?, joins?, fromLake?, segments:[{col,row,entryEdge|null,exitEdge|null,navigable}]}]. Segments run source to mouth; entryEdge is null at a spring source, or the edge shared with the lake when fromLake. branchOf names the river a distributary leaves (its first segment is in the fork hex); joins names the river a tributary flows into (terminus "River"; its last segment is in the confluence hex, with exitEdge null).',
      cities:
        'data.cities: [{id,col,row,name,population,onRiver,riverId|null,coastal,coastalEdges:number[],site?}]. site is where the marker is drawn: "auto", "inland", "river" or {coast: edge}.',
      polities: 'data.polities: [{id,name,shortName?,colour,parentId?}]; parentId names the larger polity this one is part of, which may own no hexes itself. data.owner: array of hexCount polity ids (the most specific polity) or null',
    },
    values: {
      base: BASE_GEO_VALUES,
      landLike: LAND_LIKE,
      elevation: ELEVATION_VALUES,
      climate: CLIMATE_VALUES,
      vegetation: VEGETATION_VALUES,
      vegetationGroups: VEGETATION_GROUPS,
      riverTermini: ['Sea', 'Lake', 'River', 'OffMap', 'Unresolved'],
    },
    hexList:
      'Top-level `hexes` repeats the per-hex layers as one object per hex for convenience; it is derived from map.layers and carries nothing extra.',
    scale: map.hexDimensions,
    ...(map.mountainRanges?.length
      ? { mountainRangesNote: 'map.mountainRanges[].hexes are flat indices (row * cols + col).' }
      : {}),
    ...(map.geoNames?.length
      ? { geoNamesNote: 'map.geoNames[] names seas, lakes, land features and islands (kind: sea | lake | land | island); hexes are flat indices (row * cols + col).' }
      : {}),
    ...(map.islandSpecs && Object.keys(map.islandSpecs).length
      ? { islandSpecsNote: 'map.islandSpecs maps an Islands or Mainland and islands hex\'s flat index to {large: 0-2, small: 0-5, coastal?: {large?, small?}, side?: edge 0..5}: how many islands it holds, which groups lie against the coast (or the mainland), and the side they lie against (absent: the side facing land). Hexes without an entry take their type\'s default.' }
      : {}),
    ...(map.hexShapes && Object.keys(map.hexShapes).length
      ? { hexShapesNote: 'map.hexShapes maps a flat hex index to {type, land?: 0-100, irregular?: Smooth | Wavy | Ragged | Fractured}: the percentage of that hex that is land and how ragged its shoreline or ice edge is drawn, set by hand on Coastal Land, Islands, Mainland and islands, Isthmus, Strait, Glacier and Sea Ice hexes. They apply only while the hex is still of the base type named in `type`; hexes without an entry take the map-wide land shares in map.hexDimensions. map.defaultIrregularity, when present, is the irregularity of every shaped hex that has none of its own; otherwise each type uses its own default. map.defaultLakeIrregularity is the irregularity of every lake shore whose land hex has none of its own (Ragged when absent).' }
      : {}),
  };

  return JSON.stringify(
    { format: 'fantasyhexmap/v1', variant: 'parse-friendly', guide, map: { ...rest, layers }, hexes },
    null,
    2,
  );
}

export function exportParseFriendlyJson(map: MapState): void {
  download(new Blob([serializeParseFriendlyExport(map)], {
    type: 'application/json;charset=utf-8',
  }), `${slug(map.name)}-data.json`);
}

export function exportJson(map: MapState, includeHistory: boolean): void {
  download(new Blob([serializeMapExport(map, includeHistory)], {
    type: 'application/json;charset=utf-8',
  }), `${slug(map.name)}.json`);
}
