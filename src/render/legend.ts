/**
 * Export legends.
 *
 * A legend is built in two steps so each can be checked on its own. First,
 * `legendSections` reads the map and says *what* the legend contains: it follows
 * what the scene actually paints (a hidden layer, or a fill layer that loses to a
 * more derived one, contributes nothing). Second, `appendLegend` lays those
 * sections out as an ordinary panel of scene primitives to the right of the map.
 * Because the panel is just more primitives, PNG and SVG exports get identical
 * legends and neither back end needs to know a legend exists.
 */

import { fantasyTextEm } from './fonts.js';
import {
  BASE_COLOURS,
  CLIMATE_COLOURS,
  ELEVATION_COLOURS,
  ISLAND_DOT,
  MAP_COLOURS,
  POPULATION_LEGEND_RAMP,
  VEGETATION_COLOURS,
} from './palette.js';
import { thematicLayer, type CitySymbol, type Prim, type Scene, type VisibleLayers } from './scene.js';
import { LAYER_META } from '../../shared/layers.js';
import { normaliseHexDimensions, politySurfaceAreas } from '../../shared/surfaceArea.js';
import {
  BASE_GEO_VALUES,
  CLIMATE_VALUES,
  ELEVATION_VALUES,
  LAYER_ORDER,
  VEGETATION_GROUPS,
  type Elevation,
  type LayerId,
  type MapState,
  type VegetationGroup,
} from '../../shared/types.js';

export interface LegendOptions {
  /** Layers left out of the legend even though they are drawn on the map. */
  exclude: LayerId[];
  /** List only values that occur on the map, rather than every value the layer can take. */
  onlyUsed: boolean;
  /** Append each polity's land area to its entry. */
  polityAreas: boolean;
  /** Head the legend with the map's name. */
  title: boolean;
}

export const DEFAULT_LEGEND_OPTIONS: LegendOptions = {
  exclude: [],
  onlyUsed: true,
  polityAreas: false,
  title: true,
};

export type LegendSwatch =
  | { kind: 'fill'; colour: string }
  | { kind: 'island' }
  | { kind: 'line'; colour: string; width: number }
  | { kind: 'coast' }
  | { kind: 'city'; symbol: CitySymbol; onRiver: boolean }
  | { kind: 'contour'; marks: number; flat: boolean }
  | { kind: 'ramp' };

export interface LegendEntry {
  swatch: LegendSwatch;
  label: string;
}

export interface LegendSection {
  id: LayerId;
  title: string;
  entries: LegendEntry[];
}

const CITY_ENTRIES: Array<{ symbol: CitySymbol; label: string }> = [
  { symbol: 'village', label: 'Village (10,000 or fewer)' },
  { symbol: 'town', label: 'Town (10,000 to 50,000)' },
  { symbol: 'city', label: 'City (50,000 to 250,000)' },
  { symbol: 'metropolis', label: 'Metropolis (over 250,000)' },
];

/** How many contour marks the scene draws for each elevation, kept in step with buildScene. */
const CONTOUR_MARKS: Record<Elevation, number> = {
  Lowland: 0, Rolling: 1, Hills: 2, Highland: 3, Mountains: 4, Plateau: 2,
};

function symbolForPopulation(population: number): CitySymbol {
  if (population <= 10_000) return 'village';
  if (population <= 50_000) return 'town';
  if (population <= 250_000) return 'city';
  return 'metropolis';
}

/**
 * The layers that can appear in a legend for this view, in layer order. This is
 * what the export UI offers as checkboxes, so it never offers a layer that would
 * produce an empty section.
 */
export function legendLayers(
  map: MapState,
  visible: VisibleLayers,
  elevationStyle: 'colour' | 'contours' = 'colour',
): LayerId[] {
  const thematic = thematicLayer(map, visible, elevationStyle);
  return LAYER_ORDER.filter((id) => {
    if (!visible[id] || !map.layers[id].data) return false;
    if (id === 'elevation') return thematic === 'elevation' || elevationStyle === 'contours';
    if (id === 'climate' || id === 'vegetation') return thematic === id;
    return true;
  });
}

function usedValues<T>(data: ReadonlyArray<T | null> | null | undefined): Set<T> {
  const set = new Set<T>();
  for (const v of data ?? []) if (v !== null && v !== undefined) set.add(v);
  return set;
}

