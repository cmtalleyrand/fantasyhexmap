/**
 * The scene model.
 *
 * Everything that draws the map - the interactive canvas, the PNG export and the
 * SVG export - consumes the same list of primitives produced here. That is the
 * whole point: the vector file and the bitmap cannot drift from what is on
 * screen, because none of them knows how to draw a hex map, only how to draw a
 * polygon, a polyline, a path, a circle and a label.
 *
 * The scene is built in passes, bottom to top: land, water, the water's
 * surface treatment, islands, the corrections that make fills follow a
 * smoothed coast, the grid, the coastline, frontiers, rivers, paper grain,
 * cities and names. How each pass looks is decided by the map style
 * (`styles.ts`); which passes have anything to draw is decided by the data.
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
  isIslandType,
  type BaseGeo,
  type CitiesData,
  type Climate,
  type Elevation,
  type LayerId,
  type MapState,
  type PolitiesData,
  type Vegetation,
} from '../../shared/types.js';
import {
  CLIMATE_COLOURS,
  ELEVATION_COLOURS,
  MAP_COLOURS,
  VEGETATION_COLOURS,
  populationColour,
  withAlpha,
} from './palette.js';
import { placeRangeLabels, placeRiverLabels } from './featureLabels.js';
import {
  LABEL_LINE_EM,
  placePolityLabels,
  type LabelObstacle,
  type PolityLabel,
  type PolityNameMin,
} from './labels.js';
import {
  blobPath,
  circlePath,
  coastalIslandSide,
  coastGeometry,
  hexesPath,
  isletPath,
  sideOf,
  smallLakes,
  type CoastGeometry,
} from './coast.js';
import type { CitySymbol, PathCmd, Prim } from './prims.js';
import { riverCourses, type RiverCourse } from './rivers.js';
import { citySite } from './sites.js';
import { signed, unit } from './seed.js';
import { CLASSIC_STYLE, type MapStyle } from './styles.js';
import { grainTile } from './texture.js';

export type { CitySymbol, PathCmd, Prim } from './prims.js';

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
  /** Name rivers (needs the Rivers layer visible). */
  riverNames?: boolean;
  /** Name mountain ranges (needs the Elevation layer visible). */
  rangeNames?: boolean;
  /** Smallest polity, in hexes, that is named; default 4. */
  polityNames?: PolityNameMin;
  elevationStyle?: 'colour' | 'contours';
  /** Opacity of polity fills, 0-1 (default 1); lower values let terrain show through. */
  polityOpacity?: number;
  /** Draw Coastal Land in the plain Land colour; overrides the style's own choice when set. */
  uniformLand?: boolean;
  /** How the map looks; the Classic hex style when omitted. */
  style?: MapStyle;
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

/**
 * The one layer whose values paint the hex fills, or null. Exported so the legend
 * describes what is actually drawn rather than everything that is switched on.
 */
export function thematicLayer(
  map: MapState,
  visible: VisibleLayers,
  elevationStyle: 'colour' | 'contours' = 'colour',
): LayerId | null {
  return FILL_PRECEDENCE.find(
    (id) => visible[id] && map.layers[id].data && (id !== 'elevation' || elevationStyle === 'colour'),
  ) ?? null;
}

/**
 * Placement is a search over the territory, and the scene is rebuilt whenever
 * a display option changes, so the result is remembered per data identity.
 * Layer edits are immutable (a new `owner` array / cities object each time).
 */
const labelCache = new WeakMap<
  object,
  { cities: object | null; polities: object; key: string; labels: PolityLabel[] }
>();

function cachedPolityLabels(
  data: PolitiesData,
  cities: CitiesData | null,
  cols: number,
  rows: number,
  size: number,
  obstacles: LabelObstacle[],
  minHexes: PolityNameMin | undefined,
): PolityLabel[] {
  const key = `${cols}x${rows}@${size}/${minHexes ?? ''}`;
  const hit = labelCache.get(data.owner);
  if (hit && hit.key === key && hit.cities === cities && hit.polities === data.polities) return hit.labels;
  const labels = placePolityLabels({
    cols,
    rows,
    size,
    owner: data.owner,
    polities: data.polities,
    obstacles,
    minHexes,
  });
  labelCache.set(data.owner, { cities, polities: data.polities, key, labels });
  return labels;
}

