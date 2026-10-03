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

import type { Point } from '../../shared/hex.js';
import { capitalCrown, cityMarker, iconReach, riverBisects, symbolMarker, type CityMarkerSet } from './cityMarkers.js';
import { pressIcon, SET_IN } from './riverCity.js';
import { fantasyTextEm } from './fonts.js';
import {
  BASE_COLOURS,
  CLIMATE_COLOURS,
  ELEVATION_COLOURS,
  MAP_COLOURS,
  POPULATION_LEGEND_RAMP,
  VEGETATION_COLOURS,
} from './palette.js';
import { CLASSIC_STYLE, type ElevationStyle, type MapStyle } from './styles.js';
import { polityDisplayColours } from './hierarchy.js';
import { descendantsOf } from '../../shared/polityTree.js';
import { thematicLayer, withLandOf, type CitySymbol, type Prim, type Scene, type VisibleLayers } from './scene.js';
import { LAYER_META } from '../../shared/layers.js';
import { formatLength, riverLength } from '../../shared/riverLength.js';
import { riverLabel } from '../../shared/riverEdit.js';
import { formatArea, normaliseHexDimensions, politySurfaceAreas } from '../../shared/surfaceArea.js';
import {
  BASE_GEO_VALUES,
  isIslandType,
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
  /** List every river with its length under the river symbols. */
  riverLengths: boolean;
  /** Head the legend with the map's name. */
  title: boolean;
}

export const DEFAULT_LEGEND_OPTIONS: LegendOptions = {
  exclude: [],
  onlyUsed: true,
  polityAreas: false,
  riverLengths: false,
  title: true,
};

export type LegendSwatch =
  | { kind: 'fill'; colour: string }
  | { kind: 'island'; sea: string; land: string; variant: 'islands' | 'mainland' | 'isthmus' | 'strait' }
  | { kind: 'line'; colour: string; width: number }
  | { kind: 'coast' }
  | { kind: 'city'; symbol: CitySymbol; onRiver: boolean; set?: CityMarkerSet; ink?: string; paper?: string; river?: string; bank?: string; capital?: boolean }
  | { kind: 'contour'; marks: number; flat: boolean }
  | { kind: 'ramp' };

