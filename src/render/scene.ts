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
  type HexDimensions,
  LAYER_ORDER,
  hexShapeFor,
  isIslandType,
  islandSpecFor,
  type HexShape,
  type IslandSpec,
  type Irregularity,
  lakeShoreIrregularity,
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
import { placeAreaLabels, placeRangeLabels, placeRiverLabels, placeWaterLabels } from './featureLabels.js';
import { geoEligibility, geoNamesOf, liveHexes } from '../../shared/geoNames.js';
import type { GeoNameKind } from '../../shared/types.js';
import {
  LABEL_LINE_EM,
  claimBox,
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
  alike,
  coastKey,
  drawnLand,
  circlePath,
  coastalIslandSide,
  coastGeometryOf,
  landInsetDepth,
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
  type CoastEdge,
  raggedEdge,
} from './coast.js';
import { polygonPath, type CitySymbol, type PathCmd, type Prim } from './prims.js';
import { capitalCrown, cityMarker, markerExtent } from './cityMarkers.js';
import { riverCourses, type RiverCourse } from './rivers.js';
import { citySite } from './sites.js';
import { escarpment, hillshade, reliefSymbols, vegetationSymbols, type Placed } from './symbols.js';
import { ownersAtDepth, polityDepths, polityDisplayColours, toned } from './hierarchy.js';
import { topLevelOf } from '../../shared/polityTree.js';
import { measureEpoch, textEm } from './fonts.js';
import { glyphAdvances, glyphsStraight } from './glyphs.js';
import { BUNDLED_FACES, LETTERINGS, type FaceRole } from './lettering.js';
import { signed, unit } from './seed.js';
import { ELEVATION_RANK, floeFringe, glacierEdges, glacierFlow, glacierMarginPrims, glacierShading, glacierShelf, iceSeam, nearHexes, pathPolylines, seaIcePrims } from './ice.js';
import { landFraction, normaliseHexDimensions } from '../../shared/surfaceArea.js';
import { CLASSIC_STYLE, type ElevationStyle, type MapStyle } from './styles.js';
import { extendToRim, rimPieces } from './rim.js';
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
  /** Name land features and islands that have been named (needs the base layer visible). */
  landNames?: boolean;
  /** Smallest polity, in hexes, that is named; default 4. */
  polityNames?: PolityNameMin;
  elevationStyle?: ElevationStyle;
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
  elevationStyle: ElevationStyle = 'colour',
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
  /** How far in from its own edges each partly-land hex (Coastal Land, Glacier) has its water-facing edges drawn. */
  insets: Map<number, number>;
}

const coastCache = new WeakMap<object, TracedCoast & { key: string }>();

/** How far (in hex sizes) a smoothed coast may stray from its plain line, by irregularity. */
/** How an island's outline is roughened by irregularity: its wobble against the usual (Irregular), extra control points, and skerries off each large island. */
const ISLE_IRREGULARITY: Record<Irregularity, { wobble: number; extraPoints: number; skerries: number }> = {
  Smooth: { wobble: 0.35, extraPoints: 0, skerries: 0 },
  Wavy: { wobble: 1, extraPoints: 0, skerries: 0 },
  Ragged: { wobble: 1.6, extraPoints: 4, skerries: 1 },
  Fractured: { wobble: 2.3, extraPoints: 8, skerries: 3 },
};

const COAST_AMPLITUDE: Record<Irregularity, number> = { Smooth: 0, Wavy: 0.06, Ragged: 0.12, Fractured: 0.2 };

/** A stable signature of the hexes' shape settings, computed once per settings object. */
const shapesSignatures = new WeakMap<object, string>();
function shapesSignature(shapes: Record<string, HexShape> | undefined): string {
  if (!shapes) return '';
  let hit = shapesSignatures.get(shapes);
  if (hit === undefined) {
    hit = JSON.stringify(shapes);
    shapesSignatures.set(shapes, hit);
  }
  return hit;
}