/**
 * The coast only depends on the base layer, so it is traced once per base
 * array. Lakes of one or two hexes are drawn as bodies of their own (see
 * `smallLakes`), so they are traced as land here.
 */
const coastCache = new WeakMap<object, { key: string; geometry: CoastGeometry; lakes: number[][] }>();

function cachedCoast(
  base: ReadonlyArray<BaseGeo | null>,
  cols: number,
  rows: number,
  size: number,
  smooth: boolean,
): { geometry: CoastGeometry; lakes: number[][] } {
  const key = `${cols}x${rows}@${size}/${smooth}`;
  const hit = coastCache.get(base);
  if (hit && hit.key === key) return hit;
  const lakes = smallLakes(base, cols, rows);
  const traced = base.slice();
  for (const lake of lakes) for (const i of lake) traced[i] = 'Land';
  const entry = { key, geometry: coastGeometry(traced, cols, rows, size, smooth), lakes };
  coastCache.set(base, entry);
  return entry;
}

/** Blend two #rrggbb colours; `t` = 0 gives `a`. */
function mix(a: string, b: string, t: number): string {
  const pa = /^#([0-9a-f]{6})$/i.exec(a);
  const pb = /^#([0-9a-f]{6})$/i.exec(b);
  if (!pa || !pb) return t < 0.5 ? a : b;
  const na = parseInt(pa[1]!, 16);
  const nb = parseInt(pb[1]!, 16);
  const channel = (shift: number) =>
    Math.round(((na >> shift) & 255) * (1 - t) + ((nb >> shift) & 255) * t);
  return `#${[16, 8, 0].map((s) => channel(s).toString(16).padStart(2, '0')).join('')}`;
}

