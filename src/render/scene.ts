/**
 * The scene model.
 *
 * Everything that draws the map - the interactive canvas, the PNG export and the
 * SVG export - consumes the same list of primitives produced here. That is the
 * whole point: the vector file and the bitmap cannot drift from what is on
 * screen, because none of them knows how to draw a hex map, only how to draw a
 * polygon, a polyline, a circle and a label.
 */

import {
  hexCenter,
  hexCorners,
  hexEdgeMidpoint,
  hexEdgePoints,
  hexIndex,
  gridPixelSize,
  inBounds,
  neighbourOf,
  type Point,
} from '../../shared/hex.js';
import {
  LAYER_ORDER,
  type Climate,
  type Elevation,
  type LayerId,
  type MapState,
  type Vegetation,
} from '../../shared/types.js';
import {
  BASE_COLOURS,
  CLIMATE_COLOURS,
  ELEVATION_COLOURS,
  ISLAND_DOT,
  MAP_COLOURS,
  VEGETATION_COLOURS,
  contrastInk,
  populationColour,
  withAlpha,
} from './palette.js';

export type Prim =
  | {
      kind: 'polygon';
      points: Point[];
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
    }
  | {
      kind: 'polyline';
      points: Point[];
      stroke: string;
      strokeWidth: number;
      dash?: number[];
      round?: boolean;
    }
  | {
      kind: 'circle';
      c: Point;
      r: number;
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
    }
  | {
      kind: 'text';
      at: Point;
      text: string;
      size: number;
      fill: string;
      halo?: string;
      weight?: number;
      anchor?: 'start' | 'middle' | 'end';
    };

export interface Scene {
  width: number;
  height: number;
  background: string;
  prims: Prim[];
}

export type VisibleLayers = Record<LayerId, boolean>;

export interface SceneOptions {
  size: number;
  visible: VisibleLayers;
  labels: boolean;
  /** Screen-only decoration; omitted from exports. */
  selection?: Set<number> | null;
  hover?: number | null;
  transparentBackground?: boolean;
}

export function defaultVisibility(): VisibleLayers {
  const v = {} as VisibleLayers;
  for (const id of LAYER_ORDER) v[id] = false;
  v.base = true;
  return v;
}

/** Precedence for the single per-hex fill: the most derived visible layer wins. */
const FILL_PRECEDENCE: LayerId[] = ['vegetation', 'climate', 'elevation'];