export function legendSections(
  map: MapState,
  visible: VisibleLayers,
  elevationStyle: 'colour' | 'contours',
  options: LegendOptions,
): LegendSection[] {
  const sections: LegendSection[] = [];
  const keep = <T>(all: readonly T[], used: Set<T>) =>
    options.onlyUsed ? all.filter((v) => used.has(v)) : [...all];

  for (const id of legendLayers(map, visible, elevationStyle)) {
    if (options.exclude.includes(id)) continue;
    const title = LAYER_META[id].label;
    let entries: LegendEntry[] = [];

    switch (id) {
      case 'base':
        entries = keep(BASE_GEO_VALUES, usedValues(map.layers.base.data)).map((v) =>
          v === 'Island'
            ? { swatch: { kind: 'island' }, label: 'Island' }
            : { swatch: { kind: 'fill', colour: BASE_COLOURS[v] }, label: v },
        );
        break;
      case 'elevation':
        entries = keep(ELEVATION_VALUES, usedValues(map.layers.elevation.data)).map((v) => ({
          swatch:
            elevationStyle === 'contours'
              ? { kind: 'contour', marks: CONTOUR_MARKS[v], flat: v === 'Plateau' }
              : { kind: 'fill', colour: ELEVATION_COLOURS[v] },
          label: v,
        }));
        break;
      case 'climate':
        entries = keep(CLIMATE_VALUES, usedValues(map.layers.climate.data)).map((v) => ({
          swatch: { kind: 'fill', colour: CLIMATE_COLOURS[v] },
          label: v,
        }));
        break;
      case 'vegetation': {
        const used = usedValues(map.layers.vegetation.data);
        for (const group of Object.keys(VEGETATION_GROUPS) as VegetationGroup[]) {
          for (const v of keep(VEGETATION_GROUPS[group], used)) {
            entries.push({ swatch: { kind: 'fill', colour: VEGETATION_COLOURS[v] }, label: v });
          }
        }
        break;
      }
      case 'rivers': {
        const segments = (map.layers.rivers.data?.rivers ?? []).flatMap((r) => r.segments);
        if (!options.onlyUsed || segments.some((s) => s.navigable)) {
          entries.push({ swatch: { kind: 'line', colour: MAP_COLOURS.river, width: 3 }, label: 'Navigable river' });
        }
        if (!options.onlyUsed || segments.some((s) => !s.navigable)) {
          entries.push({
            swatch: { kind: 'line', colour: MAP_COLOURS.riverNonNavigable, width: 1.6 },
            label: 'Non-navigable river',
          });
        }
        break;
      }
      case 'cities': {
        const cities = map.layers.cities.data?.cities ?? [];
        const used = new Set(cities.map((c) => symbolForPopulation(c.population)));
        for (const { symbol, label } of CITY_ENTRIES) {
          if (!options.onlyUsed || used.has(symbol)) {
            entries.push({ swatch: { kind: 'city', symbol, onRiver: false }, label });
          }
        }
        if (!options.onlyUsed || cities.some((c) => c.onRiver)) {
          entries.push({ swatch: { kind: 'city', symbol: 'village', onRiver: true }, label: 'Blue centre: on a river' });
        }
        if (!options.onlyUsed || cities.some((c) => c.coastalEdges.length > 0)) {
          entries.push({ swatch: { kind: 'coast' }, label: 'Dashed edge: borders sea or lake' });
        }
        break;
      }
      case 'polities': {
        const data = map.layers.polities.data;
        const base = map.layers.base.data;
        const dimensions = normaliseHexDimensions(map.hexDimensions);
        const areas = options.polityAreas && data && base
          ? politySurfaceAreas(base, data, dimensions)
          : null;
        const owned = usedValues(data?.owner);
        for (const p of data?.polities ?? []) {
          if (options.onlyUsed && !owned.has(p.id)) continue;
          const area = areas
            ? ` - ${(areas.get(p.id) ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${dimensions.unit}²`
            : '';
          entries.push({ swatch: { kind: 'fill', colour: p.colour }, label: `${p.name}${area}` });
        }
        break;
      }
      case 'population': {
        const values = (map.layers.population.data ?? []).filter(
          (v): v is number => v !== null && v !== undefined,
        );
        const max = values.length > 0 ? Math.max(...values) : 0;
        entries.push({
          swatch: { kind: 'ramp' },
          label: `0 to ${max.toLocaleString()} per hex (log scale)`,
        });
        break;
      }
    }

    if (entries.length > 0) sections.push({ id, title, entries });
  }
  return sections;
}