/** Shift `colour` by the difference between `from` and `to`, per channel. */
function shift(colour: string, from: string, to: string): string {
  const parse = (c: string) => {
    const m = /^#([0-9a-f]{6})$/i.exec(c);
    const n = m ? parseInt(m[1]!, 16) : 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const [c, f, t] = [parse(colour), parse(from), parse(to)];
  return `#${c.map((v, i) => Math.max(0, Math.min(255, v + t[i]! - f[i]!)).toString(16).padStart(2, '0')).join('')}`;
}

/** The whole scene, screen decoration included. */
export function buildScene(map: MapState, opts: SceneOptions): Scene {
  const scene = buildStaticScene(map, opts);
  const decoration = decorationPrims(map, opts);
  return decoration.length > 0 ? { ...scene, prims: [...scene.prims, ...decoration] } : scene;
}

/** Hover and selection outlines: the only part of the scene that changes as the pointer moves. */
export function decorationPrims(map: MapState, opts: SceneOptions): Prim[] {
  const { cols, rows } = map;
  const { size } = opts;
  const prims: Prim[] = [];
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
  return prims;
}

/** Everything but the hover and selection outlines. */
export function buildStaticScene(map: MapState, opts: SceneOptions): Scene {
  const { cols, rows, layers } = map;
  const { size } = opts;
  const style = opts.style ?? CLASSIC_STYLE;
  const { palette, knobs } = style;
  const { width, height } = gridPixelSize(cols, rows, size);
  const prims: Prim[] = [];
  const seed = map.id;
  const uniformLand = opts.uniformLand ?? knobs.land === 'uniform';

  const base = opts.visible.base ? layers.base.data : null;
  const elevationStyle = opts.elevationStyle ?? 'colour';
  const thematic = thematicLayer(map, opts.visible, elevationStyle);

  const population = opts.visible.population ? layers.population.data : null;
  const maxPop = population ? Math.max(1, ...population.map((v) => v ?? 0)) : 1;

  const polities = opts.visible.polities ? layers.polities.data : null;
  const polityColour = new Map<string, string>(
    (polities?.polities ?? []).map((p) => [p.id, p.colour]),
  );

  const polityOpacity = Math.min(1, Math.max(0, opts.polityOpacity ?? 1));
  // Fills are sealed with a hairline of their own colour, so the anti-aliased
  // seam between two hexes of one colour does not let the background through.
  const seal = Math.max(0.4, size * 0.02);

  const baseColour = (value: BaseGeo): string => {
    switch (value) {
      case 'Sea':
      case 'Island':
      case 'Coastal Island':
      case 'Large Island':
      case 'Small Islands':
        return palette.sea;
      case 'Lake':
        return palette.lake;
      case 'Land':
        return palette.land;
      case 'Coastal Land':
        return uniformLand ? palette.land : palette.coastalLand;
      case 'Ice':
        return palette.ice;
    }
  };

  const hexFill = (i: number): string => {
    let fill = MAP_COLOURS.emptyHex;
    const baseValue = base ? base[i] : null;
    if (baseValue) fill = baseColour(baseValue);
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
    return fill;
  };

  /** The translucent layers painted over a hex's own fill, in order. */
  const overlays = (i: number): string[] => {
    const out: string[] = [];
    const value = population?.[i];
    if (value !== null && value !== undefined) out.push(withAlpha(populationColour(value, maxPop), 0.82));
    const owner = polities?.owner[i];
    if (owner) {
      // Polity colours are categorical data, not a tint. An opaque fill
      // keeps a realm's colour invariant when substrate layers change.
      const solid = polityColour.get(owner) ?? '#777777';
      out.push(polityOpacity < 1 ? withAlpha(solid, polityOpacity) : solid);
    }
    return out;
  };

  const traced = base ? cachedCoast(base, cols, rows, size, knobs.coast === 'smooth') : null;
  const lakeBodies = traced?.lakes ?? [];
  const inLakeBody = new Set(lakeBodies.flat());
  // A small lake's hexes are drawn as land, then the lake body over them.
  const sides = base ? base.map((v, i) => (inLakeBody.has(i) ? 'land' : sideOf(v))) : null;
  const isWater = (i: number) => sides?.[i] === 'water';
  /** The land hex whose colours a small lake's hex borrows for the ground around the lake. */
  const lakeShoreDonor = (i: number): number => {
    for (let e = 0; e < 6; e++) {
      const n = neighbourOf(i % cols, Math.floor(i / cols), e);
      if (!inBounds(cols, rows, n.col, n.row)) continue;
      const j = hexIndex(cols, n.col, n.row);
      if (sides?.[j] === 'land' && !inLakeBody.has(j)) return j;
    }
    return i;
  };

  // --- land -------------------------------------------------------------------
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = hexIndex(cols, col, row);
      if (isWater(i)) continue;
      const corners = hexCorners(col, row, size);
      const own = inLakeBody.has(i) ? lakeShoreDonor(i) : i;
      const fill = hexFill(own);
      prims.push({ kind: 'polygon', points: corners, fill, stroke: fill, strokeWidth: seal });

      if (knobs.ice === 'glacier' && base?.[i] === 'Ice' && fill === palette.ice) {
        prims.push(...crevasses(hexCenter(col, row, size), size, seed, i, palette.iceShade));
      }

      if (elevationStyle === 'contours' && opts.visible.elevation) {
        const elevation = layers.elevation.data?.[i];
        if (elevation) prims.push(...elevationMarks(hexCenter(col, row, size), size, elevation));
      }

      for (const overlay of overlays(own)) prims.push({ kind: 'polygon', points: corners, fill: overlay });
    }
  }

  // --- water --------------------------------------------------------------------
  const coast = traced && (knobs.coast !== 'none' || knobs.water !== 'flat') ? traced.geometry : null;
  const waterColour = (i: number) => (base?.[i] === 'Lake' ? palette.lake : palette.sea);
  const islands: number[] = [];
  if (base) {
    for (let i = 0; i < base.length; i++) {
      if (!isWater(i)) continue;
      const fill = waterColour(i);
      prims.push({ kind: 'polygon', points: hexCorners(i % cols, Math.floor(i / cols), size), fill, stroke: fill, strokeWidth: seal });
      if (isIslandType(base[i])) islands.push(i);
    }
    // Corners of land that the smoothed coast cuts off become water.
    for (const s of coast?.toWater ?? []) {
      const fill = waterColour(s.donor);
      prims.push({ kind: 'path', d: s.d, fill, stroke: fill, strokeWidth: seal });
    }
  }

  const islandRand = (i: number) => (k: number) => unit(seed, 'islet', i, k);
  const coastalSide = (i: number): number => {
    const stored = map.islandSides?.[String(i)];
    return stored !== undefined && stored >= 0 && stored < 6 ? stored : coastalIslandSide(base!, cols, rows, i);
  };
  /** Where the land of an island hex is centred: off-centre only for a coastal island. */
  const islandCentre = (i: number): Point => {
    const c = hexCenter(i % cols, Math.floor(i / cols), size);
    if (base?.[i] !== 'Coastal Island') return c;
    const angle = (coastalSide(i) * Math.PI) / 3;
    return { x: c.x + Math.cos(angle) * size * 0.4, y: c.y + Math.sin(angle) * size * 0.4 };
  };
  /** The land in an island hex, as one or more closed paths. */
  const islandPath = (i: number): PathCmd[] => {
    const c = hexCenter(i % cols, Math.floor(i / cols), size);
    const rand = islandRand(i);
    const blob = knobs.islands === 'blob';
    switch (base?.[i]) {
      case 'Coastal Island': {
        // Against one side of the hex, stretched along that side.
        const angle = (coastalSide(i) * Math.PI) / 3;
        const at = islandCentre(i);
        return blob
          ? blobPath(at, size * 0.44, size * 0.27, angle + Math.PI / 2, rand, 10)
          : circlePath(at, size * 0.3);
      }
      case 'Large Island':
        return blob
          ? blobPath(c, size * 0.74, size * 0.62, rand(99) * Math.PI, rand, 12, 0.16)
          : circlePath(c, size * 0.62);
      case 'Small Islands': {
        const count = 3 + Math.floor(rand(200) * 3);
        const d: PathCmd[] = [];
        for (let k = 0; k < count; k++) {
          // Spread round the hex so the islets do not pile up in the middle.
          const a = ((k + rand(300 + k) * 0.6) / count) * Math.PI * 2;
          const r = size * (k === 0 && count > 3 ? 0.05 : 0.42 + rand(400 + k) * 0.1);
          const at = { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r };
          const rr = size * (0.13 + rand(500 + k) * 0.07);
          const sub = (q: number) => rand(1000 + k * 37 + q);
          d.push(...(blob ? blobPath(at, rr * 1.25, rr, sub(99) * Math.PI, sub, 8, 0.18) : circlePath(at, rr)));
        }
        return d;
      }
      default:
        return blob ? isletPath(c, size, rand) : circlePath(c, size * 0.34);
    }
  };
  const shorelines: PathCmd[] = [...(coast?.paths.flat() ?? []), ...islands.flatMap(islandPath)];

  // The sea's surface, clipped to the water so the bands stop at the shore.
  if (base && coast && knobs.water !== 'flat' && shorelines.length > 0) {
    for (const body of ['sea', 'lake'] as const) {
      const hexes: number[] = [];
      base.forEach((v, i) => {
        if (isWater(i) && (v === 'Lake') === (body === 'lake')) hexes.push(i);
      });
      if (hexes.length === 0) continue;
      const clip = [
        ...hexesPath(hexes, cols, size),
        ...coast.toWater.filter((s) => (base[s.donor] === 'Lake') === (body === 'lake')).flatMap((s) => s.d),
      ];
      const water = body === 'lake' ? palette.lake : palette.sea;
      const surface = knobs.water === 'depth'
        ? depthBands(shorelines, size, water, shift(palette.seaShallow, palette.sea, water))
        : rippleBands(shorelines, size, water, palette.ripple, palette.rippleAlpha, body === 'lake' ? 1 : knobs.ripples);
      prims.push({ kind: 'group', clip, prims: surface });
    }
  }

  // --- small lakes ----------------------------------------------------------------
  const lakeOutlines: PathCmd[] = [];
  for (const lake of lakeBodies) {
    const centres = lake.map((i) => hexCenter(i % cols, Math.floor(i / cols), size));
    const rand = (k: number) => unit(seed, 'lake', lake[0]!, k);
    const d = centres.length === 1
      ? blobPath(centres[0]!, size * 0.8, size * 0.68, rand(99) * Math.PI, rand)
      : blobPath(
          { x: (centres[0]!.x + centres[1]!.x) / 2, y: (centres[0]!.y + centres[1]!.y) / 2 },
          Math.hypot(centres[1]!.x - centres[0]!.x, centres[1]!.y - centres[0]!.y) / 2 + size * 0.6,
          size * 0.62,
          Math.atan2(centres[1]!.y - centres[0]!.y, centres[1]!.x - centres[0]!.x),
          rand,
          12,
        );
    lakeOutlines.push(...d);
    prims.push({ kind: 'path', d, fill: palette.lake });
    if (knobs.water !== 'flat') {
      const surface = knobs.water === 'depth'
        ? depthBands(d, size, palette.lake, shift(palette.seaShallow, palette.sea, palette.lake))
        : rippleBands(d, size, palette.lake, palette.ripple, palette.rippleAlpha, 1);
      prims.push({ kind: 'group', clip: d, prims: surface });
    }
  }

  // --- islands ------------------------------------------------------------------
  const islandLand = uniformLand ? palette.land : palette.island;
  for (const i of islands) {
    const c = hexCenter(i % cols, Math.floor(i / cols), size);
    const owner = polities?.owner[i];
    const fill = owner
      ? (() => {
          const solid = polityColour.get(owner) ?? '#777777';
          return polityOpacity < 1 ? withAlpha(solid, polityOpacity) : solid;
        })()
      : null;
    if (knobs.islands === 'blob' || base?.[i] !== 'Island') {
      const d = islandPath(i);
      prims.push({ kind: 'path', d, fill: islandLand });
      // Only the landmass belongs to the polity; the surrounding sea stays sea.
      if (fill) prims.push({ kind: 'path', d, fill });
    } else {
      prims.push({ kind: 'circle', c, r: size * 0.34, fill: islandLand });
      if (fill) prims.push({ kind: 'circle', c, r: size * 0.34, fill });
    }
  }

  // Notches of water that the smoothed coast fills in become land, painted with
  // everything the neighbouring land hex is painted with.
  for (const s of coast?.toLand ?? []) {
    const fill = hexFill(s.donor);
    prims.push({ kind: 'path', d: s.d, fill, stroke: fill, strokeWidth: seal });
    for (const overlay of overlays(s.donor)) prims.push({ kind: 'path', d: s.d, fill: overlay });
  }

  // Claims on water hexes (where the map allows them) sit over the sea's surface.
  if (base) {
    for (let i = 0; i < base.length; i++) {
      if (!isWater(i) || isIslandType(base[i])) continue;
      for (const overlay of overlays(i)) {
        prims.push({ kind: 'polygon', points: hexCorners(i % cols, Math.floor(i / cols), size), fill: overlay });
      }
    }
  }

  // --- grid ---------------------------------------------------------------------
  if (knobs.grid !== 'none') {
    const d: PathCmd[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const i = hexIndex(cols, col, row);
        if (knobs.grid === 'land' && (!base || sides![i] !== 'land')) continue;
        for (let e = 0; e < 6; e++) {
          const n = neighbourOf(col, row, e);
          const inside = inBounds(cols, rows, n.col, n.row);
          const j = inside ? hexIndex(cols, n.col, n.row) : -1;
          if (knobs.grid === 'land') {
            // Land-to-land edges only: the coast has its own line.
            if (!inside || sides![j] !== 'land' || j < i) continue;
          } else if (inside && j < i) {
            continue; // each shared edge once
          }
          const [a, b] = hexEdgePoints(col, row, e, size);
          d.push(['M', a.x, a.y], ['L', b.x, b.y]);
        }
      }
    }
    if (d.length > 0) {
      prims.push({ kind: 'path', d, stroke: palette.grid, strokeWidth: Math.max(0.5, size * palette.gridWidth), round: true });
    }
  }

  // --- coastline ------------------------------------------------------------------
  if (knobs.coast !== 'none' && shorelines.length + lakeOutlines.length > 0) {
    prims.push({
      kind: 'path',
      d: [...shorelines, ...lakeOutlines],
      stroke: palette.coast,
      strokeWidth: Math.max(0.8, size * palette.coastWidth),
      round: true,
    });
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
  const tapered = knobs.rivers === 'tapered';
  const courses = new Map<string, Point[]>();
  // A river emptying into a small lake runs on into the lake's body.
  const tapering: Map<string, RiverCourse> = rivers && tapered
    ? riverCourses(rivers.rivers, size, seed, (river) => {
        const last = river.segments.at(-1);
        if (!last || last.exitEdge === null) return null;
        const n = neighbourOf(last.col, last.row, last.exitEdge);
        if (!inBounds(cols, rows, n.col, n.row) || !inLakeBody.has(hexIndex(cols, n.col, n.row))) return null;
        return hexCenter(n.col, n.row, size);
      })
    : new Map();
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
      if (tapered) {
        const course = tapering.get(river.id);
        if (!course) continue;
        courses.set(river.id, course.centreline);
        prims.push({ kind: 'path', d: course.outline, fill: palette.river, stroke: palette.river, strokeWidth: Math.max(0.3, size * 0.015), round: true });
        continue;
      }
      // One polyline per run of same-navigability segments, so the change in
      // weight along a river is visible rather than averaged away.
      let run: Point[] = [];
      let runNavigable: boolean | null = null;
      const flush = () => {
        if (run.length > 1) {
          prims.push({
            kind: 'polyline',
            points: run,
            stroke: runNavigable ? palette.river : palette.riverNonNavigable,
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

  // --- paper grain ----------------------------------------------------------------
  // Over the land and water but under the symbols and names, which stay crisp.
  if (knobs.grain && !opts.transparentBackground) {
    prims.push({ kind: 'texture', x: 0, y: 0, width, height, tile: grainTile(palette.grain, palette.grainStrength) });
  }

  // --- cities --------------------------------------------------------------
  const cities = opts.visible.cities ? layers.cities.data : null;
  const sites = new Map<string, Point>(
    (cities?.cities ?? []).map((city) => [
      city.id,
      citySite(city, {
        size,
        base,
        cols,
        riverLine: (id) => courses.get(id) ?? null,
        islandCentre: (i) => islandCentre(i),
      }),
    ]),
  );
  const siteOf = (city: { id: string; col: number; row: number }) => sites.get(city.id) ?? hexCenter(city.col, city.row, size);
  if (cities) {
    for (const city of cities.cities) {
      const c = siteOf(city);
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
        riverDot: palette.river,
      });
    }
  }

  // --- labels --------------------------------------------------------------
  if (opts.labels) {
    if (polities) {
      // City symbols and their names are drawn over the polity layer, so a
      // realm's name is steered away from them where it can be.
      const obstacles: LabelObstacle[] = [];
      for (const city of cities?.cities ?? []) {
        const c = siteOf(city);
        const r = Math.max(size * 0.16, Math.min(size * 0.46, size * 0.1 * Math.log10(Math.max(10, city.population))));
        obstacles.push({ left: c.x - r, right: c.x + r, top: c.y - r, bottom: c.y + r });
        const fontSize = Math.max(8, size * 0.36);
        const halfWidth = (city.name.length * fontSize * 0.6) / 2;
        const y = c.y + size * 0.95;
        obstacles.push({ left: c.x - halfWidth, right: c.x + halfWidth, top: y - fontSize * 0.6, bottom: y + fontSize * 0.6 });
      }
      for (const label of cachedPolityLabels(polities, cities, cols, rows, size, obstacles, opts.polityNames)) {
        // Lines are stacked perpendicular to the baseline so a wrapped,
        // rotated name stays a single rigid block.
        label.lines.forEach((line, k) => {
          const offset = (k - (label.lines.length - 1) / 2) * label.size * LABEL_LINE_EM;
          prims.push({
            kind: 'text',
            at: {
              x: label.at.x - offset * Math.sin(label.rotation),
              y: label.at.y + offset * Math.cos(label.rotation),
            },
            text: line,
            size: label.size,
            fill: MAP_COLOURS.label,
            weight: 600,
            anchor: 'middle',
            fantasy: true,
            rotation: label.rotation,
          });
        });
      }
    }
    if (cities) {
      for (const city of cities.cities) {
        const c = siteOf(city);
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

  // --- river and mountain range names -------------------------------------
  if (rivers && opts.riverNames) {
    const pathFor = tapered ? (id: string) => courses.get(id) ?? null : undefined;
    for (const l of placeRiverLabels(rivers.rivers, size, pathFor)) {
      prims.push({
        kind: 'text',
        at: l.at,
        text: l.text,
        size: l.size,
        fill: palette.riverLabel,
        halo: MAP_COLOURS.labelHalo,
        weight: 600,
        anchor: 'middle',
        fantasy: true,
        italic: true,
        rotation: l.rotation,
      });
    }
  }
  if (opts.rangeNames && opts.visible.elevation && layers.elevation.data) {
    for (const l of placeRangeLabels(map.mountainRanges ?? [], layers.elevation.data, cols, size)) {
      prims.push({
        kind: 'text',
        at: l.at,
        text: l.text,
        size: l.size,
        fill: MAP_COLOURS.rangeLabel,
        halo: MAP_COLOURS.labelHalo,
        weight: 700,
        anchor: 'middle',
        fantasy: true,
        rotation: l.rotation,
      });
    }
  }

  return {
    width,
    height,
    // The sea colour, so the half-hex notches along the left and right edges
    // read as more sea rather than as a black serrated border.
    background: opts.transparentBackground ? 'transparent' : palette.sea,
    prims,
  };
}

/** Elevation drawn as stacked marks, one more per step of height. */
function elevationMarks(centre: Point, size: number, elevation: Elevation): Prim[] {
  const levels: Record<Elevation, number> = {
    Lowland: 0, Rolling: 1, Hills: 2, Highland: 3, Mountains: 4, Plateau: 2,
  };
  const prims: Prim[] = [];
  for (let mark = 0; mark < levels[elevation]; mark++) {
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
  return prims;
}

/** A few seeded crevasse strokes, so a glacier reads as ice rather than as blank paper. */
function crevasses(centre: Point, size: number, seed: string, i: number, colour: string): Prim[] {
  const prims: Prim[] = [];
  const count = 2 + Math.floor(unit(seed, 'ice', i, 'n') * 2);
  for (let k = 0; k < count; k++) {
    const x = centre.x + signed(seed, 'ice', i, k, 'x') * size * 0.45;
    const y = centre.y + signed(seed, 'ice', i, k, 'y') * size * 0.4;
    const angle = signed(seed, 'ice', i, k, 'a') * 0.35;
    const half = size * (0.12 + 0.12 * unit(seed, 'ice', i, k, 'l'));
    const bend = signed(seed, 'ice', i, k, 'b') * size * 0.05;
    const dx = Math.cos(angle) * half;
    const dy = Math.sin(angle) * half;
    prims.push({
      kind: 'path',
      d: [['M', x - dx, y - dy], ['Q', x - dy * 0.3, y + bend, x + dx, y + dy]],
      stroke: colour,
      strokeWidth: Math.max(0.6, size * 0.035),
      round: true,
    });
  }
  return prims;
}

/**
 * Bands of colour that lighten towards the shore. Each band is the shoreline
 * stroked at a width; drawn widest first, the narrower, paler strokes leave a
 * ring of each colour at its distance from the nearest coast, wherever that
 * coast is, so the bands of neighbouring islands merge as real shallows do.
 */
function depthBands(shores: PathCmd[], size: number, deep: string, shallow: string): Prim[] {
  const bands = 6;
  const reach = 2.1 * size;
  const prims: Prim[] = [];
  for (let k = bands; k >= 1; k--) {
    const t = ((bands - k + 1) / bands) ** 1.4;
    prims.push({ kind: 'path', d: shores, stroke: mix(deep, shallow, t), strokeWidth: (2 * reach * k) / bands, round: true });
  }
  return prims;
}

/**
 * Lines following the shore at increasing distances. Each ring is a wide
 * stroke in the ripple colour with a slightly narrower stroke of plain water
 * over it, leaving a thin line at that distance from every coast at once.
 */
function rippleBands(
  shores: PathCmd[],
  size: number,
  water: string,
  ripple: string,
  alpha: number,
  // Lakes take one ring: three fill a small lake and read as a contoured hollow.
  rings: number,
): Prim[] {
  const line = Math.max(0.6, size * 0.045);
  const prims: Prim[] = [];
  for (let k = rings - 1; k >= 0; k--) {
    const distance = size * (0.26 + 0.22 * k);
    const ink = mix(water, ripple, alpha * (1 - k * 0.22));
    prims.push({ kind: 'path', d: shores, stroke: ink, strokeWidth: 2 * distance + line, round: true });
    prims.push({ kind: 'path', d: shores, stroke: water, strokeWidth: 2 * distance - line, round: true });
  }
  return prims;
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