function cachedCoast(
  base: ReadonlyArray<BaseGeo | null>,
  cols: number,
  rows: number,
  size: number,
  smooth: boolean,
  shapes: Record<string, HexShape> | undefined,
  defaultIrregularity: Irregularity | undefined,
  dimensions: HexDimensions,
  seed: string,
): TracedCoast {
  const key = `${cols}x${rows}@${size}/${smooth}/${seed}/${defaultIrregularity ?? ''}/${shapesSignature(shapes)}/${dimensions.coastalLandPercent},${dimensions.glacierPercent}`;
  const hit = coastCache.get(base);
  if (hit && hit.key === key) return hit;
  const lakeIslands = lakeIslandsOf(base, cols, rows);
  const surface = surfaceMap(base, cols, rows, lakeIslands);
  const { lakes } = lakeComponents(base, cols, rows, surface);
  // How ragged each coast edge is drawn: the larger of the two hexes it divides
  // (island hexes shape their own islands, not the coast beside them), halved
  // in a hex split into land and water, where a neck must not be pinched shut.
  const amplitudeOf = (i: number | undefined): number => {
    if (i === undefined || base[i] === 'Islands') return 0;
    return COAST_AMPLITUDE[hexShapeFor(base[i], shapes?.[String(i)], defaultIrregularity).irregular] * (surface.split.has(i) ? 0.5 : 1);
  };
  // The sea's coast: lakes count as land here, as they have bodies of their own.
  const seaEdges = surfaceEdges(surface, size, (side) => side !== 'sea');
  // A coastal or glacier hex that is not all land is drawn with its coast set in
  // from the hex's own edge, far enough that the land left is its share.
  // The edges it has against a lake count too: the lake is drawn over the hex, so
  // its shore keeps the same depth (see `lakeBodyPath`'s `inset`).
  const lakeEdges = surfaceEdges(surface, size, (side) => side !== 'lake').filter((edge) => edge.across !== undefined && surface.whole[edge.across] === 'lake');
  const wetEdges = new Map<number, CoastEdge[]>();
  for (const edge of [...seaEdges, ...lakeEdges]) {
    const i = edge.hex;
    if (i === undefined || (base[i] !== 'Coastal Land' && base[i] !== 'Glacier')) continue;
    wetEdges.set(i, [...(wetEdges.get(i) ?? []), edge]);
  }
  const insets = new Map<number, number>();
  for (const [i, wet] of wetEdges) {
    const share = landFraction(base[i], undefined, dimensions, shapes?.[String(i)]);
    if (share >= 1) continue;
    insets.set(i, landInsetDepth(hexCorners(i % cols, Math.floor(i / cols), size), wet, share));
  }
  const geometry = coastGeometryOf(
    seaEdges,
    smooth,
    smooth
      ? {
          size,
          amplitude: (edge: CoastEdge) => Math.max(amplitudeOf(edge.hex), amplitudeOf(edge.across)),
          noise: (x, y, k) => unit(seed, 'coast', Math.round(x * 1000), Math.round(y * 1000), k),
        }
      : undefined,
    insets.size > 0
      ? {
          depth: (edge) => insets.get(edge.hex ?? -1) ?? 0,
          hex: (edge) => hexCorners((edge.hex ?? 0) % cols, Math.floor((edge.hex ?? 0) / cols), size),
        }
      : undefined,
  );
  const entry = { key, geometry, lakes, lakeIslands, surface, insets };
  coastCache.set(base, entry);
  return entry;
}

/**
 * The owners the map is drawn with: only land carries a realm's colour (a
 * strait's banks are land, so an owned strait keeps its owner). Sea
 * and lake hexes are drawn unowned even where the data gives them an owner
 * (the data is not changed); the land round a lake still takes the colour of
 * the realm it borders (see the lake sectors in `buildStaticScene`).
 */
const landOwnerCache = new WeakMap<object, { base: object; owner: (string | null)[] }>();

function landOwners(owner: (string | null)[], base: ReadonlyArray<BaseGeo | null>): (string | null)[] {
  const hit = landOwnerCache.get(owner);
  if (hit && hit.base === base) return hit.owner;
  const out = owner.map((o, i) => (base[i] === 'Sea' || base[i] === 'Lake' ? null : o));
  landOwnerCache.set(owner, { base, owner: out });
  return out;
}

/**
 * The owners realm names are placed with: land owners, plus every lake whose
 * whole shore is one realm's, so a name may run across a lake inside its
 * realm (a lake shared between realms stays water). Drawing still colours
 * land only.
 */
const labelOwnerCache = new WeakMap<object, { lakes: object; owner: (string | null)[] }>();

