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
  pixelToOffset,
  type Point,
} from '../../shared/hex.js';
import {
  LAYER_ORDER,
  isIslandType,
  islandSpecFor,
  type IslandSpec,
  type BaseGeo,
  type CitiesData,
  type Climate,
  type Elevation,
  type LayerId,
  type MapState,
  type PolitiesData,
  type RiverSegment,
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
import { placeRangeLabels, placeRiverLabels, placeWaterLabels } from './featureLabels.js';
import {
  LABEL_LINE_EM,
  labelBox,
  placeCityNames,
  placePolityLabels,
  type OrientedBox,
  type LabelObstacle,
  type PolityLabel,
  type PolityNameMin,
} from './labels.js';
import {
  blobPath,
  chainEdges,
  circlePath,
  coastalIslandSide,
  coastGeometryOf,
  lakeIslandsOf,
  pieceDonor,
  piecePoints,
  pieceSurface,
  surfaceEdges,
  surfaceMap,
  type SurfaceMap,
  hexesPath,
  sideOf,
  lakeBodyPath,
  lakeComponents,
  type CoastGeometry,
} from './coast.js';
import type { CitySymbol, PathCmd, Prim } from './prims.js';
import { cityMarker, markerExtent } from './cityMarkers.js';
import { riverCourses, type RiverCourse } from './rivers.js';
import { citySite } from './sites.js';
import { escarpment, hillshade, reliefSymbols, vegetationSymbols, type Placed } from './symbols.js';
import { ownersAtDepth, polityDepths, polityDisplayColours, toned } from './hierarchy.js';
import { topLevelOf } from '../../shared/polityTree.js';
import { measureEpoch, textEm } from './fonts.js';
import { glyphAdvances, glyphsStraight } from './glyphs.js';
import { BUNDLED_FACES, LETTERINGS, type FaceRole } from './lettering.js';
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
  /** Name seas, bays and lakes that have been named (needs the base layer visible). */
  seaNames?: boolean;
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

/** Width in em of `text` set in a lettering role, tracking included. */
function roleEm(role: FaceRole, text: string, weight = role.weight): number {
  return role.tracking > 0
    ? glyphAdvances(text, 1, role.tracking, weight, role.family, role.italic).width
    : textEm(text, role.family, weight, role.italic);
}

/** A lighter weight of the role's face for the parts of a realm: a bundled one where there is one. */
function lighterWeight(role: FaceRole): number {
  const bundled = BUNDLED_FACES.filter((f) => role.family.startsWith(`"${f.family}"`) && f.italic === role.italic);
  if (bundled.length === 0) return role.weight - 100;
  const lighter = bundled.filter((f) => f.weight < role.weight).map((f) => f.weight);
  return lighter.length > 0 ? Math.max(...lighter) : role.weight;
}

function cachedPolityLabels(
  data: PolitiesData,
  cities: CitiesData | null,
  cols: number,
  rows: number,
  size: number,
  obstacles: LabelObstacle[],
  minHexes: PolityNameMin | undefined,
  sizing: 'moderate' | 'fill',
  role: FaceRole,
  letteringId: string,
): PolityLabel[] {
  const key = `${cols}x${rows}@${size}/${minHexes ?? ''}/${sizing}/${letteringId}/${measureEpoch}`;
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
    sizing,
    measure: (text) => roleEm(role, text),
  });
  labelCache.set(data.owner, { cities, polities: data.polities, key, labels });
  return labels;
}

/**
 * The coast only depends on the base layer, so it is traced once per base
 * array. Lakes are drawn as bodies of their own (see `lakeBodyPath`), so they
 * are traced as land here, and so are islands that stand in a lake.
 */
interface TracedCoast {
  geometry: CoastGeometry;
  lakes: number[][];
  lakeIslands: Set<number>;
  surface: SurfaceMap;
}

const coastCache = new WeakMap<object, TracedCoast & { key: string }>();

function cachedCoast(
  base: ReadonlyArray<BaseGeo | null>,
  cols: number,
  rows: number,
  size: number,
  smooth: boolean,
): TracedCoast {
  const key = `${cols}x${rows}@${size}/${smooth}`;
  const hit = coastCache.get(base);
  if (hit && hit.key === key) return hit;
  const lakeIslands = lakeIslandsOf(base, cols, rows);
  const surface = surfaceMap(base, cols, rows, lakeIslands);
  const { lakes } = lakeComponents(base, cols, rows, surface);
  // The sea's coast: lakes count as land here, as they have bodies of their own.
  const geometry = coastGeometryOf(surfaceEdges(surface, size, (side) => side !== 'sea'), smooth);
  const entry = { key, geometry, lakes, lakeIslands, surface };
  coastCache.set(base, entry);
  return entry;
}

/**
 * The owners the map is drawn with: only land carries a realm's colour. Sea
 * and lake hexes are drawn unowned even where the data gives them an owner
 * (the data is not changed); the land round a lake still takes the colour of
 * the realm it borders (see the lake sectors in `buildStaticScene`).
 */
const landOwnerCache = new WeakMap<object, { base: object; owner: (string | null)[] }>();

function landOwners(owner: (string | null)[], base: ReadonlyArray<BaseGeo | null>): (string | null)[] {
  const hit = landOwnerCache.get(owner);
  if (hit && hit.base === base) return hit.owner;
  const out = owner.map((o, i) => (base[i] === 'Sea' || base[i] === 'Lake' || base[i] === 'Strait' ? null : o));
  landOwnerCache.set(owner, { base, owner: out });
  return out;
}