// --- layout --------------------------------------------------------------------

const PANEL = {
  paper: '#f6f1e4',
  ink: '#14100c',
  edge: 'rgba(20,16,12,0.45)',
};

/** Everything is expressed in units of `k`, so the legend scales with the hex size. */
function metrics(k: number) {
  return {
    k,
    pad: 16 * k,
    body: 13 * k,
    head: 13 * k,
    title: 18 * k,
    row: 22 * k,
    headRow: 28 * k,
    sectionGap: 8 * k,
    swatchW: 22 * k,
    swatchH: 14 * k,
    gap: 9 * k,
    columnGap: 24 * k,
    titleBlock: 34 * k,
  };
}

function swatchPrims(swatch: LegendSwatch, x: number, cy: number, m: ReturnType<typeof metrics>): Prim[] {
  const { k, swatchW: w, swatchH: h } = m;
  const box = (fill: string): Prim => ({
    kind: 'polygon',
    points: [
      { x, y: cy - h / 2 },
      { x: x + w, y: cy - h / 2 },
      { x: x + w, y: cy + h / 2 },
      { x, y: cy + h / 2 },
    ],
    fill,
    stroke: PANEL.edge,
    strokeWidth: Math.max(0.6, 0.8 * k),
  });
  const cx = x + w / 2;

  switch (swatch.kind) {
    case 'fill':
      return [box(swatch.colour)];
    case 'island':
      return [box(BASE_COLOURS.Island), { kind: 'circle', c: { x: cx, y: cy }, r: 4.6 * k, fill: ISLAND_DOT }];
    case 'line':
      return [{
        kind: 'polyline',
        points: [{ x: x + 1.5 * k, y: cy }, { x: x + w - 1.5 * k, y: cy }],
        stroke: swatch.colour,
        strokeWidth: swatch.width * k,
        round: true,
      }];
    case 'coast':
      return [box(BASE_COLOURS.Sea), {
        kind: 'polyline',
        points: [{ x: x + 2 * k, y: cy }, { x: x + w - 2 * k, y: cy }],
        stroke: MAP_COLOURS.coastMark,
        strokeWidth: 1.6 * k,
        dash: [4 * k, 3 * k],
      }];
    case 'city':
      return [{ kind: 'city', c: { x: cx, y: cy }, r: 8 * k, onRiver: swatch.onRiver, symbol: swatch.symbol }];
    case 'contour': {
      const prims: Prim[] = [box(ELEVATION_COLOURS.Rolling)];
      for (let mark = 0; mark < swatch.marks; mark++) {
        const half = (4.2 + mark * 2) * k;
        const y = cy + (4 - mark * 2.3) * k;
        prims.push({
          kind: 'polyline',
          points: swatch.flat
            ? [{ x: cx - half, y }, { x: cx + half, y }]
            : [{ x: cx - half, y }, { x: cx, y: y - 2.6 * k }, { x: cx + half, y }],
          stroke: MAP_COLOURS.elevationContour,
          strokeWidth: 1.1 * k,
          round: true,
        });
      }
      return prims;
    }
    case 'ramp': {
      const cell = w / POPULATION_LEGEND_RAMP.length;
      return POPULATION_LEGEND_RAMP.map((fill, i): Prim => ({
        kind: 'polygon',
        points: [
          { x: x + i * cell, y: cy - h / 2 },
          { x: x + (i + 1) * cell, y: cy - h / 2 },
          { x: x + (i + 1) * cell, y: cy + h / 2 },
          { x: x + i * cell, y: cy + h / 2 },
        ],
        fill,
        stroke: i === 0 || i === POPULATION_LEGEND_RAMP.length - 1 ? PANEL.edge : undefined,
        strokeWidth: Math.max(0.6, 0.8 * k),
      }));
    }
  }
}

type Row =
  | { kind: 'heading'; text: string }
  | { kind: 'entry'; entry: LegendEntry }
  | { kind: 'gap' };

/**
 * Pack sections into columns no taller than `limit`. A section is never left with
 * its heading stranded at the bottom of a column, and one that has to continue
 * into the next column repeats its heading so each column reads on its own.
 */
