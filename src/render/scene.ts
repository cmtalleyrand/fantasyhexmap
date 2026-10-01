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
      smooth?: boolean;
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
      maxWidth?: number;
      fantasy?: boolean;
      rotation?: number;
    }
  | {
      kind: 'city';
      c: Point;
      r: number;
      onRiver: boolean;
      symbol: CitySymbol;
    };

export type CitySymbol = 'village' | 'town' | 'city' | 'metropolis';

export function citySymbolForPopulation(population: number): CitySymbol {
  if (population <= 10_000) return 'village';
  if (population <= 50_000) return 'town';
  if (population <= 250_000) return 'city';
  return 'metropolis';
}

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
  elevationStyle?: 'colour' | 'contours';
  /** Screen-only decoration; omitted from exports. */
  selection?: Set<number> | null;
  hover?: number | null;
  /** Screen-only: the river being edited, drawn with a halo and a handle on each hex. */
  highlightRiver?: string | null;
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

interface LabelBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function labelBox(at: Point, width: number, height: number, rotation: number): LabelBox {
  const c = Math.abs(Math.cos(rotation));
  const s = Math.abs(Math.sin(rotation));
  const halfWidth = (width * c + height * s) / 2;
  const halfHeight = (width * s + height * c) / 2;
  return {
    left: at.x - halfWidth,
    right: at.x + halfWidth,
    top: at.y - halfHeight,
    bottom: at.y + halfHeight,
  };
}