export interface LegendEntry {
  swatch: LegendSwatch;
  label: string;
  /** Nesting level: a polity that is part of another is listed under it, indented. */
  indent?: number;
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
  elevationStyle: ElevationStyle = 'colour',
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
  elevationStyle: ElevationStyle,
  options: LegendOptions,
  style: MapStyle = CLASSIC_STYLE,
): LegendSection[] {
  const { palette } = style;
  const baseColour: Record<string, string> = {
    Land: palette.land,
    'Coastal Land': style.knobs.land === 'uniform' ? palette.land : palette.coastalLand,
    Sea: palette.sea,
    Lake: palette.lake,
    Glacier: palette.ice,
    'Sea Ice': palette.seaIce,
  };
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
          isIslandType(v) || v === 'Isthmus' || v === 'Strait'
            ? {
                swatch: {
                  kind: 'island',
                  sea: palette.sea,
                  land: style.knobs.land === 'uniform' ? palette.land : palette.island,
                  variant: v === 'Mainland and islands' ? 'mainland' : v === 'Isthmus' ? 'isthmus' : v === 'Strait' ? 'strait' : 'islands',
                },
                label: v,
              }
            : { swatch: { kind: 'fill', colour: baseColour[v] ?? BASE_COLOURS[v] }, label: v },
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
          entries.push({ swatch: { kind: 'line', colour: palette.river, width: 3 }, label: 'Navigable river' });
        }
        if (!options.onlyUsed || segments.some((s) => !s.navigable)) {
          entries.push({
            swatch: {
              kind: 'line',
              colour: style.knobs.rivers === 'tapered' ? palette.river : palette.riverNonNavigable,
              width: 1.6,
            },
            label: 'Non-navigable river',
          });
        }
        if (options.riverLengths) {
          const dims = normaliseHexDimensions(map.hexDimensions);
          for (const river of map.layers.rivers.data?.rivers ?? []) {
            entries.push({
              swatch: { kind: 'line', colour: palette.river, width: 1.6 },
              label: `${riverLabel(river, map.layers.rivers.data?.rivers ?? [])} - ${formatLength(riverLength(river, dims), dims.unit, dims.lengthRounding)}`,
            });
          }
        }
        break;
      }
      case 'cities': {
        const cities = map.layers.cities.data?.cities ?? [];
        const used = new Set(cities.map((c) => symbolForPopulation(c.population)));
        for (const { symbol, label } of CITY_ENTRIES) {
          if (!options.onlyUsed || used.has(symbol)) {
            entries.push({
              swatch: { kind: 'city', symbol, onRiver: false, set: style.knobs.cityMarkers, ink: style.palette.cityFill, paper: style.palette.cityRing },
              label,
            });
          }
        }
        if (!options.onlyUsed || cities.some((c) => c.capital)) {
          entries.push({
            swatch: { kind: 'city', symbol: 'town', onRiver: false, set: style.knobs.cityMarkers, ink: style.palette.cityFill, paper: style.palette.cityRing, capital: true },
            label: 'Crown: capital of a realm',
          });
        }
        // A river city stands on its river's bank; the largest sit astride it.
        if (!options.onlyUsed || cities.some((c) => c.onRiver)) {
          entries.push({
            swatch: { kind: 'city', symbol: 'town', onRiver: true, set: style.knobs.cityMarkers, ink: style.palette.cityFill, paper: style.palette.cityRing, river: style.palette.river, bank: style.palette.riverBank },
            label: 'On a river (the icon is shaped by it)',
          });
        }
        if (style.knobs.cityCoastMarks && (!options.onlyUsed || cities.some((c) => c.coastalEdges.length > 0))) {
          entries.push({ swatch: { kind: 'coast' }, label: 'Dashed edge: borders sea or lake' });
        }
        break;
      }
      case 'polities': {
        const data = map.layers.polities.data;
        const base = map.layers.base.data;
        const dimensions = normaliseHexDimensions(map.hexDimensions);
        const areas = options.polityAreas && data && base
          ? politySurfaceAreas(base, data, dimensions, map.islandSpecs, map.hexShapes, map.cols)
          : null;
        const owned = usedValues(data?.owner);
        const all = data?.polities ?? [];
        const colours = polityDisplayColours(all, style.knobs.subPolities);
        // A realm's area is the sum of its own hexes and all its parts'.
        const treeArea = (id: string) =>
          [...descendantsOf(all, id)].reduce((sum, d) => sum + (areas?.get(d) ?? 0), 0);
        const inUse = (id: string) => [...descendantsOf(all, id)].some((d) => owned.has(d));
        const visit = (p: (typeof all)[number], depth: number) => {
          if (options.onlyUsed && !inUse(p.id)) return;
          const area = areas
            ? ` - ${formatArea(treeArea(p.id), dimensions.unit, dimensions.areaRounding)}`
            : '';
          entries.push({ swatch: { kind: 'fill', colour: colours.get(p.id) ?? p.colour }, label: `${p.name}${area}`, indent: depth });
          for (const child of all.filter((q) => q.parentId === p.id)) visit(child, depth + 1);
        };
        for (const p of all.filter((q) => !q.parentId || !all.some((r) => r.id === q.parentId))) visit(p, 0);
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
    {
      const dot = (x0: number, y0: number, r: number): Prim => ({ kind: 'circle', c: { x: x0, y: y0 }, r, fill: swatch.land });
      // A band across the swatch, as a polygon from x0 to x1 (full height) or y0 to y1 (full width).
      const band = (fill: string, x0: number, x1: number, y0: number, y1: number): Prim => ({
        kind: 'polygon',
        points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
        fill,
      });
      const top = cy - h / 2;
      switch (swatch.variant) {
        case 'mainland':
          return [box(swatch.sea), band(swatch.land, x, x + w * 0.4, top, top + h), dot(cx + 3 * k, cy - 2.5 * k, 2.2 * k), dot(cx + 6.5 * k, cy + 3 * k, 2 * k)];
        case 'isthmus':
          return [box(swatch.sea), band(swatch.land, x, x + w, cy - 2.4 * k, cy + 2.4 * k)];
        case 'strait':
          return [box(swatch.land), band(swatch.sea, x, x + w, cy - 2.4 * k, cy + 2.4 * k)];
        default:
          return [box(swatch.sea), dot(cx - 2 * k, cy, 4.6 * k), dot(cx + 6 * k, cy - 3 * k, 1.8 * k)];
      }
    }
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
    case 'city': {
      const ink = swatch.ink ?? MAP_COLOURS.city;
      const paper = swatch.paper ?? MAP_COLOURS.cityRing;
      const set = swatch.set ?? 'symbols';
      // A capital's swatch sits lower, to leave room for its crown. A river city stands on the
      // bank of a river that runs across the swatch, as it does on the map.
      const R = swatch.capital ? 6 * k : swatch.onRiver ? 6 * k : 8 * k;
      const riverWidth = 3 * k;
      // A river city is set into the bank of a river running across the swatch and pressed against it, as on the map.
      const reach = iconReach(set, swatch.symbol, R);
      const setIn = swatch.onRiver && !riverBisects(swatch.symbol) ? riverWidth / 2 + reach * SET_IN : 0;
      const at = { x: cx, y: cy + (swatch.capital ? 3 * k : 0) - setIn / 2 };
      const crown = swatch.capital ? capitalCrown(set, swatch.symbol, at, R, { ink, paper }) : [];
      const riverY = at.y + setIn;
      const course: Point[] = [];
      for (let px = x + 1.5 * k; px <= x + w - 1.5 * k + 1e-6; px += 2 * k) course.push({ x: px, y: riverY });
      const water: Prim[] = swatch.onRiver
        ? [
            { kind: 'polyline', points: course, stroke: swatch.bank ?? swatch.river ?? MAP_COLOURS.river, strokeWidth: riverWidth + 1.2 * k, round: true },
            { kind: 'polyline', points: course, stroke: swatch.river ?? MAP_COLOURS.river, strokeWidth: riverWidth, round: true },
          ]
        : [];
      const colours = { ink, paper, river: swatch.river ?? MAP_COLOURS.river };
      const site = { x: at.x, y: at.y + (set === 'illustrated' ? 2 * k : 0) };
      const plain: Prim[] = set !== 'symbols'
        ? cityMarker(set, swatch.symbol, site, R, colours, () => 0.5)
        : swatch.onRiver
          ? symbolMarker(swatch.symbol, at, R, colours, true)
          : [{ kind: 'city', c: at, r: R, onRiver: false, symbol: swatch.symbol }];
      const marker = swatch.onRiver ? pressIcon(plain, { line: course, widths: course.map(() => riverWidth) }, 0.9 * k, 0.5 * k, riverBisects(swatch.symbol) ? undefined : at) : plain;
      return [...water, ...marker, ...crown];
    }
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
            ? (r.entry.indent ?? 0) * m.gap * 1.6 + m.swatchW + m.gap + textWidth(r.entry.label, m.body, 500)
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
        const dx = (row.entry.indent ?? 0) * m.gap * 1.6;
        prims.push(...swatchPrims(row.entry.swatch, x + dx, cy, m));
        prims.push({
          kind: 'text',
          at: { x: x + dx + m.swatchW + m.gap, y: cy },
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

  return withLandOf({ ...scene, width, height, prims }, scene);
}