function flow(sections: LegendSection[], limit: number, m: ReturnType<typeof metrics>): Row[][] {
  const columns: Row[][] = [[]];
  let height = 0;
  const startColumn = () => {
    columns.push([]);
    height = 0;
  };
  const current = () => columns[columns.length - 1]!;

  for (const section of sections) {
    const gap = height > 0 ? m.sectionGap : 0;
    if (height > 0 && height + gap + m.headRow + m.row > limit) startColumn();
    else if (gap > 0) {
      current().push({ kind: 'gap' });
      height += gap;
    }
    current().push({ kind: 'heading', text: section.title });
    height += m.headRow;
    for (const entry of section.entries) {
      if (height + m.row > limit && height > m.headRow) {
        startColumn();
        current().push({ kind: 'heading', text: `${section.title} (continued)` });
        height += m.headRow;
      }
      current().push({ kind: 'entry', entry });
      height += m.row;
    }
  }
  return columns.filter((c) => c.length > 0);
}

/**
 * Widen `scene` with a legend panel on its right edge. Returns the scene
 * unchanged when there is nothing to say.
 */
export function appendLegend(
  scene: Scene,
  sections: LegendSection[],
  title: string | null,
  size: number,
): Scene {
  if (sections.length === 0) return scene;
  const m = metrics(Math.max(0.5, size / 32));
  const titleBlock = title ? m.titleBlock : 0;
  // Columns are as tall as the map, but never so short that a long list becomes
  // a ribbon of tiny columns.
  const limit = Math.max(scene.height - 2 * m.pad - titleBlock, 10 * m.row);
  const columns = flow(sections, limit, m);

  const textWidth = (text: string, px: number, weight: number) => fantasyTextEm(text, weight) * px;
  const widths = columns.map((rows) =>
    Math.max(
      ...rows.map((r) =>
        r.kind === 'heading'
          ? textWidth(r.text, m.head, 700)
          : r.kind === 'entry'
            ? m.swatchW + m.gap + textWidth(r.entry.label, m.body, 500)
            : 0,
      ),
    ),
  );
  const columnsWidth = widths.reduce((a, b) => a + b, 0) + m.columnGap * (columns.length - 1);
  const titleWidth = title ? textWidth(title, m.title, 700) : 0;
  const panelWidth = Math.ceil(2 * m.pad + Math.max(columnsWidth, titleWidth));
  const columnsHeight = Math.max(
    ...columns.map((rows) =>
      rows.reduce((h, r) => h + (r.kind === 'heading' ? m.headRow : r.kind === 'entry' ? m.row : m.sectionGap), 0),
    ),
  );
  const panelHeight = 2 * m.pad + titleBlock + columnsHeight;

  const width = scene.width + panelWidth;
  const height = Math.max(scene.height, panelHeight);
  const x0 = scene.width;
  const prims: Prim[] = [...scene.prims];

  prims.push({
    kind: 'polygon',
    points: [
      { x: x0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: x0, y: height },
    ],
    fill: PANEL.paper,
  });
  prims.push({
    kind: 'polyline',
    points: [{ x: x0, y: 0 }, { x: x0, y: height }],
    stroke: PANEL.edge,
    strokeWidth: Math.max(1, m.k),
  });

  if (title) {
    prims.push({
      kind: 'text',
      at: { x: x0 + m.pad, y: m.pad + m.title / 2 },
      text: title,
      size: m.title,
      fill: PANEL.ink,
      weight: 700,
      anchor: 'start',
      fantasy: true,
    });
  }

  let x = x0 + m.pad;
  columns.forEach((rows, ci) => {
    let y = m.pad + titleBlock;
    for (const row of rows) {
      if (row.kind === 'gap') {
        y += m.sectionGap;
      } else if (row.kind === 'heading') {
        prims.push({
          kind: 'text',
          at: { x, y: y + m.headRow / 2 },
          text: row.text,
          size: m.head,
          fill: PANEL.ink,
          weight: 700,
          anchor: 'start',
          fantasy: true,
        });
        y += m.headRow;
      } else {
        const cy = y + m.row / 2;
        prims.push(...swatchPrims(row.entry.swatch, x, cy, m));
        prims.push({
          kind: 'text',
          at: { x: x + m.swatchW + m.gap, y: cy },
          text: row.entry.label,
          size: m.body,
          fill: PANEL.ink,
          weight: 500,
          anchor: 'start',
          fantasy: true,
        });
        y += m.row;
      }
    }
    x += widths[ci]! + m.columnGap;
  });

  return { ...scene, width, height, prims };
}
