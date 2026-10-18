import type { MapState } from '../../shared/types.js';
import type { PolityNameMin } from './labels.js';
import { appendLegend, legendSections, type LegendOptions } from './legend.js';
import { addMarginalia, marginaliaWanted, type MarginaliaOptions } from './marginalia.js';
import { buildScene, type Scene, type VisibleLayers } from './scene.js';
import { CLASSIC_STYLE, elevationStyleOf, type ElevationStyle, type MapStyle } from './styles.js';

export interface ExportOptions {
  format: 'png' | 'svg';
  labels: boolean;
  riverNames?: boolean;
  rangeNames?: boolean;
  seaNames?: boolean;
  landNames?: boolean;
  polityNames?: PolityNameMin;
  cityStateMax?: number;
  elevationStyle?: ElevationStyle;
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
  /** Frame, title, scale bar and compass. Omit or null for a bare map. */
  marginalia?: MarginaliaOptions | null;
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
    cityStateMax: opts.cityStateMax,
    elevationStyle: opts.elevationStyle,
    polityOpacity: opts.polityOpacity,
    uniformLand: opts.uniformLand,
    style: opts.style,
    selection: null,
    hover: null,
    transparentBackground: opts.transparentBackground ?? false,
  });
  const furniture = marginaliaWanted(opts.marginalia) ? opts.marginalia : null;
  let out = scene;
  if (opts.legend) {
    const sections = legendSections(
      map,
      visible,
      opts.elevationStyle ?? elevationStyleOf(opts.style ?? CLASSIC_STYLE),
      opts.legend,
      opts.style,
    );
    // A title set on the map is not repeated at the head of the legend.
    out = appendLegend(scene, sections, opts.legend.title && !furniture?.title ? map.name : null, size);
  }
  return furniture ? addMarginalia(map, out, size, furniture, opts.style) : out;
}