function labelOwners(owner: (string | null)[], lakes: number[][], cols: number, rows: number): (string | null)[] {
  const hit = labelOwnerCache.get(owner);
  if (hit && hit.lakes === lakes) return hit.owner;
  const out = owner.slice();
  const inLake = new Set(lakes.flat());
  for (const lake of lakes) {
    const shore = new Set<string | null>();
    for (const i of lake) {
      for (let e = 0; e < 6; e++) {
        const n = neighbourOf(i % cols, Math.floor(i / cols), e);
        if (!inBounds(cols, rows, n.col, n.row)) continue;
        const j = hexIndex(cols, n.col, n.row);
        if (!inLake.has(j)) shore.add(owner[j] ?? null);
      }
    }
    const [realm] = [...shore];
    if (shore.size !== 1 || !realm) continue;
    for (const i of lake) if (!out[i]) out[i] = realm;
  }
  labelOwnerCache.set(owner, { lakes, owner: out });
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
  const rimBounds = { width, height };
  const prims: Prim[] = [];
  const seed = map.id;
  const uniformLand = opts.uniformLand ?? knobs.land === 'uniform';

  const base = opts.visible.base ? layers.base.data : null;
  // An explicit elevationStyle (the older two-way setting) overrides the style's relief.
  const relief = opts.elevationStyle
    ? opts.elevationStyle === 'colour' ? 'colour' : opts.elevationStyle === 'none' ? 'none' : 'marks'
    : knobs.relief;
  const elevationStyle: ElevationStyle = relief === 'colour' ? 'colour' : relief === 'none' ? 'none' : 'contours';
  // With relief 'none' the elevation layer plays no part in the picture.
  const showElevation = opts.visible.elevation && relief !== 'none';
  const thematic = thematicLayer(map, opts.visible, elevationStyle);
  const elevationData = showElevation ? layers.elevation.data : null;

  const population = opts.visible.population ? layers.population.data : null;
  const maxPop = population ? Math.max(1, ...population.map((v) => v ?? 0)) : 1;

  const traced = base ? cachedCoast(base, cols, rows, size, knobs.coast === 'smooth', map.hexShapes, map.defaultIrregularity, normaliseHexDimensions(map.hexDimensions), seed) : null;
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
      case 'Glacier':
        return palette.ice;
      case 'Sea Ice':
        return palette.seaIce;
    }
  };

  /**
   * How far a glacier's ice is darkened toward its shade colour by the ground
   * under it: low ice (a sheet or shelf) is dull and bluish, ice on high ground
   * is bright. Only where elevation is shown.
   */
  const GLACIER_SHADE: Record<Elevation, number> = {
    Lowland: 0.45, Rolling: 0.32, Hills: 0.2, Plateau: 0.12, Highland: 0.06, Mountains: 0,
  };
  // Textured ice is one sheet, a little dulled where elevation is shown, whose height is
  // then shaded softly over it (below), brighter above its colour and duller below, not hex by hex.
  const ICE_SHEET = 0.28;
  const texturedIce = knobs.ice === 'glacier';
  const organicIce = texturedIce && knobs.coast === 'smooth';
  /** How ragged a hex's outline is drawn. */
  const levelOf = (i: number): Irregularity => hexShapeFor(base?.[i], map.hexShapes?.[String(i)], map.defaultIrregularity).irregular;
  const glacierFill = (i: number): string => {
    const height = elevationData?.[i];
    if (texturedIce) return height ? mix(palette.ice, palette.iceShade, ICE_SHEET) : palette.ice;
    return height ? mix(palette.ice, palette.iceShade, GLACIER_SHADE[height]) : palette.ice;
  };

  const hexFill = (i: number): string => {
    let fill = MAP_COLOURS.emptyHex;
    const baseValue = base ? base[i] : null;
    if (baseValue) fill = baseValue === 'Glacier' && !thematic ? glacierFill(i) : baseColour(baseValue);
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

      if (relief === 'marks' && showElevation) {
        const elevation = layers.elevation.data?.[i];
        if (elevation) prims.push(...elevationMarks(hexCenter(col, row, size), size, elevation));
      }

      for (const overlay of overlays(own)) prims.push({ kind: 'polygon', points: corners, fill: overlay });
    }
  }

  // --- glacier ground ----------------------------------------------------------------
  const glacierHexes: number[] = [];
  base?.forEach((v, i) => {
    if (v === 'Glacier') glacierHexes.push(i);
  });
  /** Where the ice margin on dry land is drawn, when it is not the hex edge. */
  let iceMargin: CoastGeometry | null = null;
  if (base && texturedIce && glacierHexes.length > 0) {
    if (organicIce) {
      iceMargin = glacierEdges({
        cols,
        rows,
        size,
        glacier: new Set(glacierHexes),
        isWater: (j) => sideOf(base[j]) === 'water',
        levelOf,
        rankOf: (j) => (elevationData?.[j] ? ELEVATION_RANK[elevationData[j]!] : null),
        noise: (x, y, k) => unit(seed, 'ice-margin', Math.round(x * 1000), Math.round(y * 1000), k),
      });
      // Ground regained from the ice and ice gained over the ground beside it,
      // each in the colours of the hex it belongs to.
      for (const sliver of [...iceMargin.toWater, ...iceMargin.toLand]) {
        const donor = inLakeBody.has(sliver.donor) ? lakeShoreDonor(sliver.donor) : sliver.donor;
        const fill = hexFill(donor);
        prims.push({ kind: 'path', d: sliver.d, fill, stroke: fill, strokeWidth: seal });
        for (const overlay of overlays(donor)) prims.push({ kind: 'path', d: sliver.d, fill: overlay });
      }
    }
    // The ice as drawn: its hexes, with what the margin adds and takes away (even-odd).
    const iceRegion: PathCmd[] = [
      ...hexesPath(glacierHexes, cols, size),
      ...(iceMargin ? [...iceMargin.toLand, ...iceMargin.toWater].flatMap((sliver) => sliver.d) : []),
    ];
    const surface: Prim[] = [];
    /** Hexes whose ice flows downhill in strokes; level ice is cracked with crevasses instead. */
    let flowing = new Set<number>();
    if (!thematic && elevationData) {
      const rankAt = (j: number) => (elevationData[j] ? ELEVATION_RANK[elevationData[j]!] : null);
      surface.push(
        ...glacierShading(
          glacierHexes.flatMap((i) => {
            const rank = rankAt(i);
            return rank === null ? [] : [{ c: hexCenter(i % cols, Math.floor(i / cols), size), rank }];
          }),
          size,
          { dull: palette.iceShade, bright: '#ffffff' },
          withAlpha,
        ),
      );
      // Ice runs downhill: on a slope, strokes lead off towards the lowest ground beside it.
      const flows: Array<{ i: number; c: Point; to: Point }> = [];
      for (const i of glacierHexes) {
        const rank = rankAt(i);
        if (rank === null || rank < 1 || rank > 3) continue;
        let lowest = rank;
        let toward = -1;
        for (let e = 0; e < 6; e++) {
          const n = neighbourOf(i % cols, Math.floor(i / cols), e);
          if (!inBounds(cols, rows, n.col, n.row)) continue;
          const j = hexIndex(cols, n.col, n.row);
          const there = sideOf(base[j]) === 'water' ? -1 : rankAt(j) ?? rank;
          if (there < lowest) {
            lowest = there;
            toward = j;
          }
        }
        if (toward >= 0) flows.push({ i, c: hexCenter(i % cols, Math.floor(i / cols), size), to: hexCenter(toward % cols, Math.floor(toward / cols), size) });
      }
      flowing = new Set(flows.map((f) => f.i));
      surface.push(...glacierFlow(flows, size, seed, withAlpha(mix(palette.ice, palette.iceShade, 0.9), 0.8)));
    }
    if (!thematic) {
      for (const i of glacierHexes) {
        if (flowing.has(i)) continue;
        const height = elevationData?.[i];
        // On rising ground the relief marks show instead.
        if (!height || ELEVATION_RANK[height] <= 3) surface.push(...crevasses(hexCenter(i % cols, Math.floor(i / cols), size), size, seed, i, palette.iceShade));
      }
    }
    if (iceMargin) {
      const paths = iceMargin.paths.flatMap((d, c) => extendToRim(d, iceMargin!.chains[c]?.closed ?? true, rimBounds, size));
      surface.push(
        ...glacierMarginPrims(paths, size, {
          frost: thematic ? 'rgba(255,255,255,0)' : withAlpha(mix(palette.ice, '#ffffff', 0.6), 0.6),
          line: withAlpha(mix(palette.iceShade, palette.coast, 0.5), 0.85),
        }),
      );
    }
    if (surface.length > 0) prims.push({ kind: 'group', clip: iceRegion, clipRule: 'evenodd', prims: surface });
  }

  // --- hill shading ----------------------------------------------------------------
  // Over the land's colours (realm fills included), so height reads through them.
  if (relief === 'hillshade' && elevationData) {
    for (let i = 0; i < cols * rows; i++) {
      const here = elevationData[i];
      // Textured ice is shaded by its ground already, in its own way.
      if (!here || isWater(i) || (texturedIce && base?.[i] === 'Glacier')) continue;
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
  // Sea ice lies on ordinary sea; its pack is drawn over the water below.
  const waterColour = (i: number) => (base?.[i] === 'Lake' ? palette.lake : palette.sea);
  const islands: number[] = [];
  /** The rim notches that are water, by body, so the sea's surface and its ice reach the page's edge. */
  const rimWater: Record<'sea' | 'lake', PathCmd[]> = { sea: [], lake: [] };
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
    // The notches the hex grid leaves at the page's edge belong to the border
    // hex beside them: what it is, they are, so nothing stops short of the rim.
    for (let i = 0; i < base.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      if (col > 0 && row > 0 && col < cols - 1 && row < rows - 1) continue;
      for (const piece of rimPieces(cols, rows, size, col, row, rimBounds)) {
        const split = terrain?.split.get(i);
        const surface = split ? split.sides[6 + piece.edge]! : isLakeHex(i) ? 'lake' : terrain?.whole[i] ?? (isWater(i) ? 'sea' : 'land');
        if (surface !== 'land') {
          const fill = surface === 'lake' ? palette.lake : palette.sea;
          prims.push({ kind: 'path', d: polygonPath(piece.points), fill, stroke: fill, strokeWidth: seal });
          rimWater[surface].push(...polygonPath(piece.points));
          continue;
        }
        const donor = split ? split.donors[6 + piece.edge]! : i;
        const fill = hexFill(donor);
        prims.push({ kind: 'path', d: polygonPath(piece.points), fill, stroke: fill, strokeWidth: seal });
        for (const overlay of overlays(donor)) prims.push({ kind: 'path', d: polygonPath(piece.points), fill: overlay });
      }
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
    /** A large island (it takes the large-island share) rather than a small one. */
    large: boolean;
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
          isles.push({ c: at(toward + Math.PI, r, along), rx: (nl === 1 ? 0.34 : 0.26) * size, ry: (nl === 1 ? 0.24 : 0.19) * size, axis: toward + Math.PI / 2, large: true });
        }
      } else if (coastalLarge) {
        for (let k = 0; k < nl; k++) {
          const along = nl === 1 ? 0 : (k - 0.5) * 0.6;
          isles.push({ c: at(toward, 0.4, along), rx: (nl === 1 ? 0.44 : 0.3) * size, ry: (nl === 1 ? 0.27 : 0.2) * size, axis: toward + Math.PI / 2, large: true });
        }
      } else if (nl === 1) {
        isles.push({ c, rx: (crowded ? 0.52 : 0.74) * size, ry: (crowded ? 0.44 : 0.62) * size, axis: rand(99) * Math.PI, large: true });
      } else {
        const axis = rand(98) * Math.PI;
        for (const sign of [-1, 1]) {
          isles.push({ c: at(axis, sign * 0.36), rx: (crowded ? 0.32 : 0.4) * size, ry: (crowded ? 0.26 : 0.32) * size, axis: axis + Math.PI / 2 + (rand(97 + sign) - 0.5), large: true });
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
      isles.push({ c: p, rx: rr * 1.25, ry: rr, axis: rand(600 + k) * Math.PI, large: false });
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
    const biggest = sizedIsles(i).sort((a, b) => b.rx * b.ry - a.rx * a.ry)[0];
    return biggest?.c ?? c;
  };
  const dimensions = normaliseHexDimensions(map.hexDimensions);
  /**
   * How many times its per-island share each island of a hex is drawn at: 1
   * unless the hex sets its own land share, in which case its islands share
   * what it sets (less the mainland's share in a mainland hex) in the same
   * proportions their own shares have.
   */
  const islandShareScale = (i: number): number => {
    const set = hexShapeFor(base![i], map.hexShapes?.[String(i)]).land;
    if (set === undefined) return 1;
    const spec = islandSpecFor(base![i], map.islandSpecs?.[String(i)]);
    const usual = spec.large * dimensions.largeIslandPercent + spec.small * dimensions.smallIslandPercent;
    const islands = terrain?.split.has(i) ? Math.max(0, set - dimensions.mainlandPercent) : set;
    return usual > 0 ? islands / usual : 1;
  };
  const hexArea = 1.5 * Math.sqrt(3) * size * size;
  /**
   * The islands of an island hex as drawn. The layout says where each lies and
   * its shape; its size is its share of the hex, so the land drawn is the
   * percentage the hex is set to. An island that would then spill over its
   * hex's edge is drawn nearer the centre.
   */
  const sizedIsles = (i: number): Isle[] => {
    const centre = hexCenter(i % cols, Math.floor(i / cols), size);
    const times = islandShareScale(i);
    return islandLayout(i).map((isle) => {
      const share = (isle.large ? dimensions.largeIslandPercent : dimensions.smallIslandPercent) * times;
      const area = (Math.min(100, Math.max(0, share)) / 100) * hexArea;
      const aspect = isle.rx / isle.ry;
      const rx = Math.min(size * 0.82, Math.sqrt((area * aspect) / Math.PI));
      const ry = Math.min(size * 0.82, Math.sqrt(area / (aspect * Math.PI)));
      const dx = isle.c.x - centre.x;
      const dy = isle.c.y - centre.y;
      const away = Math.hypot(dx, dy);
      const room = Math.max(0, size * 0.836 - Math.max(rx, ry) * 1.1);
      const f = away > room && away > 0 ? room / away : 1;
      return { ...isle, rx, ry, c: { x: centre.x + dx * f, y: centre.y + dy * f } };
    });
  };
  /** The islands of an island hex, as closed paths. */
  const islandPath = (i: number): PathCmd[] => {
    const rand = islandRand(i);
    const blob = knobs.islands === 'blob';
    const level = levelOf(i);
    const irregular = ISLE_IRREGULARITY[level];
    return sizedIsles(i).flatMap((isle, k) => {
      const sub = (q: number) => rand(1000 + k * 37 + q);
      const big = isle.large;
      const { rx, ry } = isle;
      if (rx <= 0 || ry <= 0) return [];
      if (!blob) return circlePath(isle.c, Math.sqrt(rx * ry));
      const body = blobPath(isle.c, rx, ry, isle.axis, sub, (big ? 12 : 9) + irregular.extraPoints, (big ? 0.16 : 0.18) * irregular.wobble);
      // Rugged and fractured islands shed skerries along their shores.
      const skerries: PathCmd[] = [];
      if (big) {
        for (let n = 0; n < irregular.skerries; n++) {
          const a = sub(2000 + n) * Math.PI * 2;
          const r = size * (0.035 + 0.035 * sub(2100 + n));
          const out = 1.25 + 0.35 * sub(2200 + n);
          skerries.push(...blobPath({ x: isle.c.x + Math.cos(a) * rx * out, y: isle.c.y + Math.sin(a) * ry * out }, r * 1.3, r, sub(2300 + n) * Math.PI, (q) => sub(2400 + n * 17 + q), 8, 0.2));
        }
      }
      return [...body, ...skerries];
    });
  };
  /** The coast's paths, those that run off the map carried on to the page's edge. */
  const coastPaths = coast?.paths.map((d, c) => extendToRim(d, coast.chains[c]?.closed ?? true, rimBounds, size)) ?? [];
  const shorelines: PathCmd[] = [...coastPaths.flat(), ...islands.filter((i) => !lakeIslands.has(i)).flatMap(islandPath)];

  /**
   * The water of one body (the sea, or lakes) as a clip: its whole hexes, the
   * open water of split hexes, and the corners the coast cuts off. Sea ice is
   * sea, and open to the same clip.
   */
  const waterClip = (body: 'sea' | 'lake'): PathCmd[] | null => {
    if (!base) return null;
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
    if (hexes.length === 0 && pieces.length === 0 && rimWater[body].length === 0) return null;
    return [
      ...hexesPath(hexes, cols, size),
      ...pieces,
      ...rimWater[body],
      ...(coast?.toWater ?? []).filter((s) => (base[s.donor] === 'Lake') === (body === 'lake')).flatMap((s) => s.d),
    ];
  };

  // The sea's surface, clipped to the water so the bands stop at the shore.
  if (base && coast && knobs.water !== 'flat' && shorelines.length > 0) {
    for (const body of ['sea', 'lake'] as const) {
      const clip = waterClip(body);
      if (!clip) continue;
      const water = body === 'lake' ? palette.lake : palette.sea;
      const surface = knobs.water === 'depth'
        ? depthBands(shorelines, size, water, shift(palette.seaShallow, palette.sea, water))
        : rippleBands(shorelines, size, water, palette.ripple, palette.rippleAlpha, body === 'lake' ? 1 : knobs.ripples);
      prims.push({ kind: 'group', clip, prims: surface });
    }
  }

  // --- ice ------------------------------------------------------------------------
  // Pack ice is one body laid over the sea, and glaciers calve bergs into it.
  const iceHexes: number[] = [];
  base?.forEach((v, i) => {
    if (v === 'Sea Ice' && !isSplit(i)) iceHexes.push(i);
  });
  const iceColours = {
    body: palette.seaIce,
    floe: mix(palette.ice, '#ffffff', 0.5),
    rim: mix(palette.seaIce, mix(palette.ice, '#ffffff', 0.5), 0.75),
    crack: mix(palette.seaIce, palette.iceShade, 0.85),
  };
  const iceNoise = (x: number, y: number, k: number) => unit(seed, 'ice-edge', Math.round(x * 1000), Math.round(y * 1000), k);
  const coastLines = coastPaths.flatMap((d) => pathPolylines(d));
  const nearGlacier = nearHexes(cols, rows, size, (i) => (base?.[i] === 'Glacier' ? levelOf(i) : null), 1.15);
  if (base && (iceHexes.length > 0 || (texturedIce && glacierHexes.length > 0))) {
    const clip = waterClip('sea');
    const drawn: Prim[] = [];
    if (iceHexes.length > 0) {
      const margin = size * 2;
      drawn.push(
        ...seaIcePrims({
          cols,
          rows,
          size,
          seed,
          iceHexes,
          levelOf,
          isLand: (j) => sides?.[j] === 'land',
          bounds: { x0: -margin, y0: -margin, x1: width + margin, y1: height + margin },
          colours: iceColours,
          textured: texturedIce,
          organic: knobs.coast === 'smooth',
          noise: iceNoise,
        }),
      );
    }
    // Bergs break off the glacier's coast, more of them the more irregular it is.
    if (texturedIce && knobs.coast === 'smooth' && glacierHexes.length > 0 && !thematic) drawn.push(...floeFringe(coastLines, size, seed, nearGlacier, iceColours));
    if (clip && drawn.length > 0) prims.push({ kind: 'group', clip, prims: drawn });
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
  /** How irregular a lake's shore is at a point: set by the land hex beside it, else by the map's lake default. */
  const lakeShoreAmplitude = (p: Point): number => {
    const { col, row } = pixelToOffset(p.x, p.y, size);
    const j = inBounds(cols, rows, col, row) ? hexIndex(cols, col, row) : -1;
    const land = j >= 0 && !isWater(j) && !inLakeBody.has(j) ? j : -1;
    return COAST_AMPLITUDE[lakeShoreIrregularity(land >= 0 ? base?.[land] : null, land >= 0 ? map.hexShapes?.[String(land)] : undefined, map.defaultLakeIrregularity)];
  };
  /** How far in a partly-land hex beside the lake has its shore drawn, at a point on it; negative elsewhere. */
  const lakeShoreInset = (p: Point): number => {
    const { col, row } = pixelToOffset(p.x, p.y, size);
    if (!inBounds(cols, rows, col, row)) return -1;
    return traced?.insets.get(hexIndex(cols, col, row)) ?? -1;
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
      { amplitude: lakeShoreAmplitude, noise: (x, y, k) => unit(seed, 'lake', Math.round(x * 1000), Math.round(y * 1000), k) },
      lakeShoreInset,
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

  // The slope of a glacier down to the sea, over its own land and the coast
  // notches filled in for it, and under the grid and the coastline.
  if (texturedIce && !thematic && glacierHexes.length > 0 && coastLines.length > 0) {
    const shelf = glacierShelf(coastLines, size, (p) => nearGlacier(p) !== null, {
      slope: mix(palette.ice, palette.iceShade, 0.38),
      edge: mix(palette.ice, '#ffffff', 0.8),
    });
    if (shelf.length > 0) {
      prims.push({
        kind: 'group',
        clip: [
          ...hexesPath(glacierHexes, cols, size),
          ...(coast?.toLand ?? []).filter((s) => base?.[s.donor] === 'Glacier').flatMap((s) => s.d),
        ],
        prims: shelf,
      });
    }
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
          // Where the ice ends on dry land the ice margin is the line, not the hex edge.
          if (iceMargin && inside && sides![i] === 'land' && sides![j] === 'land' && (base![i] === 'Glacier') !== (base![j] === 'Glacier')) continue;
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

  // Glacier against pack ice: ice on ice, so the coast's ink gives way to a pale seam.
  if (texturedIce && !thematic && glacierHexes.length > 0 && iceHexes.length > 0 && coastLines.length > 0) {
    const nearPack = nearHexes(cols, rows, size, (i) => (base?.[i] === 'Sea Ice' ? 'Smooth' : null), 1.25);
    prims.push(
      ...iceSeam(coastLines, size, (p) => nearGlacier(p) !== null && nearPack(p) !== null, mix(palette.seaIce, palette.iceShade, 0.35), Math.max(0.8, size * palette.coastWidth)),
    );
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
    /** The hex edges (hex * 6 + edge) a border between realms wanders along, rather than keeping to the edge. */
    const wanders = new Set<number>();
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
    // The banks of a strait belong to the realms whose land they face, unless
    // the strait hex is itself owned: then its own region colours them.
    for (const [i, split] of terrain?.split ?? []) {
      if (base?.[i] === 'Strait' && polities.owner[i]) continue;
      split.sides.forEach((side, p) => {
        const owner = side === 'land' ? polities.owner[split.donors[p]!] : null;
        if (!owner || split.donors[p] === i) return;
        const pts = piecePoints(i % cols, Math.floor(i / cols), p, size);
        addLand(owner, [...pts.map((q, k) => [k === 0 ? 'M' : 'L', q.x, q.y] as PathCmd), ['Z']]);
      });
    }
    // Where a realm meets the sea, its band follows the coast as drawn, ragged
    // or smoothed (through split hexes too): every coast chain with an edge of
    // the realm's land, cut to the realm's own ground by the clip below.
    const coastBands = new Map<string, PathCmd[]>();
    (traced?.geometry.chains ?? []).forEach((chain, c) => {
      const path = traced!.geometry.paths[c];
      if (!path) return;
      for (const owner of new Set(chain.edges.filter((edge) => !isIsland(edge.land)).map((edge) => polities.owner[edge.land]))) {
        if (owner) coastBands.set(owner, [...(coastBands.get(owner) ?? []), ...path]);
      }
    });
    /**
     * The line a border takes along a hex edge on land, as pieces. It wanders from
     * corner to corner, but a drawn coast does not pass through the corners it
     * rounds: where an end is on the coast, the line ends where the coast passes.
     */
    const wander = (a: Point, b: Point): Array<{ from: Point; to: Point }> => {
      const start = traced?.geometry.anchors.get(coastKey(a)) ?? a;
      const end = traced?.geometry.anchors.get(coastKey(b)) ?? b;
      return raggedEdge(start, end, knobs.borders, seed, size).map((q, k, all) => ({ from: k === 0 ? start : all[k - 1]!, to: q }));
    };
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
            if (j > i) {
              const joins = wander(a, b);
              internal.push(['M', joins[0]!.from.x, joins[0]!.from.y]);
              for (const { to } of joins) internal.push(['L', to.x, to.y]);
            }
            continue;
          }
          // Between realms on land the border wanders; where it meets the sea
          // it stays on the coast, which the coast bands above cover.
          const landAcross = inside && across === 'land' && !isIsland(j);
          if (landAcross) wanders.add(i * 6 + e);
          const pieces = landAcross
            ? wander(a, b).map((piece) => ({ ...piece, land: i, water: j }))
            : [{ from: a, to: b, land: i, water: j }];
          bands.set(owner, [...(bands.get(owner) ?? []), ...pieces]);
          // A frontier between realms on land, drawn from one side only.
          if (landAcross && (other === null || owner < other)) frontier.push(...pieces);
        }
      }
    }
    /** A realm's hexes with the edges it shares with another realm following the wandering border, so its band stops at the line drawn. */
    const realmGround = (hexes: number[]): PathCmd[] =>
      hexes.flatMap((i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const corners = hexCorners(col, row, size);
        const d: PathCmd[] = [['M', corners[0]!.x, corners[0]!.y]];
        for (let e = 0; e < 6; e++) {
          const [a, b] = hexEdgePoints(col, row, e, size);
          if (wanders.has(i * 6 + e)) {
            const line = wander(a, b);
            d.push(['L', line[0]!.from.x, line[0]!.from.y]);
            for (const { to } of line) d.push(['L', to.x, to.y]);
          }
          // On to the corner itself: where the border ends on the coast, its end is off the corner.
          d.push(['L', b.x, b.y]);
        }
        d.push(['Z']);
        // Grown a little, so that where this ground meets the coast patches
        // beside it (or a neighbour's) no hairline of land is left unclaimed.
        // What spills over lies under the border's line or past the coast.
        const c = hexCenter(col, row, size);
        return d.map((cmd) => (cmd[0] === 'Z' ? cmd : [cmd[0], c.x + (cmd[1] - c.x) * 1.03, c.y + (cmd[2] - c.y) * 1.03] as PathCmd));
      });
    const band =
      knobs.polityStyle === 'wash'
        ? { width: size * 0.6, alpha: 0.55 }
        : knobs.polityStyle === 'tint'
          ? { width: size * 0.32, alpha: 0.75 }
        : knobs.polityStyle === 'outline'
          ? { width: size * 0.09, alpha: 1 }
          : { width: Math.max(1.5, size * 0.16), alpha: 1 };
    // Bands stop at the water as drawn: they are cut to the land inside the
    // coast as it is drawn, less every lake body. (Cutting out the water
    // pieces instead goes wrong where one lies under land the coast has since
    // bulged over.)
    const landMask: PathCmd[] = traced
      ? [...drawnLand(traced.geometry, width, height, size), ...lakeOutlines]
      : [['M', -size, -size], ['L', width + size, -size], ['L', width + size, height + size], ['L', -size, height + size], ['Z']];
    /** Where a realm's band may be painted: its hexes and the coast land it has gained. */
    const ground = (owner: string, hexes: number[]): PathCmd[] => alike([...realmGround(hexes), ...(extraLand.get(owner) ?? [])]);
    for (const owner of new Set([...bands.keys(), ...coastBands.keys(), ...shoreLakes.keys()])) {
      const loops = [
        ...coastBands.get(owner) ?? [],
        ...chainEdges(bands.get(owner) ?? []).flatMap((chain) =>
          chain.points.map((p, k) => [k === 0 ? 'M' : 'L', p.x, p.y] as PathCmd).concat(chain.closed ? [['Z'] as PathCmd] : []),
        ),
      ];
      const shores = [...(shoreLakes.get(owner) ?? [])].flatMap((k) => lakeShores[k] ?? []);
      const colour = polityColour.get(owner) ?? '#888888';
      prims.push({
        kind: 'group',
        clip: ground(owner, regions.get(owner) ?? []),
        prims: [{
          kind: 'group',
          clip: landMask,
          clipRule: 'evenodd',
          prims: [
            // A see-through band shows the ground, which differs from hex to hex
            // (coastal land is darker), so it would change shade at every hex
            // edge it crosses: it lies on one even ground instead. Ice keeps its own.
            ...(band.alpha < 1
              ? [{
                  kind: 'group' as const,
                  clip: ground(owner, (regions.get(owner) ?? []).filter((i) => base?.[i] !== 'Glacier')),
                  prims: [{ kind: 'path' as const, d: [...loops, ...shores], stroke: baseColour('Land'), strokeWidth: band.width * 2, round: true }],
                }]
              : []),
            {
              kind: 'path',
              d: [...loops, ...shores],
              stroke: band.alpha < 1 ? withAlpha(colour, band.alpha) : colour,
              strokeWidth: band.width * 2,
              round: true,
            },
          ],
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
          // The coast already marks where land meets water.
          if (isWater(j) || inLakeBody.has(j)) continue;
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
  const riversFrom = prims.length;
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

  // A river stops at the shore of a hex drawn partly water, not at the hex's own edge.
  const strips = traced?.geometry.strips ?? [];
  if (strips.length > 0 && prims.length > riversFrom) {
    prims.push({
      kind: 'group',
      clip: [
        ['M', -size, -size], ['L', width + size, -size], ['L', width + size, height + size], ['L', -size, height + size], ['Z'],
        ...strips.flatMap((strip) => strip.d),
      ],
      clipRule: 'evenodd',
      prims: prims.splice(riversFrom),
    });
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
      if (city.capital) {
        prims.push(...capitalCrown(knobs.cityMarkers, symbol, c, r, { ink: palette.cityFill, paper: palette.cityRing }));
      }
    }
  }

  // --- labels --------------------------------------------------------------
  // Realm names are placed first and avoid only the city markers; river and
  // range names follow their features; city names then take whichever slot
  // around their marker is free of all of those. A realm's name is never
  // pushed aside to make room for a city's.
  /** How far a city's marker reaches round its site, for names to keep clear of. */
  const markerReach = (population: number, capital = false) => {
    const extent = markerExtent(knobs.cityMarkers, citySymbolForPopulation(population), capital);
    return markerRadius(population) * Math.max(extent.half, (extent.up + extent.down) / 2);
  };
  const taken: OrientedBox[] = [];
  const lettering = LETTERINGS[knobs.lettering] ?? LETTERINGS.classic;
  const realmRole = lettering.realm;
  const subWeight = lighterWeight(realmRole);
  const namingPolities = polities && traced
    ? { ...polities, owner: labelOwners(polities.owner, traced.lakes, cols, rows) }
    : polities;
  if (opts.labels && polities) {
    const obstacles: LabelObstacle[] = [];
    for (const city of cities?.cities ?? []) {
      const c = siteOf(city);
      const r = markerReach(city.population, city.capital);
      obstacles.push({ left: c.x - r, right: c.x + r, top: c.y - r, bottom: c.y + r });
    }
    // Without a hierarchy every realm is named once, from the cache. With one,
    // each level is named in turn, largest first: a realm across all its
    // parts, then the parts in smaller, lighter type clear of the realm's name.
    const depths = polityDepths(polities.polities);
    const maxDepth = Math.max(0, ...depths.values());
    const levels: Array<{ labels: PolityLabel[]; depth: number }> = [];
    if (maxDepth === 0) {
      levels.push({ labels: cachedPolityLabels(namingPolities!, cities, cols, rows, size, obstacles, opts.polityNames, knobs.realmNames, realmRole, lettering.id), depth: 0 });
    } else {
      const claimed: LabelObstacle[] = [...obstacles];
      for (let depth = 0; depth <= maxDepth; depth++) {
        const labels = placePolityLabels({
          cols,
          rows,
          size,
          owner: ownersAtDepth(polities.polities, namingPolities!.owner, depth),
          polities: polities.polities.filter((p) => depths.get(p.id) === depth),
          obstacles: claimed,
          minHexes: opts.polityNames,
          scale: depth === 0 ? 1 : 0.62 ** depth,
          sizing: knobs.realmNames,
          measure: (text) => roleEm(realmRole, text, depth === 0 ? realmRole.weight : subWeight),
        });
        for (const label of labels) {
          const em = Math.max(...label.lines.map((line) => roleEm(realmRole, line, depth === 0 ? realmRole.weight : subWeight)));
          claimed.push(claimBox(label.at, em * label.size, label.size * LABEL_LINE_EM * label.lines.length, label.rotation, label.size));
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
  if (opts.rangeNames && showElevation && layers.elevation.data) {
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

  const geoNames = base ? geoNamesOf(map) : [];
  /** The named areas of these kinds, cut down to the hexes that are still eligible. */
  const liveNames = (kinds: GeoNameKind[]) =>
    geoNames
      .filter((n) => kinds.includes(n.kind))
      .map((n) => ({ name: n.name, hexes: liveHexes(n, geoEligibility(n.kind, base!, cols, rows)) }))
      .filter((n) => n.hexes.length > 0);
  if (opts.seaNames && base) {
    for (const l of placeWaterLabels(liveNames(['sea', 'lake']), cols, size, lettering.water, base, rows)) {
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
  if (opts.landNames && base) {
    const landRole = lettering.range;
    for (const l of placeAreaLabels(liveNames(['land', 'island']), cols, size, landRole)) {
      prims.push({
        kind: 'text',
        at: l.at,
        text: l.text,
        size: l.size,
        fill: palette.rangeLabel,
        halo: palette.labelHalo,
        weight: landRole.weight,
        anchor: 'middle',
        fantasy: true,
        font: landRole.family,
        italic: landRole.italic,
        rotation: l.rotation,
        glyphs: l.glyphs,
      });
      taken.push({ cx: l.at.x, cy: l.at.y, halfW: (roleEm(landRole, l.text) * l.size) / 2, halfH: l.size * 0.6, rotation: l.rotation });
    }
  }

  if (opts.labels && cities) {
    const fontSize = Math.max(8, size * 0.36) * (lettering.city.scale ?? 1);
    // A capital is named in capitals.
    const shown = (city: { name: string; capital?: boolean }) => (city.capital ? city.name.toLocaleUpperCase() : city.name);
    const placements = placeCityNames(
      cities.cities.map((city) => ({
        id: city.id,
        name: shown(city),
        at: siteOf(city),
        r: markerReach(city.population, city.capital),
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
        text: shown(byId.get(p.id)!),
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