/** Opacity of the realm fill under the border band in the tint style. */
const TINT_ALPHA = 0.32;

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
  // An explicit elevationStyle (the older two-way setting) overrides the style's relief.
  const relief = opts.elevationStyle
    ? opts.elevationStyle === 'colour' ? 'colour' : 'marks'
    : knobs.relief;
  const elevationStyle = relief === 'colour' ? 'colour' : 'contours';
  const thematic = thematicLayer(map, opts.visible, elevationStyle);
  const elevationData = opts.visible.elevation ? layers.elevation.data : null;

  const population = opts.visible.population ? layers.population.data : null;
  const maxPop = population ? Math.max(1, ...population.map((v) => v ?? 0)) : 1;

  const traced = base ? cachedCoast(base, cols, rows, size, knobs.coast === 'smooth') : null;
  const rawPolities = opts.visible.polities ? layers.polities.data : null;
  // Realm colour is drawn on land only; see landOwners.
  const polities = rawPolities && base
    ? { ...rawPolities, owner: landOwners(rawPolities.owner, base) }
    : rawPolities;
  const polityColour = new Map(
    [...polityDisplayColours(polities?.polities ?? [], knobs.subPolities)].map(([id, c]) => [id, toned(c, knobs.polityTone)]),
  );
  const topLevel = new Map((polities?.polities ?? []).map((p) => [p.id, topLevelOf(polities!.polities, p.id)]));

  const polityOpacity = Math.min(1, Math.max(0, opts.polityOpacity ?? 1));
  // Fills are sealed with a hairline of their own colour, so the anti-aliased
  // seam between two hexes of one colour does not let the background through.
  const seal = Math.max(0.4, size * 0.02);

  const baseColour = (value: BaseGeo): string => {
    switch (value) {
      case 'Sea':
      case 'Islands':
      case 'Strait':
        return palette.sea;
      case 'Mainland and islands':
      case 'Isthmus':
        return uniformLand ? palette.land : palette.coastalLand;
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
    const owner = knobs.polityStyle === 'fill' || knobs.polityStyle === 'tint' ? polities?.owner[i] : null;
    if (owner) {
      // Polity colours are categorical data, not a tint. An opaque fill
      // keeps a realm's colour invariant when substrate layers change.
      const solid = polityColour.get(owner) ?? '#777777';
      const alpha = knobs.polityStyle === 'tint' ? TINT_ALPHA * polityOpacity : polityOpacity;
      out.push(alpha < 1 ? withAlpha(solid, alpha) : solid);
    }
    return out;
  };

  const lakeBodies = traced?.lakes ?? [];
  const lakeIslands = traced?.lakeIslands ?? new Set<number>();
  const terrain = traced?.surface ?? null;
  const inLakeBody = new Set(lakeBodies.flat());
  // A small lake's hexes are drawn as land, then the lake body over them.
  /** The colour a hex finally shows: its fill with every overlay laid over it. */
  const groundColour = (i: number): string => {
    let colour = hexFill(i);
    for (const overlay of overlays(i)) {
      const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(overlay);
      if (m) {
        const hex = `#${[m[1], m[2], m[3]].map((v) => Number(v).toString(16).padStart(2, '0')).join('')}`;
        colour = mix(colour, hex, Number(m[4]));
      } else {
        colour = overlay;
      }
    }
    return colour;
  };

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
  /** A lake hex (not an island in it): drawn as land under the lake's body. */
  const isLakeHex = (i: number) => inLakeBody.has(i) && !lakeIslands.has(i) && !terrain?.split.has(i);
  /** A hex drawn partly land and partly water (see `surfaceMap`). */
  const isSplit = (i: number) => Boolean(terrain?.split.has(i));
  /**
   * The land hex each of a lake hex's six sectors (the triangle from the
   * centre to edge e) takes its ground and realm colour from: the land across
   * that edge, or else the nearest sector round the hex that has land across
   * it. The lake's body covers most of the hex; what it leaves uncovered reads
   * as the shore of whichever land it faces.
   */
  const sectorDonorCache = new Map<number, number[]>();
  const lakeSectorDonors = (i: number): number[] => {
    const hit = sectorDonorCache.get(i);
    if (hit) return hit;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const donors = Array.from({ length: 6 }, (_, e) => {
      const n = neighbourOf(col, row, e);
      if (!inBounds(cols, rows, n.col, n.row)) return -1;
      const j = hexIndex(cols, n.col, n.row);
      return sides?.[j] === 'land' && !inLakeBody.has(j) ? j : -1;
    });
    for (let step = 1; step <= 3; step++) {
      for (let e = 0; e < 6; e++) {
        if (donors[e] !== -1) continue;
        const near = [donors[(e + step) % 6]!, donors[(e + 6 - step) % 6]!].find((d) => d !== -1);
        if (near !== undefined) donors[e] = near;
      }
    }
    const out = donors.map((d) => (d === -1 ? lakeShoreDonor(i) : d));
    sectorDonorCache.set(i, out);
    return out;
  };
  const sectorPoints = (i: number, e: number): Point[] => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const [a, b] = hexEdgePoints(col, row, e, size);
    return [hexCenter(col, row, size), a, b];
  };

  // --- land -------------------------------------------------------------------
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = hexIndex(cols, col, row);
      if (isWater(i)) continue;
      const corners = hexCorners(col, row, size);
      if (isSplit(i)) continue;
      if (isLakeHex(i)) {
        // Sector by sector, in the colours of the land each faces.
        lakeSectorDonors(i).forEach((donor, e) => {
          const points = sectorPoints(i, e);
          const fill = hexFill(donor);
          prims.push({ kind: 'polygon', points, fill, stroke: fill, strokeWidth: seal });
          for (const overlay of overlays(donor)) prims.push({ kind: 'polygon', points, fill: overlay });
        });
        continue;
      }
      // An island in a lake lies under the lake's body too; its ground is the shore's.
      const own = inLakeBody.has(i) ? lakeShoreDonor(i) : i;
      const fill = hexFill(own);
      prims.push({ kind: 'polygon', points: corners, fill, stroke: fill, strokeWidth: seal });

      if (knobs.ice === 'glacier' && base?.[i] === 'Ice' && fill === palette.ice) {
        prims.push(...crevasses(hexCenter(col, row, size), size, seed, i, palette.iceShade));
      }

      if (relief === 'marks' && opts.visible.elevation) {
        const elevation = layers.elevation.data?.[i];
        if (elevation) prims.push(...elevationMarks(hexCenter(col, row, size), size, elevation));
      }

      for (const overlay of overlays(own)) prims.push({ kind: 'polygon', points: corners, fill: overlay });
    }
  }

  // --- hill shading ----------------------------------------------------------------
  // Over the land's colours (realm fills included), so height reads through them.
  if (relief === 'hillshade' && elevationData) {
    for (let i = 0; i < cols * rows; i++) {
      const here = elevationData[i];
      if (!here || isWater(i)) continue;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const v = hillshade(here, (e) => {
        const n = neighbourOf(col, row, e);
        if (!inBounds(cols, rows, n.col, n.row)) return null;
        const j = hexIndex(cols, n.col, n.row);
        if (isWater(j)) return 'water';
        return elevationData[j] ?? here;
      });
      if (Math.abs(v) < 0.04) continue;
      prims.push({
        kind: 'polygon',
        points: hexCorners(col, row, size),
        fill: withAlpha(v > 0 ? '#ffffff' : palette.ink, Math.min(0.22, Math.abs(v) * 0.13)),
      });
    }
  }

  // --- water --------------------------------------------------------------------
  const coast = traced && (knobs.coast !== 'none' || knobs.water !== 'flat') ? traced.geometry : null;
  const waterColour = (i: number) => (base?.[i] === 'Lake' ? palette.lake : palette.sea);
  const islands: number[] = [];
  if (base) {
    for (let i = 0; i < base.length; i++) {
      if (isIslandType(base[i]) && !lakeIslands.has(i)) islands.push(i);
      if (!isWater(i) || isSplit(i)) continue;
      const fill = waterColour(i);
      prims.push({ kind: 'polygon', points: hexCorners(i % cols, Math.floor(i / cols), size), fill, stroke: fill, strokeWidth: seal });
    }
    // Islands in a lake are drawn on the lake's body, after it.
    for (const i of lakeIslands) islands.push(i);
    // Split hexes piece by piece: land in the colours of the land it is (or
    // faces), sea in the sea's, and lake water as land under the lake's body.
    for (const [i, split] of terrain?.split ?? []) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      split.sides.forEach((side, p) => {
        const points = piecePoints(col, row, p, size);
        if (side === 'sea') {
          const fill = waterColour(split.donors[p]!);
          prims.push({ kind: 'polygon', points, fill, stroke: fill, strokeWidth: seal });
          return;
        }
        const donor = side === 'land' ? split.donors[p]! : isWater(i) ? lakeShoreDonor(i) : i;
        const fill = hexFill(donor);
        prims.push({ kind: 'polygon', points, fill, stroke: fill, strokeWidth: seal });
        for (const overlay of overlays(donor)) prims.push({ kind: 'polygon', points, fill: overlay });
      });
    }
    // Corners of land that the smoothed coast cuts off become water.
    for (const s of coast?.toWater ?? []) {
      const fill = waterColour(s.donor);
      prims.push({ kind: 'path', d: s.d, fill, stroke: fill, strokeWidth: seal });
    }
  }

  const islandRand = (i: number) => (k: number) => unit(seed, 'islet', i, k);
  /** The direction (radians) from an island hex's centre toward the land its coastal groups lie against. */
  const coastward = (i: number, spec: IslandSpec): number => {
    const split = terrain?.split.get(i);
    if (split) {
      // Toward the mainland: the mean direction of the sectors that are land.
      let x = 0;
      let y = 0;
      split.sides.forEach((side, p) => {
        if (p >= 6 && side === 'land') {
          x += Math.cos(((p - 6) * Math.PI) / 3);
          y += Math.sin(((p - 6) * Math.PI) / 3);
        }
      });
      if (x !== 0 || y !== 0) return Math.atan2(y, x);
    }
    const side = spec.side ?? coastalIslandSide(base!, cols, rows, i);
    return (side * Math.PI) / 3;
  };
  interface Isle {
    c: Point;
    rx: number;
    ry: number;
    axis: number;
  }
  /**
   * Where the islands of an island hex lie and how big they are. Large
   * islands fill most of the hex (one), or share it (two); small ones ring
   * them. A coastal group lies against the side facing land, or for a
   * mainland hex just off the mainland; on a mainland hex everything keeps to
   * the water half.
   */
  const islandLayout = (i: number): Isle[] => {
    const c = hexCenter(i % cols, Math.floor(i / cols), size);
    const rand = islandRand(i);
    const spec = islandSpecFor(base![i], map.islandSpecs?.[String(i)]);
    const mainland = Boolean(terrain?.split.has(i));
    const toward = coastward(i, spec);
    // The direction the free (non-coastal) islands lie: the open water.
    const out = mainland ? toward + Math.PI : rand(250) * Math.PI * 2;
    const at = (angle: number, r: number, along = 0): Point => ({
      x: c.x + Math.cos(angle) * r * size - Math.sin(angle) * along * size,
      y: c.y + Math.sin(angle) * r * size + Math.cos(angle) * along * size,
    });
    const isles: Isle[] = [];
    const nl = spec.large;
    const ns = spec.small;
    const coastalLarge = Boolean(spec.coastal?.large);
    const coastalSmall = Boolean(spec.coastal?.small);
    if (nl > 0) {
      const crowded = ns > 0 && !coastalSmall;
      if (mainland) {
        const r = coastalLarge ? 0.3 : 0.52;
        for (let k = 0; k < nl; k++) {
          const along = nl === 1 ? 0 : (k - 0.5) * 0.56;
          isles.push({ c: at(toward + Math.PI, r, along), rx: (nl === 1 ? 0.34 : 0.26) * size, ry: (nl === 1 ? 0.24 : 0.19) * size, axis: toward + Math.PI / 2 });
        }
      } else if (coastalLarge) {
        for (let k = 0; k < nl; k++) {
          const along = nl === 1 ? 0 : (k - 0.5) * 0.6;
          isles.push({ c: at(toward, 0.4, along), rx: (nl === 1 ? 0.44 : 0.3) * size, ry: (nl === 1 ? 0.27 : 0.2) * size, axis: toward + Math.PI / 2 });
        }
      } else if (nl === 1) {
        isles.push({ c, rx: (crowded ? 0.52 : 0.74) * size, ry: (crowded ? 0.44 : 0.62) * size, axis: rand(99) * Math.PI });
      } else {
        const axis = rand(98) * Math.PI;
        for (const sign of [-1, 1]) {
          isles.push({ c: at(axis, sign * 0.36), rx: (crowded ? 0.32 : 0.4) * size, ry: (crowded ? 0.26 : 0.32) * size, axis: axis + Math.PI / 2 + (rand(97 + sign) - 0.5) });
        }
      }
    }
    for (let k = 0; k < ns; k++) {
      const rr = size * (0.12 + rand(500 + k) * 0.05) * (ns >= 4 ? 0.82 : 1);
      let p: Point;
      if (coastalSmall) {
        // In a line along the coast (or the mainland's shore).
        const along = (k - (ns - 1) / 2) * 0.3 + (rand(300 + k) - 0.5) * 0.08;
        p = mainland ? at(toward + Math.PI, 0.28 + rand(400 + k) * 0.08, along) : at(toward, 0.56 + rand(400 + k) * 0.08, along);
      } else if (mainland) {
        const spread = Math.min(Math.PI * 0.8, 0.5 * ns);
        const a = out + (ns === 1 ? 0 : (k / (ns - 1) - 0.5) * spread) + (rand(300 + k) - 0.5) * 0.2;
        p = at(a, 0.56 + rand(400 + k) * 0.1);
      } else {
        // Round the hex, clear of any large island.
        const free = nl > 0 && coastalLarge ? Math.PI * 1.3 : Math.PI * 2;
        const start = nl > 0 && coastalLarge ? toward + Math.PI - free / 2 : out;
        const a = start + ((k + 0.5) / ns) * free + (rand(300 + k) - 0.5) * 0.3;
        p = at(a, (nl > 0 && !coastalLarge ? 0.62 : 0.45) + rand(400 + k) * 0.1);
      }
      isles.push({ c: p, rx: rr * 1.25, ry: rr, axis: rand(600 + k) * Math.PI });
    }
    return isles;
  };
  /** Where a city in an island hex stands: on the mainland, or on its largest island. */
  const islandCentre = (i: number): Point => {
    const c = hexCenter(i % cols, Math.floor(i / cols), size);
    if (terrain?.split.has(i)) {
      const toward = coastward(i, islandSpecFor(base![i], map.islandSpecs?.[String(i)]));
      return { x: c.x + Math.cos(toward) * size * 0.5, y: c.y + Math.sin(toward) * size * 0.5 };
    }
    const biggest = islandLayout(i).sort((a, b) => b.rx * b.ry - a.rx * a.ry)[0];
    return biggest?.c ?? c;
  };
  /** The islands of an island hex, as closed paths. */
  const islandPath = (i: number): PathCmd[] => {
    const rand = islandRand(i);
    const blob = knobs.islands === 'blob';
    return islandLayout(i).flatMap((isle, k) => {
      const sub = (q: number) => rand(1000 + k * 37 + q);
      return blob
        ? blobPath(isle.c, isle.rx, isle.ry, isle.axis, sub, isle.rx > size * 0.3 ? 12 : 9, isle.rx > size * 0.3 ? 0.16 : 0.18)
        : circlePath(isle.c, Math.sqrt(isle.rx * isle.ry) * 0.9);
    });
  };
  const shorelines: PathCmd[] = [...(coast?.paths.flat() ?? []), ...islands.filter((i) => !lakeIslands.has(i)).flatMap(islandPath)];

  // The sea's surface, clipped to the water so the bands stop at the shore.
  if (base && coast && knobs.water !== 'flat' && shorelines.length > 0) {
    for (const body of ['sea', 'lake'] as const) {
      const hexes: number[] = [];
      base.forEach((v, i) => {
        if (isWater(i) && !isSplit(i) && (v === 'Lake') === (body === 'lake')) hexes.push(i);
      });
      // The open water of split hexes.
      const pieces: PathCmd[] = [];
      for (const [i, split] of terrain?.split ?? []) {
        split.sides.forEach((side, p) => {
          if (side !== body || body === 'lake') return;
          piecePoints(i % cols, Math.floor(i / cols), p, size).forEach((q, k) => pieces.push([k === 0 ? 'M' : 'L', q.x, q.y]));
          pieces.push(['Z']);
        });
      }
      if (hexes.length === 0 && pieces.length === 0) continue;
      const clip = [
        ...hexesPath(hexes, cols, size),
        ...pieces,
        ...coast.toWater.filter((s) => (base[s.donor] === 'Lake') === (body === 'lake')).flatMap((s) => s.d),
      ];
      const water = body === 'lake' ? palette.lake : palette.sea;
      const surface = knobs.water === 'depth'
        ? depthBands(shorelines, size, water, shift(palette.seaShallow, palette.sea, water))
        : rippleBands(shorelines, size, water, palette.ripple, palette.rippleAlpha, body === 'lake' ? 1 : knobs.ripples);
      prims.push({ kind: 'group', clip, prims: surface });
    }
  }

  // --- lakes ----------------------------------------------------------------------
  /**
   * A land hex with lake on two sides that do not touch: a strip between two
   * arms of water, which a lake's outward reach would otherwise swallow.
   */
  const isThinLand = (p: Point): boolean => {
    const { col, row } = pixelToOffset(p.x, p.y, size);
    if (!inBounds(cols, rows, col, row)) return false;
    const i = hexIndex(cols, col, row);
    // The banks of a strait, the neck of an isthmus and a mainland lobe are
    // drawn narrow on purpose: a lake must not swallow them either.
    if (isSplit(i)) return true;
    if (isLakeHex(i) || isWater(i)) return false;
    const wet = [0, 1, 2, 3, 4, 5].filter((e) => {
      const n = neighbourOf(col, row, e);
      if (!inBounds(cols, rows, n.col, n.row)) return false;
      const j = hexIndex(cols, n.col, n.row);
      return isLakeHex(j) || isWater(j);
    });
    return wet.some((a) => wet.some((b) => {
      const gap = Math.abs(a - b);
      return Math.min(gap, 6 - gap) >= 2;
    }));
  };
  const lakeOutlines: PathCmd[] = [];
  /** Each lake's drawn shore (body and the islands in it), by lake. */
  const lakeShores: PathCmd[][] = [];
  const lakeOf = new Map<number, number>();
  lakeBodies.forEach((lake, k) => lake.forEach((i) => lakeOf.set(i, k)));
  for (const lake of lakeBodies) {
    const rand = (k: number) => unit(seed, 'lake', lake[0]!, k);
    const d = lakeBodyPath(
      surfaceEdges(terrain!, size, (side) => side === 'lake', new Set(lake)),
      size,
      rand,
      (p) => (isThinLand(p) ? 0.1 : 1),
    );
    const isles = lake.filter((i) => lakeIslands.has(i)).flatMap(islandPath);
    lakeOutlines.push(...d, ...isles);
    lakeShores.push([...d, ...isles]);
    prims.push({ kind: 'path', d, fill: palette.lake });
    if (knobs.water !== 'flat') {
      const shore = [...d, ...isles];
      const surface = knobs.water === 'depth'
        ? depthBands(shore, size, palette.lake, shift(palette.seaShallow, palette.sea, palette.lake))
        : rippleBands(shore, size, palette.lake, palette.ripple, palette.rippleAlpha, 1);
      prims.push({ kind: 'group', clip: d, prims: surface });
    }
  }

  /** Whether a point lies in a lake's water as drawn (islands in it are land). */
  const lakeRings = lakeShores.map((d) => {
    const rings: Point[][] = [];
    for (const c of d) {
      if (c[0] === 'M') rings.push([{ x: c[1], y: c[2] }]);
      else if (c[0] === 'L') rings[rings.length - 1]?.push({ x: c[1], y: c[2] });
    }
    const xs = rings.flat().map((p) => p.x);
    const ys = rings.flat().map((p) => p.y);
    return { rings, box: { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) } };
  });
  const inLakeWater = (p: Point): boolean =>
    lakeRings.some(({ rings, box }) => {
      if (p.x < box.x0 || p.x > box.x1 || p.y < box.y0 || p.y > box.y1) return false;
      let inside = false;
      for (const ring of rings) {
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
          const pa = ring[a]!;
          const pb = ring[b]!;
          if ((pa.y > p.y) !== (pb.y > p.y) && p.x < ((pb.x - pa.x) * (p.y - pa.y)) / (pb.y - pa.y) + pa.x) inside = !inside;
        }
      }
      return inside;
    });

  // --- islands ------------------------------------------------------------------
  const islandLand = uniformLand ? palette.land : palette.island;
  for (const i of islands) {
    const owner = polities?.owner[i];
    const fill = owner
      ? (() => {
          const solid = polityColour.get(owner) ?? '#777777';
          return polityOpacity < 1 ? withAlpha(solid, polityOpacity) : solid;
        })()
      : null;
    const d = islandPath(i);
    prims.push({ kind: 'path', d, fill: islandLand });
    // Only the landmass belongs to the polity; the surrounding sea stays sea.
    if (fill && knobs.polityStyle === 'fill') prims.push({ kind: 'path', d, fill });
    if (fill && knobs.polityStyle === 'wash') prims.push({ kind: 'path', d, fill: withAlpha(polityColour.get(owner!) ?? '#777777', 0.55) });
    if (fill && knobs.polityStyle === 'tint') prims.push({ kind: 'path', d, fill: withAlpha(polityColour.get(owner!) ?? '#777777', 0.6) });
    if (fill && knobs.polityStyle === 'outline') {
      prims.push({ kind: 'path', d, stroke: polityColour.get(owner!) ?? '#777777', strokeWidth: Math.max(1, size * 0.08), round: true });
    }
  }

  // Notches of water that the smoothed coast fills in become land, painted with
  // everything the neighbouring land hex is painted with.
  for (const s of coast?.toLand ?? []) {
    const fill = hexFill(s.donor);
    prims.push({ kind: 'path', d: s.d, fill, stroke: fill, strokeWidth: seal });
    for (const overlay of overlays(s.donor)) prims.push({ kind: 'path', d: s.d, fill: overlay });
  }

  // --- grid ---------------------------------------------------------------------
  if (knobs.grid !== 'none') {
    const d: PathCmd[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const i = hexIndex(cols, col, row);
        if (knobs.grid === 'land' && (!base || sides![i] !== 'land' || inLakeBody.has(i))) continue;
        for (let e = 0; e < 6; e++) {
          const n = neighbourOf(col, row, e);
          const inside = inBounds(cols, rows, n.col, n.row);
          const j = inside ? hexIndex(cols, n.col, n.row) : -1;
          if (knobs.grid === 'land') {
            // Land-to-land edges only: the coast has its own line.
            if (!inside || sides![j] !== 'land' || inLakeBody.has(j) || j < i) continue;
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
  // Each realm's border is traced as continuous loops round its hexes and
  // drawn as a band clipped to the inside of the realm, so corners join
  // cleanly and two neighbours each show their own colour along the line.
  // Island hexes are left out: the islet itself carries the realm's colour.
  const internal: PathCmd[] = [];
  if (polities) {
    const regions = new Map<string, number[]>();
    const bands = new Map<string, Array<{ from: Point; to: Point; land: number; water: number }>>();
    const frontier: Array<{ from: Point; to: Point; land: number; water: number }> = [];
    // Island hexes carry their realm's colour on their islands alone. (An
    // island in a lake is part of the lake's body, and a mainland coast with
    // islands has a realm's land in it.)
    const isIsland = (i: number) => base?.[i] === 'Islands' && !lakeIslands.has(i);
    /** The lakes each realm's band runs round: its shore follows the drawn lake, not the hex edges. */
    const shoreLakes = new Map<string, Set<number>>();
    const touchLake = (owner: string, j: number) => {
      const k = lakeOf.get(j);
      if (k === undefined) return;
      shoreLakes.set(owner, (shoreLakes.get(owner) ?? new Set()).add(k));
    };
    /** Land a realm colours outside its own hexes: lake-hex sectors facing it and coast notches filled in. */
    const extraLand = new Map<string, PathCmd[]>();
    const addLand = (owner: string, d: PathCmd[]) => extraLand.set(owner, [...(extraLand.get(owner) ?? []), ...d]);
    for (let i = 0; i < cols * rows; i++) {
      if (!isLakeHex(i)) continue;
      lakeSectorDonors(i).forEach((donor, e) => {
        const owner = polities.owner[donor];
        if (!owner) return;
        const [c, a, b] = sectorPoints(i, e);
        addLand(owner, [['M', c!.x, c!.y], ['L', a!.x, a!.y], ['L', b!.x, b!.y], ['Z']]);
        touchLake(owner, i);
      });
    }
    for (const sliver of traced?.geometry.toLand ?? []) {
      const owner = polities.owner[sliver.donor];
      if (owner) addLand(owner, sliver.d);
    }
    // The banks of a strait belong to the realms whose land they face.
    for (const [i, split] of terrain?.split ?? []) {
      split.sides.forEach((side, p) => {
        const owner = side === 'land' ? polities.owner[split.donors[p]!] : null;
        if (!owner || split.donors[p] === i) return;
        const pts = piecePoints(i % cols, Math.floor(i / cols), p, size);
        addLand(owner, [...pts.map((q, k) => [k === 0 ? 'M' : 'L', q.x, q.y] as PathCmd), ['Z']]);
      });
    }
    // Where a realm meets the sea, its band follows the coast: the traced
    // coast edges (through split hexes too) whose land is the realm's.
    for (const chain of traced?.geometry.chains ?? []) {
      for (const edge of chain.edges) {
        const owner = polities.owner[edge.land];
        if (owner && !isIsland(edge.land)) bands.set(owner, [...(bands.get(owner) ?? []), edge]);
      }
    }
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const i = hexIndex(cols, col, row);
        const owner = polities.owner[i];
        if (!owner || isIsland(i)) continue;
        regions.set(owner, [...(regions.get(owner) ?? []), i]);
        if (lakeOf.has(i)) touchLake(owner, i);
        for (let e = 0; e < 6; e++) {
          const n = neighbourOf(col, row, e);
          const inside = inBounds(cols, rows, n.col, n.row);
          const j = inside ? hexIndex(cols, n.col, n.row) : -1;
          // What meets this edge on either side, piece by piece: water on
          // either side is coast, which the coast edges above already cover.
          const mine = terrain ? pieceSurface(terrain, i, 6 + e) : 'land';
          const across = inside && terrain ? pieceSurface(terrain, j, 6 + ((e + 3) % 6)) : null;
          if (inside && (across === 'lake' || isLakeHex(j))) {
            touchLake(owner, j);
            continue;
          }
          if (mine !== 'land' || (inside && across !== 'land' && across !== null)) continue;
          const acrossDonor = inside && terrain ? pieceDonor(terrain, j, 6 + ((e + 3) % 6)) : j;
          const other = inside && !isIsland(j) ? polities.owner[acrossDonor] ?? null : null;
          if (other === owner) continue;
          const [a, b] = hexEdgePoints(col, row, e, size);
          if (other && topLevel.get(other) === topLevel.get(owner)) {
            // Between two parts of one realm: a single fine dashed line on the
            // edge itself, drawn once, so the realm still reads as one.
            if (j > i) internal.push(['M', a.x, a.y], ['L', b.x, b.y]);
            continue;
          }
          const edge = { from: a, to: b, land: i, water: j };
          bands.set(owner, [...(bands.get(owner) ?? []), edge]);
          // A frontier between realms on land, drawn from one side only.
          const landAcross = inside && across === 'land' && !isIsland(j);
          if (landAcross && (other === null || owner < other)) frontier.push(edge);
        }
      }
    }
    const band =
      knobs.polityStyle === 'wash'
        ? { width: size * 0.6, alpha: 0.55 }
        : knobs.polityStyle === 'tint'
          ? { width: size * 0.32, alpha: 0.75 }
        : knobs.polityStyle === 'outline'
          ? { width: size * 0.09, alpha: 1 }
          : { width: Math.max(1.5, size * 0.16), alpha: 1 };
    // Bands stop at the water as drawn: the smoothed coast's water notches
    // and every lake body are cut out of where a band may be painted.
    const landMask: PathCmd[] = [
      ['M', -size, -size], ['L', width + size, -size], ['L', width + size, height + size], ['L', -size, height + size], ['Z'],
      ...(traced?.geometry.toWater ?? []).flatMap((sliver) => sliver.d),
      ...lakeOutlines,
      // The sea in split hexes (their lake water lies under the lake bodies).
      ...[...(terrain?.split ?? [])].flatMap(([i, split]) =>
        split.sides.flatMap((side, p) =>
          side === 'sea'
            ? [...piecePoints(i % cols, Math.floor(i / cols), p, size).map((q, k) => [k === 0 ? 'M' : 'L', q.x, q.y] as PathCmd), ['Z'] as PathCmd]
            : [],
        ),
      ),
    ];
    for (const owner of new Set([...bands.keys(), ...shoreLakes.keys()])) {
      const loops = chainEdges(bands.get(owner) ?? []).flatMap((chain) =>
        chain.points.map((p, k) => [k === 0 ? 'M' : 'L', p.x, p.y] as PathCmd).concat(chain.closed ? [['Z'] as PathCmd] : []),
      );
      const shores = [...(shoreLakes.get(owner) ?? [])].flatMap((k) => lakeShores[k] ?? []);
      const colour = polityColour.get(owner) ?? '#888888';
      prims.push({
        kind: 'group',
        clip: [...hexesPath(regions.get(owner) ?? [], cols, size), ...(extraLand.get(owner) ?? [])],
        prims: [{
          kind: 'group',
          clip: landMask,
          clipRule: 'evenodd',
          prims: [{
            kind: 'path',
            d: [...loops, ...shores],
            stroke: band.alpha < 1 ? withAlpha(colour, band.alpha) : colour,
            strokeWidth: band.width * 2,
            round: true,
          }],
        }],
      });
    }
    // A fine ink line where one realm ends and the next begins.
    if (knobs.frontier !== 'none' && frontier.length > 0) {
      const d = chainEdges(frontier).flatMap((chain) =>
        chain.points.map((p, k) => [k === 0 ? 'M' : 'L', p.x, p.y] as PathCmd).concat(chain.closed ? [['Z'] as PathCmd] : []),
      );
      prims.push({
        kind: 'path',
        d,
        stroke: palette.frontier,
        strokeWidth: Math.max(0.8, size * 0.05),
        dash: knobs.frontier === 'dashed'
          ? [size * 0.22, size * 0.12]
          : knobs.frontier === 'dashdot'
            ? [size * 0.3, size * 0.1, size * 0.04, size * 0.1]
            : undefined,
        round: true,
      });
    }
  }

  if (internal.length > 0) {
    prims.push({
      kind: 'path',
      d: internal,
      stroke: palette.frontier,
      strokeWidth: Math.max(0.8, size * 0.045),
      dash: [size * 0.16, size * 0.1],
      round: true,
    });
  }

  // --- drawn relief and vegetation ----------------------------------------------------
  if (relief === 'illustrated' && base) {
    const vegetation = opts.visible.vegetation ? layers.vegetation.data : null;
    const placed: Placed[] = [];
    for (let i = 0; i < cols * rows; i++) {
      if (isWater(i) || inLakeBody.has(i)) continue;
      const height = elevationData?.[i] ?? null;
      const cover = vegetation?.[i] ?? null;
      if (!height && !cover) continue;
      const centre = hexCenter(i % cols, Math.floor(i / cols), size);
      const rand = (k: number) => unit(seed, 'symbol', i, k);
      const colours = { ground: groundColour(i), ink: palette.ink };
      if (height) placed.push(...reliefSymbols(centre, size, height, rand, colours));
      if (height === 'Plateau') {
        // Escarpments wherever the plateau falls away to lower ground or water.
        for (let e = 0; e < 6; e++) {
          const n = neighbourOf(i % cols, Math.floor(i / cols), e);
          if (!inBounds(cols, rows, n.col, n.row)) continue;
          const j = hexIndex(cols, n.col, n.row);
          // The coast (and an ice edge) already marks where land meets water.
          if (isWater(j) || inLakeBody.has(j) || base[j] === 'Ice') continue;
          const there = elevationData?.[j] ?? null;
          if (there === 'Plateau' || there === 'Highland' || there === 'Mountains') continue;
          const [a, b] = hexEdgePoints(i % cols, Math.floor(i / cols), e, size);
          placed.push(escarpment(a, b, centre, size, colours, (k) => rand(600 + e * 20 + k)));
        }
      }
      if (cover) {
        const crowded = height === 'Mountains' || height === 'Highland' || height === 'Hills' || height === 'Plateau';
        if (height !== 'Mountains') placed.push(...vegetationSymbols(centre, size, cover, rand, colours, crowded));
      }
    }
    placed.sort((a, b) => a.y - b.y);
    for (const p of placed) prims.push(...p.prims);
  }

  // --- rivers --------------------------------------------------------------
  const rivers = opts.visible.rivers ? layers.rivers.data : null;
  const tapered = knobs.rivers === 'tapered';
  const courses = new Map<string, Point[]>();
  // A river emptying into a small lake runs on into the lake's body.
  const tapering: Map<string, RiverCourse> = rivers && tapered
    ? riverCourses(rivers.rivers, size, seed, (river) => {
        // The lake hex across an edge, if any: its centre is a point in its water.
        const lakeAcross = (seg: RiverSegment | undefined, edge: number | null): Point | null => {
          if (!seg || edge === null) return null;
          const n = neighbourOf(seg.col, seg.row, edge);
          if (!inBounds(cols, rows, n.col, n.row) || !isLakeHex(hexIndex(cols, n.col, n.row))) return null;
          return hexCenter(n.col, n.row, size);
        };
        const first = river.segments[0];
        const last = river.segments.at(-1);
        return {
          before: river.fromLake ? lakeAcross(first, first?.entryEdge ?? null) : null,
          beyond: lakeAcross(last, last?.exitEdge ?? null),
          inWater: inLakeWater,
        };
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
      const runs: Array<{ points: Point[]; navigable: boolean }> = [];
      const flush = () => {
        if (run.length > 1) runs.push({ points: run, navigable: Boolean(runNavigable) });
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
      // A river out of or into a lake starts or stops at the lake's drawn shore.
      const toShore = (wet: Point, dry: Point): Point => {
        let a = wet;
        let b = dry;
        for (let k = 0; k < 12; k++) {
          const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          if (inLakeWater(m)) a = m;
          else b = m;
        }
        return b;
      };
      const head = runs[0]?.points;
      if (head && head.length > 1 && inLakeWater(head[0]!) && !inLakeWater(head[1]!)) head[0] = toShore(head[0]!, head[1]!);
      const tail = runs.at(-1)?.points;
      if (tail && tail.length > 1 && inLakeWater(tail.at(-1)!) && !inLakeWater(tail.at(-2)!)) {
        tail[tail.length - 1] = toShore(tail.at(-1)!, tail.at(-2)!);
      }
      for (const r of runs) {
        prims.push({
          kind: 'polyline',
          points: r.points,
          stroke: r.navigable ? palette.river : palette.riverNonNavigable,
          strokeWidth: r.navigable ? Math.max(2.5, size * 0.2125) : Math.max(1.25, size * 0.1125),
          round: true,
          smooth: true,
        });
      }
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
  /** A city marker's radius: grows with population, at a little under the old markers' weight. */
  const markerRadius = (population: number) =>
    0.85 * Math.max(size * 0.16, Math.min(size * 0.46, size * 0.1 * Math.log10(Math.max(10, population))));
  if (cities) {
    for (const city of cities.cities) {
      const c = siteOf(city);
      const r = markerRadius(city.population);
      // Mark which edges are coastal, since "coastal" is edge-specific here.
      // Dashed and water-coloured so it never reads as a polity border.
      for (const edge of knobs.cityCoastMarks ? city.coastalEdges : []) {
        const [a, b] = hexEdgePoints(city.col, city.row, edge, size);
        prims.push({
          kind: 'polyline',
          points: [a, b],
          stroke: MAP_COLOURS.coastMark,
          strokeWidth: Math.max(1, size * 0.06),
          dash: [size * 0.18, size * 0.14],
        });
      }
      const symbol = citySymbolForPopulation(city.population);
      if (knobs.cityMarkers === 'symbols') {
        prims.push({ kind: 'city', c, r, onRiver: city.onRiver, symbol, riverDot: palette.river, fill: palette.cityFill, ring: palette.cityRing });
      } else {
        prims.push(...cityMarker(knobs.cityMarkers, symbol, c, r, { ink: palette.cityFill, paper: palette.cityRing, river: palette.river }, (k) => unit(seed, 'city', city.id, k)));
      }
    }
  }

  // --- labels --------------------------------------------------------------
  // Realm names are placed first and avoid only the city markers; river and
  // range names follow their features; city names then take whichever slot
  // around their marker is free of all of those. A realm's name is never
  // pushed aside to make room for a city's.
  /** How far a city's marker reaches round its site, for names to keep clear of. */
  const markerReach = (population: number) => {
    const extent = markerExtent(knobs.cityMarkers, citySymbolForPopulation(population));
    return markerRadius(population) * Math.max(extent.half, (extent.up + extent.down) / 2);
  };
  const taken: OrientedBox[] = [];
  const lettering = LETTERINGS[knobs.lettering] ?? LETTERINGS.classic;
  const realmRole = lettering.realm;
  const subWeight = lighterWeight(realmRole);
  if (opts.labels && polities) {
    const obstacles: LabelObstacle[] = [];
    for (const city of cities?.cities ?? []) {
      const c = siteOf(city);
      const r = markerReach(city.population);
      obstacles.push({ left: c.x - r, right: c.x + r, top: c.y - r, bottom: c.y + r });
    }
    // Without a hierarchy every realm is named once, from the cache. With one,
    // each level is named in turn, largest first: a realm across all its
    // parts, then the parts in smaller, lighter type clear of the realm's name.
    const depths = polityDepths(polities.polities);
    const maxDepth = Math.max(0, ...depths.values());
    const levels: Array<{ labels: PolityLabel[]; depth: number }> = [];
    if (maxDepth === 0) {
      levels.push({ labels: cachedPolityLabels(polities, cities, cols, rows, size, obstacles, opts.polityNames, knobs.realmNames, realmRole, lettering.id), depth: 0 });
    } else {
      const claimed: LabelObstacle[] = [...obstacles];
      for (let depth = 0; depth <= maxDepth; depth++) {
        const labels = placePolityLabels({
          cols,
          rows,
          size,
          owner: ownersAtDepth(polities.polities, polities.owner, depth),
          polities: polities.polities.filter((p) => depths.get(p.id) === depth),
          obstacles: claimed,
          minHexes: opts.polityNames,
          scale: depth === 0 ? 1 : 0.62 ** depth,
          sizing: knobs.realmNames,
          measure: (text) => roleEm(realmRole, text, depth === 0 ? realmRole.weight : subWeight),
        });
        for (const label of labels) {
          const em = Math.max(...label.lines.map((line) => roleEm(realmRole, line, depth === 0 ? realmRole.weight : subWeight)));
          claimed.push(labelBox(label.at, em * label.size, label.size * LABEL_LINE_EM * label.lines.length, label.rotation));
        }
        levels.push({ labels, depth });
      }
    }
    for (const { labels, depth } of levels) {
      for (const label of labels) {
        // Lines are stacked perpendicular to the baseline so a wrapped,
        // rotated name stays a single rigid block.
        label.lines.forEach((line, k) => {
          const offset = (k - (label.lines.length - 1) / 2) * label.size * LABEL_LINE_EM;
          const at = {
            x: label.at.x - offset * Math.sin(label.rotation),
            y: label.at.y + offset * Math.cos(label.rotation),
          };
          const weight = depth === 0 ? realmRole.weight : subWeight;
          prims.push({
            kind: 'text',
            at,
            text: line,
            size: label.size,
            fill: depth === 0 ? palette.label : withAlpha(palette.label, 0.78),
            weight,
            anchor: 'middle',
            fantasy: true,
            font: realmRole.family,
            rotation: label.rotation,
            ...(realmRole.tracking > 0
              ? { glyphs: glyphsStraight(line, label.size, at, label.rotation, { ...realmRole, weight }) }
              : {}),
          });
        });
        const weight = depth === 0 ? realmRole.weight : subWeight;
        const em = Math.max(...label.lines.map((line) => roleEm(realmRole, line, weight)));
        taken.push({
          cx: label.at.x,
          cy: label.at.y,
          halfW: (em * label.size) / 2,
          halfH: (label.size * LABEL_LINE_EM * label.lines.length) / 2,
          rotation: label.rotation,
        });
      }
    }
  }

  // --- river and mountain range names -------------------------------------
  if (rivers && opts.riverNames) {
    const pathFor = tapered ? (id: string) => courses.get(id) ?? null : undefined;
    for (const l of placeRiverLabels(rivers.rivers, size, pathFor, lettering.river, taken)) {
      prims.push({
        kind: 'text',
        at: l.at,
        text: l.text,
        size: l.size,
        fill: palette.riverLabel,
        halo: palette.labelHalo,
        weight: lettering.river.weight,
        anchor: 'middle',
        fantasy: true,
        font: lettering.river.family,
        italic: lettering.river.italic,
        rotation: l.rotation,
        glyphs: l.glyphs,
      });
      for (const g of l.glyphs ?? []) {
        taken.push({ cx: g.x, cy: g.y, halfW: l.size * 0.4, halfH: l.size * 0.6, rotation: g.rotation });
      }
    }
  }
  if (opts.rangeNames && opts.visible.elevation && layers.elevation.data) {
    const rangeRole = lettering.range;
    for (const l of placeRangeLabels(map.mountainRanges ?? [], layers.elevation.data, cols, size, rangeRole)) {
      prims.push({
        kind: 'text',
        at: l.at,
        text: l.text,
        size: l.size,
        fill: palette.rangeLabel,
        halo: palette.labelHalo,
        weight: rangeRole.weight,
        anchor: 'middle',
        fantasy: true,
        font: rangeRole.family,
        italic: rangeRole.italic,
        rotation: l.rotation,
        glyphs: l.glyphs,
      });
      taken.push({ cx: l.at.x, cy: l.at.y, halfW: (roleEm(rangeRole, l.text) * l.size) / 2, halfH: l.size * 0.6, rotation: l.rotation });
    }
  }

  if (opts.seaNames && base && (map.waterNames?.length ?? 0) > 0) {
    for (const l of placeWaterLabels(map.waterNames!, cols, size, lettering.water)) {
      prims.push({
        kind: 'text',
        at: l.at,
        text: l.text,
        size: l.size,
        fill: palette.riverLabel,
        weight: lettering.water.weight,
        anchor: 'middle',
        fantasy: true,
        font: lettering.water.family,
        italic: lettering.water.italic,
        rotation: l.rotation,
        glyphs: l.glyphs,
      });
      for (const g of l.glyphs ?? []) {
        taken.push({ cx: g.x, cy: g.y, halfW: l.size * 0.5, halfH: l.size * 0.6, rotation: g.rotation });
      }
    }
  }

  if (opts.labels && cities) {
    const fontSize = Math.max(8, size * 0.36) * (lettering.city.scale ?? 1);
    const placements = placeCityNames(
      cities.cities.map((city) => ({
        id: city.id,
        name: city.name,
        at: siteOf(city),
        r: markerReach(city.population),
        population: city.population,
      })),
      fontSize,
      (text) => roleEm(lettering.city, text) * fontSize,
      taken,
      { width, height },
      knobs.cityNames,
    );
    const byId = new Map(cities.cities.map((c) => [c.id, c]));
    for (const p of placements) {
      prims.push({
        kind: 'text',
        at: p.at,
        text: byId.get(p.id)!.name,
        size: fontSize,
        fill: palette.label,
        halo: palette.labelHalo,
        weight: lettering.city.weight,
        anchor: p.anchor,
        font: lettering.city.family,
        ...(lettering.city.italic ? { italic: true } : {}),
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