export function buildScene(map: MapState, opts: SceneOptions): Scene {
  const { cols, rows, layers } = map;
  const { size } = opts;
  const { width, height } = gridPixelSize(cols, rows, size);
  const prims: Prim[] = [];

  const base = opts.visible.base ? layers.base.data : null;
  const thematic = FILL_PRECEDENCE.find((id) => opts.visible[id] && layers[id].data) ?? null;

  const population = opts.visible.population ? layers.population.data : null;
  const maxPop = population ? Math.max(1, ...population.map((v) => v ?? 0)) : 1;

  const polities = opts.visible.polities ? layers.polities.data : null;
  const polityColour = new Map<string, string>(
    (polities?.polities ?? []).map((p) => [p.id, p.colour]),
  );

  // --- hex fills -----------------------------------------------------------
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = hexIndex(cols, col, row);
      const corners = hexCorners(col, row, size);
      let fill = MAP_COLOURS.emptyHex;

      const baseValue = base ? base[i] : null;
      if (baseValue) fill = BASE_COLOURS[baseValue];

      if (thematic) {
        const value =
          thematic === 'elevation'
            ? layers.elevation.data?.[i] ?? null
            : thematic === 'climate'
              ? layers.climate.data?.[i] ?? null
              : layers.vegetation.data?.[i] ?? null;
        if (value !== null) {
          fill =
            thematic === 'elevation'
              ? ELEVATION_COLOURS[value as Elevation]
              : thematic === 'climate'
                ? CLIMATE_COLOURS[value as Climate]
                : VEGETATION_COLOURS[value as Vegetation];
        } else if (!base) {
          fill = MAP_COLOURS.emptyHex;
        }
      }

      prims.push({
        kind: 'polygon',
        points: corners,
        fill,
        stroke: MAP_COLOURS.hexOutline,
        strokeWidth: Math.max(0.5, size * 0.03),
      });

      if (baseValue === 'Island') {
        const c = hexCenter(col, row, size);
        prims.push({ kind: 'circle', c, r: size * 0.34, fill: ISLAND_DOT });
      }

      if (population) {
        const value = population[i];
        if (value !== null && value !== undefined) {
          prims.push({
            kind: 'polygon',
            points: corners,
            fill: withAlpha(populationColour(value, maxPop), 0.82),
          });
        }
      }

      if (polities) {
        const owner = polities.owner[i];
        if (owner) {
          prims.push({
            kind: 'polygon',
            points: corners,
            fill: withAlpha(polityColour.get(owner) ?? '#888888', 0.3),
          });
        }
      }
    }
  }

  // --- polity borders ------------------------------------------------------
  if (polities) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const owner = polities.owner[hexIndex(cols, col, row)];
        if (!owner) continue;
        const centre = hexCenter(col, row, size);
        for (let e = 0; e < 6; e++) {
          const n = neighbourOf(col, row, e);
          const other = inBounds(cols, rows, n.col, n.row)
            ? polities.owner[hexIndex(cols, n.col, n.row)]
            : null;
          if (other === owner) continue;
          // Each side paints its own half of the border, inset toward its own
          // centre, so a frontier between two realms shows both their colours.
          const inset = (p: Point): Point => ({
            x: p.x + (centre.x - p.x) * 0.1,
            y: p.y + (centre.y - p.y) * 0.1,
          });
          const [a, b] = hexEdgePoints(col, row, e, size);
          prims.push({
            kind: 'polyline',
            points: [inset(a), inset(b)],
            stroke: polityColour.get(owner) ?? '#888888',
            strokeWidth: Math.max(1.5, size * 0.11),
            round: true,
          });
        }
      }
    }
  }

  // --- rivers --------------------------------------------------------------
  const rivers = opts.visible.rivers ? layers.rivers.data : null;
  if (rivers) {
    for (const river of rivers.rivers) {
      // One polyline per run of same-navigability segments, so the change in
      // weight along a river is visible rather than averaged away.
      let run: Point[] = [];
      let runNavigable: boolean | null = null;
      const flush = () => {
        if (run.length > 1) {
          prims.push({
            kind: 'polyline',
            points: run,
            stroke: runNavigable ? MAP_COLOURS.river : MAP_COLOURS.riverNonNavigable,
            strokeWidth: runNavigable ? Math.max(2, size * 0.17) : Math.max(1, size * 0.09),
            round: true,
          });
        }
        run = [];
      };
      for (const seg of river.segments) {
        const centre = hexCenter(seg.col, seg.row, size);
        const points: Point[] = [];
        if (seg.entryEdge !== null) {
          points.push(hexEdgeMidpoint(seg.col, seg.row, seg.entryEdge, size));
        }
        points.push(centre);
        if (seg.exitEdge !== null) {
          points.push(hexEdgeMidpoint(seg.col, seg.row, seg.exitEdge, size));
        }
        if (runNavigable === null) runNavigable = seg.navigable;
        if (seg.navigable !== runNavigable) {
          flush();
          runNavigable = seg.navigable;
          if (seg.entryEdge !== null) {
            run.push(hexEdgeMidpoint(seg.col, seg.row, seg.entryEdge, size));
          }
        }
        for (const p of points) {
          const last = run[run.length - 1];
          if (!last || last.x !== p.x || last.y !== p.y) run.push(p);
        }
      }
      flush();
    }
  }

  // --- cities --------------------------------------------------------------
  const cities = opts.visible.cities ? layers.cities.data : null;
  if (cities) {
    for (const city of cities.cities) {
      const c = hexCenter(city.col, city.row, size);
      const r = Math.max(size * 0.16, Math.min(size * 0.46, size * 0.1 * Math.log10(Math.max(10, city.population))));
      // Mark which edges are coastal, since "coastal" is edge-specific here.
      // Dashed and water-coloured so it never reads as a polity border.
      for (const edge of city.coastalEdges) {
        const [a, b] = hexEdgePoints(city.col, city.row, edge, size);
        prims.push({
          kind: 'polyline',
          points: [a, b],
          stroke: MAP_COLOURS.coastMark,
          strokeWidth: Math.max(1, size * 0.06),
          dash: [size * 0.18, size * 0.14],
        });
      }
      prims.push({
        kind: 'circle',
        c,
        r,
        fill: MAP_COLOURS.city,
        stroke: MAP_COLOURS.cityRing,
        strokeWidth: Math.max(1, size * 0.06),
      });
      if (city.onRiver) {
        prims.push({ kind: 'circle', c, r: r * 0.4, fill: MAP_COLOURS.river });
      }
    }
  }

  // --- labels --------------------------------------------------------------
  if (opts.labels) {
    if (polities) {
      for (const polity of polities.polities) {
        const owned: number[] = [];
        polities.owner.forEach((id, i) => {
          if (id === polity.id) owned.push(i);
        });
        if (owned.length === 0) continue;
        let sx = 0;
        let sy = 0;
        for (const i of owned) {
          const c = hexCenter(i % cols, Math.floor(i / cols), size);
          sx += c.x;
          sy += c.y;
        }
        prims.push({
          kind: 'text',
          at: { x: sx / owned.length, y: sy / owned.length },
          text: polity.name.toUpperCase(),
          size: Math.max(9, size * 0.42),
          fill: contrastInk(polity.colour) === '#14100c' ? '#1b1409' : '#f7f3e7',
          halo: withAlpha(polity.colour, 0.85),
          weight: 700,
          anchor: 'middle',
        });
      }
    }
    if (cities) {
      for (const city of cities.cities) {
        const c = hexCenter(city.col, city.row, size);
        prims.push({
          kind: 'text',
          at: { x: c.x, y: c.y + size * 0.95 },
          text: city.name,
          size: Math.max(8, size * 0.36),
          fill: MAP_COLOURS.label,
          halo: MAP_COLOURS.labelHalo,
          weight: 600,
          anchor: 'middle',
        });
      }
    }
  }

  // --- screen-only decoration ---------------------------------------------
  if (opts.selection) {
    for (const i of opts.selection) {
      if (i < 0 || i >= cols * rows) continue;
      prims.push({
        kind: 'polygon',
        points: hexCorners(i % cols, Math.floor(i / cols), size),
        stroke: MAP_COLOURS.selection,
        strokeWidth: Math.max(2, size * 0.12),
      });
    }
  }
  if (opts.hover !== null && opts.hover !== undefined && opts.hover >= 0) {
    prims.push({
      kind: 'polygon',
      points: hexCorners(opts.hover % cols, Math.floor(opts.hover / cols), size),
      stroke: MAP_COLOURS.hover,
      strokeWidth: Math.max(1.5, size * 0.07),
    });
  }

  return {
    width,
    height,
    background: opts.transparentBackground ? 'transparent' : MAP_COLOURS.paper,
    prims,
  };
}

/** Visibility set for exporting a single layer on its own. */
export function singleLayerVisibility(layer: LayerId): VisibleLayers {
  const v = defaultVisibility();
  for (const id of LAYER_ORDER) v[id] = false;
  v[layer] = true;
  // A layer of land-only values is unreadable without knowing where the land is,
  // so the base geography stays as the substrate for every single-layer export.
  if (layer !== 'base') v.base = true;
  return v;
}