export function buildScene(map: MapState, opts: SceneOptions): Scene {
  const { cols, rows, layers } = map;
  const { size } = opts;
  const { width, height } = gridPixelSize(cols, rows, size);
  const prims: Prim[] = [];

  const base = opts.visible.base ? layers.base.data : null;
  const elevationStyle = opts.elevationStyle ?? 'colour';
  const thematic = FILL_PRECEDENCE.find(
    (id) => opts.visible[id] && layers[id].data && (id !== 'elevation' || elevationStyle === 'colour'),
  ) ?? null;

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

      if (elevationStyle === 'contours' && opts.visible.elevation) {
        const elevation = layers.elevation.data?.[i];
        if (elevation) {
          const centre = hexCenter(col, row, size);
          const levels: Record<Elevation, number> = {
            Lowland: 0, Rolling: 1, Hills: 2, Highland: 3, Mountains: 4, Plateau: 2,
          };
          const count = levels[elevation];
          for (let mark = 0; mark < count; mark++) {
            const halfWidth = size * (0.2 + mark * 0.1);
            const y = centre.y + size * (0.25 - mark * 0.14);
            const points = elevation === 'Plateau'
              ? [{ x: centre.x - halfWidth, y }, { x: centre.x + halfWidth, y }]
              : [{ x: centre.x - halfWidth, y }, { x: centre.x, y: y - size * 0.15 }, { x: centre.x + halfWidth, y }];
            prims.push({
              kind: 'polyline',
              points,
              stroke: MAP_COLOURS.elevationContour,
              strokeWidth: Math.max(0.8, size * 0.045),
              round: true,
            });
          }
        }
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
            // Polity colours are categorical data, not a tint. An opaque fill
            // keeps a realm's colour invariant when substrate layers change.
            fill: polityColour.get(owner) ?? '#777777',
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
    const picked = opts.highlightRiver ? rivers.rivers.find((r) => r.id === opts.highlightRiver) : null;
    if (picked) {
      const halo: Point[] = [];
      for (const seg of picked.segments) {
        if (seg.entryEdge !== null) halo.push(hexEdgeMidpoint(seg.col, seg.row, seg.entryEdge, size));
        halo.push(hexCenter(seg.col, seg.row, size));
        if (seg.exitEdge !== null) halo.push(hexEdgeMidpoint(seg.col, seg.row, seg.exitEdge, size));
      }
      prims.push({
        kind: 'polyline',
        points: halo,
        stroke: withAlpha(MAP_COLOURS.selection, 0.55),
        strokeWidth: Math.max(5, size * 0.42),
        round: true,
        smooth: true,
      });
    }
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
            strokeWidth: runNavigable ? Math.max(2.5, size * 0.2125) : Math.max(1.25, size * 0.1125),
            round: true,
            smooth: true,
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

  if (rivers && opts.highlightRiver) {
    const picked = rivers.rivers.find((r) => r.id === opts.highlightRiver);
    for (const seg of picked?.segments ?? []) {
      prims.push({
        kind: 'circle',
        c: hexCenter(seg.col, seg.row, size),
        r: Math.max(2.5, size * 0.13),
        fill: '#ffffff',
        stroke: MAP_COLOURS.selection,
        strokeWidth: Math.max(1.5, size * 0.07),
      });
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
        kind: 'city',
        c,
        r,
        onRiver: city.onRiver,
        symbol: citySymbolForPopulation(city.population),
      });
    }
  }

  // --- labels --------------------------------------------------------------
  if (opts.labels) {
    if (polities) {
      const occupied: LabelBox[] = [];
      const territorySize = new Map<string, number>();
      for (const owner of polities.owner) {
        if (owner) territorySize.set(owner, (territorySize.get(owner) ?? 0) + 1);
      }
      const bySize = [...polities.polities].sort(
        (a, b) => (territorySize.get(b.id) ?? 0) - (territorySize.get(a.id) ?? 0),
      );
      for (const polity of bySize) {
        const owned: number[] = [];
        polities.owner.forEach((id, i) => {
          if (id === polity.id) owned.push(i);
        });
        // Tiny territories are keyed by colour in the legend instead. A name
        // cannot fit legibly inside one to three hexes at any useful zoom.
        if (owned.length <= 3) continue;
        const centres = owned.map((i) => hexCenter(i % cols, Math.floor(i / cols), size));
        const mean = centres.reduce((sum, c) => ({ x: sum.x + c.x, y: sum.y + c.y }), { x: 0, y: 0 });
        mean.x /= centres.length;
        mean.y /= centres.length;
        let xx = 0;
        let yy = 0;
        let xy = 0;
        for (const c of centres) {
          const dx = c.x - mean.x;
          const dy = c.y - mean.y;
          xx += dx * dx;
          yy += dy * dy;
          xy += dx * dy;
        }
        let rotation = Math.atan2(2 * xy, xx - yy) / 2;
        if (Math.cos(rotation) < 0) rotation += Math.PI;
        // Cartographic names should read primarily left-to-right. Retain a
        // territory's broad direction, but never rotate beyond 30 degrees and
        // avoid small, visually accidental variations by snapping to 15 degrees.
        rotation = Math.max(-Math.PI / 6, Math.min(Math.PI / 6, rotation));
        rotation = Math.round(rotation / (Math.PI / 12)) * (Math.PI / 12);
        const along = centres.map((c) => (c.x - mean.x) * Math.cos(rotation) + (c.y - mean.y) * Math.sin(rotation));
        const across = centres.map((c) => -(c.x - mean.x) * Math.sin(rotation) + (c.y - mean.y) * Math.cos(rotation));
        const spanAlong = Math.max(...along) - Math.min(...along) + size * 1.5;
        const spanAcross = Math.max(...across) - Math.min(...across) + size * 1.5;
        const text = (polity.shortName?.trim() || polity.name).toUpperCase();
        // Hex area is proportional to size², so a linear dimension such as
        // type size grows with sqrt(hex count). The projected spans below then
        // cap that area-derived target for long or unusually narrow realms.
        const idealSize = size * 0.28 * Math.sqrt(owned.length);
        let fittedSize = Math.min(idealSize, spanAcross * 0.48, spanAlong / Math.max(1, text.length * 0.58));
        const candidates = [...centres].sort((a, b) =>
          ((a.x - mean.x) ** 2 + (a.y - mean.y) ** 2) - ((b.x - mean.x) ** 2 + (b.y - mean.y) ** 2),
        );
        let placement: { at: Point; box: LabelBox; size: number } | null = null;
        // Try progressively smaller type at central owned hexes. This is a
        // logarithmic number of font sizes times the territory area.
        while (fittedSize >= 6 && !placement) {
          const width = text.length * fittedSize * 0.58;
          const height = fittedSize * 1.12;
          for (const at of candidates) {
            const box = labelBox(at, width, height, rotation);
            if (!occupied.some((other) => overlaps(box, other))) {
              placement = { at, box, size: fittedSize };
              break;
            }
          }
          fittedSize *= 0.88;
        }
        if (!placement) continue;
        occupied.push(placement.box);
        prims.push({
          kind: 'text',
          at: placement.at,
          text,
          size: placement.size,
          fill: MAP_COLOURS.label,
          weight: 600,
          anchor: 'middle',
          fantasy: true,
          rotation,
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
