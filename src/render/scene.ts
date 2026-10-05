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
  hasLandConcentration,
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
  type River,
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
  insideBox,
  placeCityNames,
  placePolityLabels,
  type OrientedBox,
  type LabelObstacle,
  type PolityLabel,
  type PolityLabelNote,
  type PolityNameMin,
} from './labels.js';
import {
  blobPath,
  chainEdges,
  alike,
  coastKey,
  drawnLand,
  evenOddTest,
  circlePath,
  coastalIslandSide,
  coastGeometryOf,
  landTest,
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
  landInsetDepth,
  lakeComponents,
  type CoastGeometry,
  type CoastEdge,
  type Roughness,
  raggedEdge,
} from './coast.js';
import { polygonPath, type CitySymbol, type PathCmd, type Prim } from './prims.js';
import { capitalCrown, cityMarker, iconClearance, iconDrop, markerExtent, symbolMarker } from './cityMarkers.js';
import { riverStance, riverThroughIcon, showsRiver } from './riverCity.js';
import { landBySide, riverCourses, type RiverCourse } from './rivers.js';
import { citySite, lakeEdgesOf, resolvedSite } from './sites.js';
import { FIT_SCALES, escarpment, hillshade, keepToLand, refit, samplePoints, type Fitted, reliefSymbols, standsOnLand, symbolAnchor, vegetationSymbols, type Placed } from './symbols.js';
import { ownersAtDepth, polityDepths, polityDisplayColours, toned } from './hierarchy.js';
import { topLevelOf } from '../../shared/polityTree.js';
import { cityStateSeats } from '../../shared/cityState.js';
import { measureEpoch, textEm } from './fonts.js';
import { glyphAdvances, glyphsStraight } from './glyphs.js';
import { BUNDLED_FACES, LETTERINGS, type FaceRole } from './lettering.js';
import { signed, unit } from './seed.js';
import { descendantsOf } from '../../shared/polityTree.js';
import { ELEVATION_RANK, floeFringe, glacierEdges, glacierFlow, glacierMarginPrims, glacierShading, glacierShelf, iceSeam, nearHexes, pathPolylines, seaIcePrims } from './ice.js';
import { coastLengthIn, coveredArea, driftOf, nearestHex, nearestOn, shapeCoast, type ShapeMemo, type ShapeTarget } from './footprint.js';
import { channelShareSet, channelWidthFraction, drawnLandFraction, landFraction, normaliseHexDimensions } from '../../shared/surfaceArea.js';
import { CLASSIC_STYLE, type ElevationStyle, type MapStyle } from './styles.js';
import { extendToRim, rimPieces } from './rim.js';
import { grainTile } from './texture.js';

export type { CitySymbol, PathCmd, Prim } from './prims.js';


/** The mean of a polygon's corners. */
const centroidOf = (poly: Point[]): Point => ({ x: poly.reduce((sum, q) => sum + q.x, 0) / poly.length, y: poly.reduce((sum, q) => sum + q.y, 0) / poly.length });

/**
 * The part of a convex hex lying east of a vertical chord, placed so that it
 * covers `fraction` of the hex's area.
 */
function shareRegion(corners: Point[], fraction: number): Point[] {
  const xs = corners.map((c) => c.x);
  let lo = Math.min(...xs);
  let hi = Math.max(...xs);
  const clip = (t: number): Point[] => {
    const out: Point[] = [];
    corners.forEach((a, k) => {
      const b = corners[(k + 1) % corners.length]!;
      const inA = a.x >= t;
      const inB = b.x >= t;
      if (inA) out.push(a);
      if (inA !== inB) out.push({ x: t, y: a.y + ((b.y - a.y) * (t - a.x)) / (b.x - a.x) });
    });
    return out;
  };
  const area = (pts: Point[]) =>
    Math.abs(pts.reduce((sum, a, k) => { const b = pts[(k + 1) % pts.length]!; return sum + a.x * b.y - b.x * a.y; }, 0)) / 2;
  const total = area(corners);
  for (let n = 0; n < 24; n++) {
    const mid = (lo + hi) / 2;
    if (area(clip(mid)) > total * fraction) lo = mid;
    else hi = mid;
  }
  return clip((lo + hi) / 2);
}

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
  /** City markers (with the room names leave round them), for collision checks. */
  markers?: OrientedBox[];
  /** Where the map's own top-left corner lies on the page, once a frame has grown the page around it. */
  origin?: Point;
  /** Map furniture placed by `addMarginalia`, for collision checks. */
  furniture?: FurniturePlacement[];
  /** Where the drawing could not do everything asked of it, and what it gave up. */
  compromises?: DrawingCompromise[];
}

/**
 * A place where the map could not satisfy every rule it draws by, so that the app can say so
 * rather than leave the user to notice. `what` says what was given up, `why` the rule that won.
 */
export interface DrawingCompromise {
  /** The hexes it concerns: one hex's symbols, or every hex of a realm whose name it is. */
  hexes: number[];
  what: string;
  why: string;
}

/** One piece of map furniture as placed: what it is, where it sits, and what surface it sits on. */
export interface FurniturePlacement {
  kind: 'title' | 'scale' | 'compass' | 'legend';
  box: OrientedBox;
  /** Open sea on the map, the margin band round it, or the legend's own panel beside it. */
  where: 'sea' | 'band' | 'panel';
}

/**
 * Whether a point of the map is land as drawn (coasts and islands), for
 * collision checks. Kept beside the scene rather than in it so that a scene
 * stays plain data that can be compared and serialised; a copy of a scene
 * picks the test up again through `withLandOf`.
 */
const landTests = new WeakMap<object, (p: Point) => boolean>();

/** A symbol drawn on the land (relief, vegetation, an elevation mark): its hex and the points along its drawing. */
export interface SymbolTrace {
  hex: number;
  points: Point[];
}
/** The symbols each scene drew, kept beside it like its land test, for the audit to check against the land. */
const symbolTraces = new WeakMap<object, SymbolTrace[]>();

/** The symbols `scene` drew on the land, where it recorded them. */
export function symbolsOf(scene: Scene): SymbolTrace[] | undefined {
  return symbolTraces.get(scene);
}

export function landTestOf(scene: Scene): ((p: Point) => boolean) | undefined {
  return landTests.get(scene);
}

/** `scene`, a copy or extension of `source`, answering the same land questions. */
export function withLandOf<T extends Scene>(scene: T, source: Scene): T {
  const test = landTests.get(source);
  if (test) landTests.set(scene, test);
  const symbols = symbolTraces.get(source);
  if (symbols) symbolTraces.set(scene, symbols);
  return scene;
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
  /** The largest city-state, in hexes, that is named by its capital alone. */
  cityStateMax?: number;
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
  { cities: object | null; polities: object; key: string; land: unknown[]; labels: PolityLabel[]; notes: PolityLabelNote[] }
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
  lakes: ReadonlySet<number>,
  /** Polities named by their capital instead: they get no name of their own. */
  unnamed: ReadonlySet<string>,
  /** Land as drawn (see `LabelInput.land`), and what it was drawn from, which the cache compares. */
  land: (p: Point) => boolean,
  landKey: unknown[],
): { labels: PolityLabel[]; notes: PolityLabelNote[] } {
  const key = `${cols}x${rows}@${size}/${minHexes ?? ''}/${sizing}/${letteringId}/${measureEpoch}/${[...unnamed].sort().join(',')}`;
  const hit = labelCache.get(data.owner);
  if (hit && hit.key === key && hit.cities === cities && hit.polities === data.polities && hit.land.length === landKey.length && hit.land.every((v, k) => v === landKey[k])) {
    return { labels: hit.labels, notes: hit.notes };
  }
  const notes: PolityLabelNote[] = [];
  const labels = placePolityLabels({
    land,
    notes,
    cols,
    rows,
    size,
    owner: data.owner,
    polities: unnamed.size > 0 ? data.polities.filter((p) => !unnamed.has(p.id)) : data.polities,
    obstacles,
    minHexes,
    sizing,
    lakes,
    measure: (text) => roleEm(role, text),
  });
  labelCache.set(data.owner, { cities, polities: data.polities, key, land: landKey, labels, notes });
  return { labels, notes };
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
  /** How far a lake hex's land-facing shore is drawn in from its edge, into the lake, for the land share it has. */
  lakeInsets: Map<number, number>;
  /**
   * The land (0 to 1, the lake's border counted) that each hex whose land share is set by a lake shore is to show,
   * and whether it is the lake hex itself (land drawn in from its edges) or a land hex beside the lake.
   */
  lakeAim: Map<number, { land: number; lake: boolean }>;
  /** Whether a point is land as drawn, for placing things that must stand on it. */
  onLand: (p: Point) => boolean;
}

const coastCache = new WeakMap<object, TracedCoast & { key: string }>();

/** Where each hex's relief and vegetation symbols were fitted to the land of a traced coast (see `keepToLand`). */
const symbolFits = new WeakMap<object, { dry: ((p: Point) => boolean) | null; fits: Map<string, Fitted> }>();

/** Hexes already cut to their shares, kept between scenes so that editing one hex does not cut the rest again. */
const shapeMemo: ShapeMemo = new Map();

/** The size islands are drawn at to cover their share, by everything that fixes their shape (see `islandScale`). */
const islandScaleMemo = new Map<string, number>();

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
  /** Half the coastline's stroke width: what its ink adds outside the land, which counts as land (0 with no coastline). */
  inkReach: number,
): TracedCoast {
  const key = `${cols}x${rows}@${size}/${smooth}/${inkReach}/${seed}/${defaultIrregularity ?? ''}/${shapesSignature(shapes)}/${dimensions.coastalLandPercent},${dimensions.lakeLandPercent},${dimensions.glacierPercent},${dimensions.isthmusWidth},${dimensions.straitWidth},${dimensions.isthmusPercent ?? ''},${dimensions.straitPercent ?? ''},${dimensions.mainlandPercent}`;
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
  // Roughness is also kept well inside the width of a neck or channel (a quarter of it, at the most), so that a
  // narrow isthmus is never cut through nor a narrow strait closed by the ragged line along it.
  const narrowest = (i: number | undefined): number => {
    const fraction = i === undefined || !surface.split.has(i) ? null : channelWidthFraction(base[i], dimensions, shapes?.[String(i)]);
    return fraction === null ? Infinity : fraction * 0.27;
  };
  // The sea's coast: lakes count as land here, as they have bodies of their own.
  const seaEdges = surfaceEdges(surface, size, (side) => side !== 'sea');
  // The edges a coast hex has against a lake count towards its depth, though only the sea's are cut: the lake is drawn over it.
  const lakeEdges = surfaceEdges(surface, size, (side) => side !== 'lake').filter((edge) => edge.across !== undefined && surface.whole[edge.across] === 'lake');
  // Every hex that has a share of land to keep is reshaped until it has it: a
  // coast hex is cut back from its sea edges, a split hex has its land boundary
  // moved. The coast is then traced round what results.
  const targets = new Map<number, ShapeTarget>();
  // Length of sea edge each hex has: a first estimate of the coastline whose ink counts as the hex's land.
  const seaLength = new Map<number, number>();
  for (const edge of seaEdges) {
    if (edge.hex !== undefined) seaLength.set(edge.hex, (seaLength.get(edge.hex) ?? 0) + Math.hypot(edge.to.x - edge.from.x, edge.to.y - edge.from.y));
  }
  // The same for the lake's shore: the lake is drawn over the hex, with its own outline, whose ink is land too.
  const lakeLength = new Map<number, number>();
  for (const edge of lakeEdges) {
    if (edge.hex !== undefined) lakeLength.set(edge.hex, (lakeLength.get(edge.hex) ?? 0) + Math.hypot(edge.to.x - edge.from.x, edge.to.y - edge.from.y));
  }
  const hexAreaOf = 1.5 * Math.sqrt(3) * size * size;
  for (let i = 0; i < base.length; i++) {
    const shape = hexShapeFor(base[i], shapes?.[String(i)], defaultIrregularity);
    const own = drawnLandFraction(base[i], dimensions, shapes?.[String(i)]);
    // Plain land with a sea edge is a whole hex of land like any other: its ink counts too.
    const share = own ?? (base[i] === 'Land' && inkReach > 0 && seaLength.has(i) ? 1 : null);
    if (share === null) continue;
    // The land inside the line is the share less the outer half of the ink along it.
    const aimed = inkReach > 0 ? Math.max(0, share - (((seaLength.get(i) ?? 0) + (lakeLength.get(i) ?? 0)) * inkReach) / hexAreaOf) : share;
    const channel = channelWidthFraction(base[i], dimensions, shapes?.[String(i)]);
    if (surface.split.has(i)) {
      // A neck or a channel is drawn at its width, which is across the hex: its flat-to-flat span.
      targets.set(i, channel !== null
        ? { share: aimed, kind: base[i] === 'Strait' ? 'channel' : 'neck', width: channel * Math.sqrt(3) * size, fit: channelShareSet(base[i], dimensions, shapes?.[String(i)]) !== null, junctionSide: base[i] === 'Strait' ? shape.straitJunctionSide : undefined }
        : { share: aimed, kind: 'inset', concentrationSide: shape.concentrationSide, concentration: shape.concentration });
    } else if (surface.whole[i] === 'land' && aimed < 1 && (share < 1 || seaLength.has(i))) {
      // Whole hexes of land are cut back from the sea; a strait drawn whole is all water.
      targets.set(i, { share: aimed, kind: 'inset', concentrationSide: shape.concentrationSide, concentration: shape.concentration });
    }
  }
  /** What each hex is to show, before its ink: the share the loop below aims at once the ink is measured. */
  const wanted = new Map<number, number>();
  for (const i of targets.keys()) {
    const own = drawnLandFraction(base[i], dimensions, shapes?.[String(i)]);
    wanted.set(i, own ?? 1);
  }
  const rough: Roughness | undefined = smooth
    ? {
        size,
        amplitude: (edge: CoastEdge) => Math.min(Math.max(amplitudeOf(edge.hex), amplitudeOf(edge.across)), narrowest(edge.hex), narrowest(edge.across)),
        noise: (x, y, k) => unit(seed, 'coast', Math.round(x * 1000), Math.round(y * 1000), k),
      }
    : undefined;
  if (shapeMemo.size > 30000) shapeMemo.clear();
  const memo = shapeMemo;
  const trace = (shares: ReadonlyMap<number, ShapeTarget>) => {
    const shaped = shares.size > 0 ? shapeCoast(seaEdges, surface, size, shares, lakeEdges, memo) : null;
    return { shaped, geometry: coastGeometryOf(shaped?.edges ?? seaEdges, smooth, rough, shaped ?? undefined) };
  };
  let { shaped, geometry } = trace(targets);
  // A smoothed or roughened coast takes some land from a hex and gives some back, so the land drawn is a little
  // off the share the hex was cut to. Cut it again to the share less what the coast moved, to draw the share itself.
  const hexArea = 1.5 * Math.sqrt(3) * size * size;
  let aimed = targets;
  // Each pass measures what the coast as traced actually shows in every shaped hex (the land its smoothing keeps,
  // plus the ink round it) and moves the cut by a part of what is missing. The measure shifts with the cut, so the
  // passes can overshoot: the trace that came closest is kept.
  let best: { shaped: typeof shaped; geometry: typeof geometry; miss: number } | null = null;
  for (let pass = 0; pass < 7 && shaped && (smooth || inkReach > 0); pass++) {
    const drift = driftOf(geometry, geometry.strips.length, new Set(targets.keys()), cols, rows, size, (d) => pathPolylines(d, 6));
    // The border is land too: what shows is the share, so the land inside the line is less. The ink lies from the
    // line out to its edge, which is what the share counts (the rest of the stroke is over land already counted).
    const ink = inkReach > 0 ? coastLengthIn(geometry.paths.flatMap((d) => pathPolylines(d, 6)), new Set(targets.keys()), cols, rows, size) : new Map<number, number>();
    let miss = 0;
    const next = new Map<number, ShapeTarget>();
    for (const [i, target] of targets) {
      // A neck or channel with no share set is drawn as it is; with one, its fill is found like any other cut.
      if (target.width !== undefined && !target.fit) {
        next.set(i, target);
        continue;
      }
      const was = aimed.get(i)!.share;
      const shows = was + (drift.get(i) ?? 0) / hexArea + (((ink.get(i) ?? 0) + (lakeLength.get(i) ?? 0)) * inkReach) / hexArea;
      const short = wanted.get(i)! - shows;
      // A neck or channel with a share set may not be able to reach it (its width allows a least and a most): that
      // is not a coast cut badly, and must not decide which pass is kept for the hexes round it.
      if (!target.fit) miss = Math.max(miss, Math.abs(short));
      next.set(i, { ...target, share: Math.min(1, Math.max(0, was + short * 0.8)) });
    }
    if (!best || miss < best.miss) best = { shaped, geometry, miss };
    if (miss < 0.004) break;
    aimed = next;
    ({ shaped, geometry } = trace(aimed));
  }
  if (best && best.shaped !== shaped) ({ shaped, geometry } = best);
  // A lake hex with a land share has land drawn in from the edges it shares with land, as deep as the share needs.
  const lakeInsets = new Map<number, number>();
  for (let i = 0; i < base.length; i++) {
    if (base[i] !== 'Lake' || surface.whole[i] !== 'lake') continue;
    const share = landFraction('Lake', undefined, dimensions, shapes?.[String(i)]);
    if (share <= 0) continue;
    const against = surfaceEdges(surface, size, (side) => side === 'lake', new Set([i])).filter((e) => e.across !== undefined && surface.whole[e.across] === 'land');
    if (against.length === 0) continue;
    const depth = landInsetDepth(hexCorners(i % cols, Math.floor(i / cols), size), against, 1 - share);
    // The land drawn in is the share less the outer half of the ink along its edge, which lies on the water's side.
    if (depth - inkReach > 0) lakeInsets.set(i, depth - inkReach);
  }
  // Hexes whose land share is set by a lake's shore alone (a sea coast has its own correction above).
  const lakeAim = new Map<number, { land: number; lake: boolean }>();
  for (const i of targets.keys()) {
    if (lakeLength.has(i) && !seaLength.has(i) && !surface.split.has(i)) lakeAim.set(i, { land: wanted.get(i)!, lake: false });
  }
  for (const i of lakeInsets.keys()) lakeAim.set(i, { land: landFraction('Lake', undefined, dimensions, shapes?.[String(i)]), lake: true });
  const entry = { key, geometry, lakes, lakeIslands, surface, insets: shaped?.insets ?? new Map<number, number>(), lakeInsets, lakeAim, onLand: landTest(surface, shaped?.land ?? new Map(), size) };
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

/** Opacity of relief and vegetation symbols under a realm's name: subtle, the ground still shows. */
const RELIEF_FADE = 0.4;
/** How far past a name's edge, in hex sizes, a hex's symbols are still faded: roughly a symbol's own reach. */
const RELIEF_FADE_REACH = 0.35;

/** Opacity of the realm fill under the border band in the tint style. */
const TINT_ALPHA = 0.32;

/** Blend two #rrggbb colours; `t` = 0 gives `a`. */
export function mix(a: string, b: string, t: number): string {
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
  return decoration.length > 0 ? withLandOf({ ...scene, prims: [...scene.prims, ...decoration] }, scene) : scene;
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

  // Half the coastline's stroke width: what its ink adds outside the land, which counts as land (0 with no coastline).
  const inkReachOf = knobs.coast === 'none' ? 0 : Math.max(0.8, size * palette.coastWidth * knobs.lineWeight) / 2;
  const traced = base ? cachedCoast(base, cols, rows, size, knobs.coast === 'smooth', map.hexShapes, map.defaultIrregularity, normaliseHexDimensions(map.hexDimensions), seed, inkReachOf) : null;
  // The one answer to "is this point land?" for everything placed on the map (with the islands
  // and lake bodies added once they are laid out: see `landAt`): inside the sea coast as drawn,
  // smoothed and roughened, the outline the realm bands are clipped to. It and each hex's symbol
  // fitting are kept with the traced coast, so a redraw that leaves the coast alone reuses them.
  const memo = traced ? symbolFits.get(traced) ?? { dry: null, fits: new Map<string, Fitted>() } : null;
  if (traced && memo && !symbolFits.has(traced)) symbolFits.set(traced, memo);
  const seaCoastLand: ((p: Point) => boolean) | null = memo?.dry
    ?? (traced && traced.geometry.paths.length > 0
      ? evenOddTest(pathPolylines(drawnLand(traced.geometry, width, height, size), 6), size / 8)
      : traced ? (p: Point) => traced.onLand(p) : null);
  if (memo) memo.dry = seaCoastLand;
  /** Where the drawing could not do everything asked of it. */
  const compromises: DrawingCompromise[] = [];
  /** Every symbol drawn on the land, for the audit (see `symbolsOf`). */
  const traces: SymbolTrace[] = [];
  const trace = (hex: number, placed: Placed[]) => {
    for (const p of placed) traces.push({ hex, points: samplePoints(p) });
  };
  /** A hex's symbols fitted to its land (see `keepToLand`), searched once per traced coast. */
  const fitSymbols = (
    key: string,
    draw: (at: Point, s: number) => Placed[],
    centre: Point,
    onLand: (p: Point) => boolean,
    inHex: (p: Point) => boolean,
  ): Fitted => {
    const known = memo?.fits.get(key);
    if (known) return { ...known, placed: refit(draw, known, size) };
    const fitted = keepToLand(draw, centre, size, onLand, inHex);
    memo?.fits.set(key, { ...fitted, placed: [] });
    return fitted;
  };
  /** Records a hex whose symbols (`what`, such as "hills symbols") were drawn smaller than asked, or left out. */
  const noteFit = (i: number, what: string, fitted: Fitted) => {
    const smallest = Math.round(Math.min(...FIT_SCALES) * 100);
    const scale = Math.round(fitted.scale * 100);
    if (fitted.dropped > 0) {
      compromises.push({
        hexes: [i],
        what: fitted.placed.length === 0
          ? `No ${what} drawn`
          : `${fitted.dropped} of ${fitted.wanted} ${what} left out, the rest drawn at ${scale}% size`,
        why: `the land drawn in this hex is too small or narrow to hold them all even at ${smallest}% size, and symbols are never drawn over water`,
      });
    } else if (fitted.scale < 1) {
      compromises.push({
        hexes: [i],
        what: `${what[0]!.toUpperCase()}${what.slice(1)} drawn at ${scale}% size`,
        why: 'the land drawn in this hex is too small or narrow for them at full size, and symbols are never drawn over water',
      });
    }
  };
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
        if (elevation) {
          // Kept to the land as drawn, like drawn relief: the lakes and islands are not laid out
          // yet, so a lake hex's ground counts as water and nothing else does.
          const dry = (p: Point) => {
            if (seaCoastLand && !seaCoastLand(p)) return false;
            const at = pixelToOffset(p.x, p.y, size);
            return !inBounds(cols, rows, at.col, at.row) || !isLakeHex(hexIndex(cols, at.col, at.row));
          };
          const inHex = (p: Point) => {
            const at = pixelToOffset(p.x, p.y, size);
            return at.col === col && at.row === row;
          };
          const draw = (at: Point, s: number): Placed[] => [{ y: at.y, prims: elevationMarks(at, s, elevation) }];
          const fitted = fitSymbols(`marks/${i}/${elevation}`, draw, hexCenter(col, row, size), dry, inHex);
          for (const p of fitted.placed) prims.push(...p.prims);
          trace(i, fitted.placed);
          noteFit(i, `${elevation.toLowerCase()} marks`, fitted);
        }
      }

      for (const overlay of overlays(own)) prims.push({ kind: 'polygon', points: corners, fill: overlay });

      // A hex shared between two polities: the second holder's part, cut off
      // by a straight chord so that it covers the fraction chosen.
      const shared = knobs.polityStyle === 'outline' ? undefined : polities?.shares?.[String(i)];
      if (shared && polities?.owner[i]) {
        const piece = shareRegion(corners, shared.share);
        const solid = polityColour.get(shared.polityId) ?? '#777777';
        const alpha = knobs.polityStyle === 'tint'
          ? TINT_ALPHA * polityOpacity
          : knobs.polityStyle === 'wash'
            ? 0.55 * polityOpacity
            : polityOpacity;
        // Over the bare ground, not over the first holder's colour.
        prims.push({ kind: 'polygon', points: piece, fill: hexFill(own) });
        prims.push({ kind: 'polygon', points: piece, fill: alpha < 1 ? withAlpha(solid, alpha) : solid });
      }
      if (knobs.polityStyle === 'outline') {
        const share = polities?.shares?.[String(i)];
        if (share && polities?.owner[i]) {
          const piece = shareRegion(corners, share.share);
          const cutX = Math.min(...piece.map((point) => point.x));
          const cut = piece
            .filter((point) => Math.abs(point.x - cutX) < 1e-5)
            .filter((point, index, points) => index === points.findIndex((other) => Math.abs(other.y - point.y) < 1e-5));
          if (cut.length === 2) {
            prims.push({
              kind: 'path',
              d: [['M', cut[0]!.x, cut[0]!.y], ['L', cut[1]!.x, cut[1]!.y]],
              stroke: palette.frontier,
              strokeWidth: Math.max(1, size * 0.09),
            });
          }
        }
      }
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
      // Water first, so that its sealing stroke never paints over land beside it: where a reshaped hex
      // takes the water for land, a hairline of water would show along the seam.
      const order = split.sides.map((_, p) => p).sort((a, b) => Number(split.sides[a] !== 'sea') - Number(split.sides[b] !== 'sea') || a - b);
      order.forEach((p) => {
        const side = split.sides[p]!;
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
    // Water that a reshaped hex takes as land, in the colours of the land it grows from.
    for (const s of coast?.grown ?? []) {
      const fill = hexFill(s.donor);
      prims.push({ kind: 'path', d: s.d, fill, stroke: fill, strokeWidth: seal });
      for (const overlay of overlays(s.donor)) prims.push({ kind: 'path', d: s.d, fill: overlay });
    }
    // Corners of land that the smoothed coast cuts off become water.
    for (const s of coast?.toWater ?? []) {
      const fill = waterColour(s.donor);
      prims.push({ kind: 'path', d: s.d, fill, stroke: fill, strokeWidth: seal });
    }
  }

  const islandRand = (i: number) => {
    const layoutSeed = islandSpecFor(base![i], map.islandSpecs?.[String(i)]).layoutSeed ?? 0;
    return (k: number) => unit(seed, 'islet', i, layoutSeed, k);
  };
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
    /** How much of the usual share of its kind this island takes (islands of a kind average 1), so that islands differ in size. */
    weight?: number;
  }
  /**
   * Islands laid in one of nature's patterns (see `IslandArrangement`), about `centre`, running along
   * `grain`. Only the places, shapes and turn of each island are set here; its size comes from its share.
   * `toward` is the direction of the nearest land, which an arc bows away from.
   */
  const arrangedIsles = (
    kind: Exclude<NonNullable<IslandSpec['arrangement']>, 'scattered'>,
    nl: number,
    ns: number,
    centre: Point,
    grain: number,
    toward: number,
    rand: (k: number) => number,
  ): Isle[] => {
    const large = [...Array(nl).fill(true), ...Array(ns).fill(false)] as boolean[];
    const n = large.length;
    // An island's radius at its own share, before any scaling.
    const nominal = (isLarge: boolean) =>
      Math.sqrt((((isLarge ? dimensions.largeIslandPercent : dimensions.smallIslandPercent) / 100) * hexArea) / Math.PI);
    const u = { x: Math.cos(grain), y: Math.sin(grain) };
    const v = { x: -u.y, y: u.x };
    const flip = rand(241) < 0.5 ? -1 : 1;
    const along = (s: number, t: number): Point => ({ x: centre.x + u.x * s + v.x * t, y: centre.y + u.y * s + v.y * t });
    const make = (k: number, c: Point, aspect: number, axis: number): Isle => ({
      c,
      rx: size * 0.5 * Math.sqrt(aspect),
      ry: (size * 0.5) / Math.sqrt(aspect),
      axis: axis + (rand(260 + k) - 0.5) * 0.3,
      large: large[k]!,
    });
    // Slots from the middle of a line outwards, so that the large islands take the middle.
    const middleOut = [...Array(n).keys()].sort((a, b) => Math.abs(a - (n - 1) / 2) - Math.abs(b - (n - 1) / 2) || a - b);
    if (kind === 'ring') {
      // Round a lagoon, wide enough apart that neighbours do not touch.
      const biggest = Math.max(...large.map(nominal));
      const radius = n === 1 ? 0 : Math.min(size * 0.62, Math.max(size * 0.38, (biggest * 2.4) / (2 * Math.sin(Math.PI / n))));
      const start = rand(242) * Math.PI * 2;
      return large.map((_, k) => {
        const a = start + (k / n) * Math.PI * 2;
        return make(k, { x: centre.x + Math.cos(a) * radius, y: centre.y + Math.sin(a) * radius }, 1.4, a + Math.PI / 2);
      });
    }
    // A chain trails away from its largest island; barrier islands stand in a staggered row, long and thin; an arc is a chain on a curve.
    const barrier = kind === 'barrier';
    const aspect = barrier ? 2.6 : 1.5;
    const rows = barrier && n > 3 ? 2 : 1;
    const reach = (k: number) => nominal(large[k]!) * Math.sqrt(aspect);
    const spots: number[] = [];
    let run = 0;
    for (let k = 0; k < n; k++) {
      if (k > 0) run += (reach(k - 1) + reach(k)) * (rows === 2 ? 0.55 : barrier ? 1.05 : 0.9) + size * 0.07;
      spots.push(run);
    }
    const squeeze = Math.min(1, (size * 1.7) / Math.max(run, 1e-6));
    const order = barrier ? middleOut : [...Array(n).keys()];
    if (kind === 'arc') {
      // Bowed away from the land: the centre of curvature lies on the land's side. Islands are spaced
      // along the curve by their size, the largest at one end.
      const bow = v.x * Math.cos(toward + Math.PI) + v.y * Math.sin(toward + Math.PI) >= 0 ? 1 : -1;
      const radius = size * 0.95;
      const half = (run * squeeze) / 2 / radius;
      const sag = radius * (1 - Math.cos(half));
      const ctr = { x: centre.x - bow * v.x * (radius - sag / 2), y: centre.y - bow * v.y * (radius - sag / 2) };
      return large.map((_, k) => {
        const a = flip * ((spots[k]! - run / 2) * squeeze) / radius;
        const c = {
          x: ctr.x + radius * (Math.sin(a) * u.x + Math.cos(a) * bow * v.x),
          y: ctr.y + radius * (Math.sin(a) * u.y + Math.cos(a) * bow * v.y),
        };
        const tangent = Math.atan2(u.y * Math.cos(a) - bow * v.y * Math.sin(a), u.x * Math.cos(a) - bow * v.x * Math.sin(a));
        return make(k, c, aspect, tangent);
      });
    }
    return large.map((_, k) => {
      const s = flip * (spots[order[k]!]! - run / 2) * squeeze;
      const t = barrier
        ? (rows === 2 ? (order[k]! % 2 ? 1 : -1) * size * 0.17 : (rand(270 + k) - 0.5) * size * 0.06)
        : size * 0.05 * Math.sin(order[k]! * 1.9 + rand(271) * 6) + (rand(272 + k) - 0.5) * size * 0.05;
      return make(k, along(s, t), aspect, grain);
    });
  };
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
    const arrangement = spec.arrangement ?? 'scattered';
    // The grain of the group: the way its islands are elongated and its line runs. With the coast
    // (as island arcs and barrier islands lie), across it, or by chance. On a mainland hex and for
    // a barrier the coast is always known, so the line follows it unless told otherwise.
    const orientation = spec.orientation ?? (mainland || arrangement === 'barrier' ? 'along' : 'free');
    const grain = orientation === 'along' ? toward + Math.PI / 2 : orientation === 'across' ? toward : rand(243) * Math.PI;
    if (arrangement !== 'scattered' && nl + ns > 0) {
      return arrangedIsles(arrangement, nl, ns, mainland ? at(toward + Math.PI, 0.42) : c, grain, toward, rand);
    }
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
        // Off the hex's middle by a little, and as long as it is broad by a seeded amount, so no two look alike.
        const mean = Math.sqrt((crowded ? 0.52 : 0.74) * (crowded ? 0.44 : 0.62)) * size;
        const elongation = 1 + 0.7 * rand(96);
        isles.push({ c: at(rand(95) * Math.PI * 2, rand(94) * (crowded ? 0.22 : 0.14)), rx: mean * Math.sqrt(elongation), ry: mean / Math.sqrt(elongation), axis: grain + (rand(99) - 0.5) * 0.6, large: true });
      } else {
        const axis = rand(98) * Math.PI;
        const apart = 0.28 + 0.16 * rand(93);
        const sizes = [0.8 + 0.4 * rand(91), 0.8 + 0.4 * rand(92)];
        const mean = (sizes[0]! + sizes[1]!) / 2;
        [-1, 1].forEach((sign, n) => {
          const elongation = 1 + 0.5 * rand(88 + n);
          const base = Math.sqrt((crowded ? 0.32 : 0.4) * (crowded ? 0.26 : 0.32)) * size;
          isles.push({ c: at(axis, sign * apart, (rand(87 + n) - 0.5) * 0.36), rx: base * Math.sqrt(elongation), ry: base / Math.sqrt(elongation), axis: grain + (rand(97 + sign) - 0.5) * 0.6, large: true, weight: sizes[n]! / mean });
        });
      }
    }
    // Small islands differ in size, about one share each on average.
    const weights = Array.from({ length: ns }, (_, k) => 0.6 + 0.9 * rand(520 + k));
    const meanWeight = weights.reduce((sum, w) => sum + w, 0) / Math.max(1, ns);
    for (let k = 0; k < ns; k++) {
      const rr = size * (0.12 + rand(500 + k) * 0.05) * (ns >= 4 ? 0.82 : 1);
      const weight = weights[k]! / meanWeight;
      const aspect = 1.1 + 0.6 * rand(540 + k);
      let p: Point;
      if (coastalSmall) {
        // In a line along the coast (or the mainland's shore).
        const along = (k - (ns - 1) / 2) * 0.3 + (rand(300 + k) - 0.5) * 0.08;
        p = mainland ? at(toward + Math.PI, 0.28 + rand(400 + k) * 0.08, along) : at(toward, 0.56 + rand(400 + k) * 0.08, along);
      } else {
        // Scattered, not ringed: of several places chosen at random, the one furthest from the islands already laid.
        // A mainland's islands keep to its open water; a hex that also has coastal large islands, to the rest of it.
        const keepOut = nl > 0 && coastalLarge ? toward + Math.PI : out;
        const half = mainland ? 1.35 : nl > 0 && coastalLarge ? 1.9 : Math.PI;
        let best = { p: c, room: -Infinity };
        for (let j = 0; j < 14; j++) {
          const a = keepOut + (rand(700 + k * 20 + j) * 2 - 1) * half;
          const r = (mainland ? 0.42 : 0.7) * Math.sqrt(rand(710 + k * 20 + j)) + (mainland ? 0.3 : 0);
          const cand = at(a, r);
          let room = Infinity;
          for (const other of isles) room = Math.min(room, Math.hypot(cand.x - other.c.x, cand.y - other.c.y) - (other.large ? 0.42 : 0.16) * size);
          // Keep off the hex's edge as well.
          room = Math.min(room, (0.8 * size - Math.hypot(cand.x - c.x, cand.y - c.y)) * 1.5);
          if (room > best.room) best = { p: cand, room };
        }
        p = best.p;
      }
      isles.push({ c: p, rx: rr * Math.sqrt(aspect), ry: rr / Math.sqrt(aspect), axis: grain + (rand(600 + k) - 0.5) * 0.7, large: false, weight });
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
  /** Half the coastline's stroke width, which is what it adds outside an edge (none without a coast line). */
  const inkReach = inkReachOf;
  const hexArea = 1.5 * Math.sqrt(3) * size * size;
  /**
   * The part of an island hex (0 to 1) its islands are to cover: what its
   * islands add up to, or, when the hex sets its own land share, that share
   * less the mainland's in a mainland hex.
   */
  const islandCover = (i: number): number => {
    const set = hexShapeFor(base![i], map.hexShapes?.[String(i)]).land;
    const spec = islandSpecFor(base![i], map.islandSpecs?.[String(i)]);
    const usual = spec.large * dimensions.largeIslandPercent + spec.small * dimensions.smallIslandPercent;
    if (set === undefined) return Math.min(100, usual) / 100;
    const islands = base![i] === 'Mainland and islands' ? Math.max(0, set - dimensions.mainlandPercent) : set;
    return Math.min(100, islands) / 100;
  };
  /** The land of a mainland hex islands must keep clear of. */
  const mainlandOf = (i: number): Point[][] => {
    const shaped = coast?.land.get(i);
    if (shaped) return shaped;
    const split = terrain?.split.get(i);
    if (!split) return base![i] === 'Mainland and islands' && !isWater(i) ? [hexCorners(i % cols, Math.floor(i / cols), size)] : [];
    return split.sides.flatMap((side, p) => (side === 'land' ? [piecePoints(i % cols, Math.floor(i / cols), p, size)] : []));
  };
  /**
   * The islands of an island hex as drawn, `times` the size of their own shares
   * (see `islandScale`). The layout says where each lies and its shape; its size
   * is its share of the hex. An island that would then spill over its hex's edge
   * is drawn nearer the centre, and one that would run into the hex's mainland
   * is drawn clear of it.
   */
  const layoutAt = (i: number, times: number, floor = times): { isles: Isle[]; crowd: number } => {
    const centre = hexCenter(i % cols, Math.floor(i / cols), size);
    const mainland = base![i] === 'Mainland and islands' ? mainlandOf(i) : [];
    const layout = islandLayout(i);
    const sized = (t: number) => layout.map((isle) => {
      const share = (isle.large ? dimensions.largeIslandPercent : dimensions.smallIslandPercent) * t * (isle.weight ?? 1);
      const area = (Math.min(100, Math.max(0, share)) / 100) * hexArea;
      const aspect = isle.rx / isle.ry;
      const rx = Math.min(size * 0.82, Math.sqrt((area * aspect) / Math.PI));
      const ry = Math.min(size * 0.82, Math.sqrt(area / (aspect * Math.PI)));
      return { ...isle, rx, ry };
    });
    const isles = sized(times);
    // The place the layout gives each island: where an island of the share's own size is held to inside the hex.
    const anchors = sized(floor).map((s) => {
      const dx = s.c.x - centre.x;
      const dy = s.c.y - centre.y;
      const away = Math.hypot(dx, dy);
      const room = Math.max(0, size * 0.836 - Math.max(s.rx, s.ry) * 1.1 - inkReach);
      const f = away > room && away > 0 ? room / away : 1;
      return { x: dx * f, y: dy * f };
    });
    const drawn = isles.map((s) => s.rx > 0 && s.ry > 0);
    // Each island as a circle a little wider than its outline, and how far from the hex's middle it may lie.
    const rho = isles.map((s) => Math.sqrt(s.rx * s.ry) * 1.03);
    // Two outlines' ink must not touch: the gap is measured between the outer edges of their strokes.
    const gap = size * 0.03 + 2 * inkReach;
    const at = anchors.map((q) => ({ ...q }));
    // Where an island may lie once it has to be moved: whole inside the hex, not just within a circle of it.
    const apothem = size * 0.836;
    /** How far past the hex's edge island k's outline reaches where it lies. */
    const outside = (k: number): number => {
      const isle = isles[k]!;
      let worst = 0;
      for (let e = 0; e < 6; e++) {
        const angle = (e * Math.PI) / 3;
        const along = Math.cos(angle - isle.axis) * isle.rx;
        const across = Math.sin(angle - isle.axis) * isle.ry;
        const reach = knobs.islands === 'blob' ? Math.hypot(along, across) : Math.sqrt(isle.rx * isle.ry);
        worst = Math.max(worst, at[k]!.x * Math.cos(angle) + at[k]!.y * Math.sin(angle) + reach * 1.1 + inkReach - apothem);
      }
      return worst;
    };
    const contain = (k: number) => {
      const isle = isles[k]!;
      for (let pass = 0; pass < 2; pass++) {
        for (let e = 0; e < 6; e++) {
          const angle = (e * Math.PI) / 3;
          const nx = Math.cos(angle);
          const ny = Math.sin(angle);
          // How far the island's outline reaches towards this edge.
          const along = Math.cos(angle - isle.axis) * isle.rx;
          const across = Math.sin(angle - isle.axis) * isle.ry;
          // A dot is a circle of the ellipse's mean radius; a blob reaches as far as the ellipse does.
          const reach = knobs.islands === 'blob' ? Math.hypot(along, across) : Math.sqrt(isle.rx * isle.ry);
          const lim = Math.max(0, apothem - reach * 1.1 - inkReach);
          const over = at[k]!.x * nx + at[k]!.y * ny - lim;
          if (over > 0) at[k] = { x: at[k]!.x - nx * over, y: at[k]!.y - ny * over };
        }
      }
    };
    // A blob's outline strays outside its ellipse by about its wobble: more room the more irregular the island.
    const blobReach = 1 + 0.8 * 0.17 * ISLE_IRREGULARITY[levelOf(i)].wobble;
    /** How far island `isle`'s outline reaches from its middle in direction (dx, dy). */
    const reachAlong = (isle: Isle, dx: number, dy: number): number => {
      if (knobs.islands !== 'blob') return Math.sqrt(isle.rx * isle.ry) * 1.03;
      const len = Math.hypot(dx, dy) || 1;
      const lengthways = (dx * Math.cos(isle.axis) + dy * Math.sin(isle.axis)) / len;
      const sideways = (-dx * Math.sin(isle.axis) + dy * Math.cos(isle.axis)) / len;
      return ((isle.rx * isle.ry) / Math.hypot(isle.ry * lengthways, isle.rx * sideways)) * blobReach;
    };
    const pushFromMainland = (a: number): number => {
      if (mainland.length === 0) return 0;
      const here = { x: centre.x + at[a]!.x, y: centre.y + at[a]!.y };
      const near = nearestOn(here, mainland);
      const reach = rho[a]! + gap;
      if (near.dist >= reach) return 0;
      const out = near.dist > 1e-6
        ? { x: (here.x - near.at.x) / near.dist, y: (here.y - near.at.y) / near.dist }
        : (() => {
            const len = Math.hypot(at[a]!.x, at[a]!.y);
            return len > 1e-6 ? { x: at[a]!.x / len, y: at[a]!.y / len } : { x: 1, y: 0 };
          })();
      const push = reach - near.dist + 0.01;
      at[a] = { x: at[a]!.x + out.x * push, y: at[a]!.y + out.y * push };
      return push;
    };
    // First clear of the mainland, which is where the layout did not know to look.
    for (let step = 0; step < 40; step++) {
      let moved = 0;
      isles.forEach((_, a) => {
        if (drawn[a]) moved += pushFromMainland(a);
      });
      isles.forEach((_, k) => contain(k));
      if (moved < 0.005) break;
    }
    // Then apart from each other, without leaving the place the layout gave them (a coastal group keeps to its coast).
    const anchor = at.map((q) => ({ ...q }));
    // How far an island may be moved from the place the layout gave it to make room. A pattern may bend about its
    // line, and free islands may spread over the hex; a coastal group or a mainland's islands keep to their coast.
    const here = islandSpecFor(base![i], map.islandSpecs?.[String(i)]);
    const kept = here.coastal?.large || here.coastal?.small || mainland.length > 0;
    const leash = size * (here.arrangement ? 0.2 : kept ? 0.14 : 0.5);
    for (let step = 0; step < 60; step++) {
      let moved = 0;
      for (let a = 0; a < isles.length; a++) {
        if (!drawn[a]) continue;
        for (let b = a + 1; b < isles.length; b++) {
          if (!drawn[b]) continue;
          let dx = at[b]!.x - at[a]!.x;
          let dy = at[b]!.y - at[a]!.y;
          let d = Math.hypot(dx, dy);
          // How far apart the two outlines need to be along the line between them: an elongated islet
          // is longer end-on than side-on, so a row of them needs more room than a row of circles.
          const need = reachAlong(isles[a]!, dx, dy) + reachAlong(isles[b]!, -dx, -dy) + gap;
          if (d >= need) continue;
          if (d < 1e-6) {
            const angle = (a * 7 + b * 3) * 0.9;
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            d = 1;
          }
          // The smaller island gives more ground: the larger holds the place the layout gave it.
          const ma = rho[a]! * rho[a]!;
          const mb = rho[b]! * rho[b]!;
          const push = need - d + 0.02;
          const pa = (push * mb) / (ma + mb);
          const pb = (push * ma) / (ma + mb);
          at[a] = { x: at[a]!.x - (dx / d) * pa, y: at[a]!.y - (dy / d) * pa };
          at[b] = { x: at[b]!.x + (dx / d) * pb, y: at[b]!.y + (dy / d) * pb };
          moved += push;
        }
        moved += pushFromMainland(a);
      }
      isles.forEach((_, k) => {
        contain(k);
        const off = Math.hypot(at[k]!.x - anchor[k]!.x, at[k]!.y - anchor[k]!.y);
        if (off > leash) at[k] = { x: anchor[k]!.x + ((at[k]!.x - anchor[k]!.x) / off) * leash, y: anchor[k]!.y + ((at[k]!.y - anchor[k]!.y) / off) * leash };
      });
      if (moved < 0.005) break;
    }
    // How far islands still run into each other, the mainland or the hex's edge, once pushed as far as they go.
    let crowd = 0;
    for (let a = 0; a < isles.length; a++) {
      if (!drawn[a]) continue;
      crowd = Math.max(crowd, outside(a));
      for (let b = a + 1; b < isles.length; b++) {
        if (drawn[b]) {
          const dx = at[b]!.x - at[a]!.x;
          const dy = at[b]!.y - at[a]!.y;
          crowd = Math.max(crowd, reachAlong(isles[a]!, dx, dy) + reachAlong(isles[b]!, -dx, -dy) + gap * 0.5 - Math.hypot(dx, dy));
        }
      }
      if (mainland.length > 0) crowd = Math.max(crowd, rho[a]! + gap * 0.5 - nearestOn({ x: centre.x + at[a]!.x, y: centre.y + at[a]!.y }, mainland).dist);
    }
    return { isles: isles.map((s, k) => ({ ...s, c: { x: centre.x + at[k]!.x, y: centre.y + at[k]!.y } })), crowd };
  };
  const sizedIslesAt = (i: number, times: number): Isle[] => layoutAt(i, times, islandFloor(i)).isles;
  /** The islands of an island hex, as closed paths, for islands drawn `times` their share. */
  const islandPathAt = (i: number, times: number): PathCmd[] => islandPathFrom(i, sizedIslesAt(i, times));
  const islandPathFrom = (i: number, isles: Isle[]): PathCmd[] => {
    const rand = islandRand(i);
    const blob = knobs.islands === 'blob';
    const level = levelOf(i);
    const irregular = ISLE_IRREGULARITY[level];
    return isles.flatMap((isle, k) => {
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
  /**
   * How many times its own share each island of a hex is drawn at, found so
   * that the land the islands really cover (the outline is smoothed and
   * roughened, which takes some of the ellipse it starts from) is the part of
   * the hex they are to. Islands cannot grow past what fits in the hex, so a
   * share beyond that is drawn as large as they go.
   */
  // Keep the layout anchors at the islands' ordinary sizes. Scaling the anchors
  // with a per-hex land override made a larger requested share move islands into
  // less usable positions, so the visible land area could paradoxically shrink.
  const islandFloor = (_i: number): number => 1;
  /** The area of the outer half of the ink round each outline, of a closed ring as a rounded offset of it. */
  const outlineBand = (rings: Point[][]): number =>
    inkReach === 0
      ? 0
      : rings.reduce((sum, ring) => {
          let perimeter = 0;
          for (let k = 0; k < ring.length; k++) {
            const a = ring[k]!;
            const b = ring[(k + 1) % ring.length]!;
            perimeter += Math.hypot(b.x - a.x, b.y - a.y);
          }
          return sum + perimeter * inkReach + Math.PI * inkReach * inkReach;
        }, 0);
  const islandScales = new Map<number, number>();
  const islandScale = (i: number): number => {
    const known = islandScales.get(i);
    if (known !== undefined) return known;
    const spec = islandSpecFor(base![i], map.islandSpecs?.[String(i)]);
    const usual = (spec.large * dimensions.largeIslandPercent + spec.small * dimensions.smallIslandPercent) / 100;
    const want = islandCover(i);
    // What fixes the islands' shapes and places, and so the size that covers `want`.
    const mainland = base![i] === 'Mainland and islands' ? mainlandOf(i).map((ring) => ring.map((q) => `${Math.round(q.x * 10)},${Math.round(q.y * 10)}`).join(' ')) : [];
    const memoKey = JSON.stringify([size, seed, inkReach, i, cols, levelOf(i), knobs.islands, spec, Math.round(coastward(i, spec) * 1000), want, dimensions.largeIslandPercent, dimensions.smallIslandPercent, mainland]);
    let times = islandScaleMemo.get(memoKey);
    if (times === undefined) {
      times = 1;
      const floor = islandFloor(i);
      if (usual <= 0 || want <= 0) times = want > 0 ? 1 : 0;
      else {
        const corners = hexCorners(i % cols, Math.floor(i / cols), size);
        // Islands may not run into each other or the mainland, so there is a size past which they cannot grow.
        const room = size * 0.004;
        // `t` multiplies area (the radii use sqrt(t)), so the measured-area ratio
        // gives the direct next estimate. A crowded size is not measured; the
        // search turns back towards the largest non-overlapping size.
        let t = Math.min(Math.max(2, (want / usual) * 4), (want / usual) * 1.12);
        let best = { t: floor, off: Infinity };
        let fits = 0;
        let over = Infinity;
        let below = 0;
        let above = Infinity;
        for (let k = 0; k < 20; k++) {
          const laid = layoutAt(i, t, floor);
          let next: number;
          if (laid.crowd > room) {
            over = Math.min(over, t);
            next = fits > 0 ? (fits + over) / 2 : t * 0.85;
          } else {
            fits = Math.max(fits, t);
            // What shows is the land and the outer half of the coast's ink round it: a share set for an
            // island is measured to the outside of its outline, not to the line's middle.
            const rings = pathPolylines(islandPathFrom(i, laid.isles), 8);
            const c = (coveredArea(rings, corners, 128) + outlineBand(rings)) / hexArea;
            const off = Math.abs(c - want);
            if (off < best.off) best = { t, off };
            if (off < 0.0005 || c <= 1e-6) break;
            if (c < want) below = Math.max(below, t);
            else above = Math.min(above, t);
            next = above < Infinity && below > 0 ? (below + above) / 2 : t * Math.max(0.6, Math.min(1.6, want / c));
            if (next >= over) next = (fits + over) / 2;
          }
          // As large as the hex lets them be, or no further to go.
          if (over < Infinity && fits > 0 && over - fits <= over * 0.01) break;
          if (Math.abs(next - t) < t * 0.0005) break;
          t = next;
        }
        // Islands that cannot all fit at their share are drawn smaller, not run together.
        times = fits > 0 && over < Infinity ? Math.min(best.t, fits) : best.t;
      }
      if (islandScaleMemo.size > 20000) islandScaleMemo.clear();
      islandScaleMemo.set(memoKey, times);
    }
    islandScales.set(i, times);
    return times;
  };
  const sizedIsles = (i: number): Isle[] => sizedIslesAt(i, islandScale(i));
  const islandPath = (i: number): PathCmd[] => islandPathAt(i, islandScale(i));

  /** Whether a point is land as drawn: the coast's land, or one of the islands of an island hex. */
  const isleMemo = new Map<number, Isle[]>();
  const isleAt = (p: Point): boolean => {
    if (!base) return false;
    const at = pixelToOffset(p.x, p.y, size);
    // An island may reach a little past its own hex.
    const near = [at, ...[0, 1, 2, 3, 4, 5].map((e) => neighbourOf(at.col, at.row, e))];
    for (const { col, row } of near) {
      if (!inBounds(cols, rows, col, row)) continue;
      const j = row * cols + col;
      if (!isIslandType(base[j]) || terrain?.split.has(j)) continue;
      let isles = isleMemo.get(j);
      if (!isles) isleMemo.set(j, (isles = sizedIsles(j)));
      for (const isle of isles) {
        const dx = p.x - isle.c.x;
        const dy = p.y - isle.c.y;
        const u = dx * Math.cos(isle.axis) + dy * Math.sin(isle.axis);
        const v = -dx * Math.sin(isle.axis) + dy * Math.cos(isle.axis);
        if ((u / isle.rx) ** 2 + (v / isle.ry) ** 2 <= 1) return true;
      }
    }
    return false;
  };
  /** Land as drawn: inside the sea coast, or on an island, and not in a lake's water (see `seaCoastLand`). */
  const landAt = (p: Point): boolean =>
    base ? (Boolean(seaCoastLand?.(p)) || isleAt(p)) && !inLakeWater(p) : false;
  /**
   * Where the answer is the same throughout a hex: plain Land with plain Land all round (1), or
   * open sea with open sea all round (2). A coast's smoothing, roughening or cutting back, and an
   * island, never reach either, so a point in one need not be tested.
   */
  const settled = new Uint8Array(cols * rows);
  if (base) {
    const kind = (j: number) => (inLakeBody.has(j) ? 0 : base[j] === 'Land' ? 1 : base[j] === 'Sea' || base[j] === 'Sea Ice' ? 2 : 0);
    for (let i = 0; i < cols * rows; i++) {
      const k = kind(i);
      if (k === 0) continue;
      let same = true;
      for (let e = 0; e < 6 && same; e++) {
        const n = neighbourOf(i % cols, Math.floor(i / cols), e);
        if (inBounds(cols, rows, n.col, n.row)) same = kind(hexIndex(cols, n.col, n.row)) === k;
      }
      if (same) settled[i] = k;
    }
  }
  /** `landAt`, answered at once where a hex is wholly land or wholly sea: for searches that test many points, such as names. */
  const quickLandAt = (p: Point): boolean => {
    const { col, row } = pixelToOffset(p.x, p.y, size);
    const k = inBounds(cols, rows, col, row) ? settled[hexIndex(cols, col, row)] : 0;
    return k === 1 ? true : k === 2 ? false : landAt(p);
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
      // A reshaped hex has only the water it was left with.
      const left = coast?.water.get(i);
      if (left && body === 'sea') {
        pieces.push(...left);
        continue;
      }
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
      if (knobs.water === 'ripples' && knobs.ripples === 0) continue;
      const clip = waterClip(body);
      if (!clip) continue;
      const water = body === 'lake' ? palette.lake : palette.sea;
      const surface = knobs.water === 'depth'
        ? depthBands(shorelines, size, water, shift(palette.seaShallow, palette.sea, water))
        : rippleBands(shorelines, size, water, palette.ripple, palette.rippleAlpha, body === 'lake' ? Math.min(1, knobs.ripples) : knobs.ripples);
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
  /**
   * How irregular a lake's shore is at a point: set on the lake hex it bounds, else by the land hex beside
   * it, else by the map's lake default.
   */
  const lakeShoreAmplitude = (p: Point): number => {
    const { col, row } = pixelToOffset(p.x, p.y, size);
    const j = inBounds(cols, rows, col, row) ? hexIndex(cols, col, row) : -1;
    const land = j >= 0 && !isWater(j) && !inLakeBody.has(j) ? j : -1;
    // The lake hex this stretch of shore belongs to: the nearest one touching the land hex (or the one the point is in).
    let lake = j >= 0 && base?.[j] === 'Lake' ? j : -1;
    if (lake < 0 && j >= 0) {
      let nearest = Infinity;
      for (let e = 0; e < 6; e++) {
        const n = neighbourOf(col, row, e);
        if (!inBounds(cols, rows, n.col, n.row)) continue;
        const k = hexIndex(cols, n.col, n.row);
        if (base?.[k] !== 'Lake') continue;
        const c = hexCenter(n.col, n.row, size);
        const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
        if (d < nearest) {
          nearest = d;
          lake = k;
        }
      }
    }
    return COAST_AMPLITUDE[lakeShoreIrregularity(land >= 0 ? base?.[land] : null, land >= 0 ? map.hexShapes?.[String(land)] : undefined, map.defaultLakeIrregularity, lake >= 0 ? map.hexShapes?.[String(lake)] : undefined)];
  };
  /** How far in a partly-land hex beside the lake has its shore drawn, at a point on it; negative elsewhere. */
  /** What the measured lake shore has been moved by, per hex, to bring each hex to its land share (see below). */
  const landFix = new Map<number, number>();
  const lakeFix = new Map<number, number>();
  const lakeShoreInset = (p: Point): number | null => {
    const { col, row } = pixelToOffset(p.x, p.y, size);
    if (!inBounds(cols, rows, col, row)) return null;
    const h = hexIndex(cols, col, row);
    const cut0 = traced?.insets.get(h) ?? null;
    const cut = cut0 === null ? null : cut0 + (landFix.get(h) ?? 0);
    // Land drawn into the lake hex this point's shore belongs to (the nearest lake hex beside it).
    let lake = -1;
    let nearest = Infinity;
    for (let e = 0; e < 6; e++) {
      const n = neighbourOf(col, row, e);
      if (!inBounds(cols, rows, n.col, n.row)) continue;
      const j = hexIndex(cols, n.col, n.row);
      if (!isLakeHex(j)) continue;
      const c = hexCenter(n.col, n.row, size);
      const dist = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
      if (dist < nearest) {
        nearest = dist;
        lake = j;
      }
    }
    const grown0 = lake >= 0 ? traced?.lakeInsets.get(lake) ?? null : null;
    let grown = grown0 === null ? null : grown0 + (lakeFix.get(lake) ?? 0);
    const shape = lake >= 0 ? hexShapeFor(base?.[lake], map.hexShapes?.[String(lake)]) : null;
    if (grown !== null && shape && hasLandConcentration(base?.[lake]) && shape.concentrationSide !== undefined) {
      const centre = hexCenter(lake % cols, Math.floor(lake / cols), size);
      const midpoint = hexEdgeMidpoint(lake % cols, Math.floor(lake / cols), shape.concentrationSide, size);
      const chosenAngle = Math.atan2(midpoint.y - centre.y, midpoint.x - centre.x);
      const pointAngle = Math.atan2(p.y - centre.y, p.x - centre.x);
      grown *= 1 + 0.9 * ((shape.concentration ?? 0) / 100) * Math.cos(pointAngle - chosenAngle);
    }
    if (grown === null) return cut;
    return (cut ?? 0) - grown;
  };
  const lakeOutlines: PathCmd[] = [];
  /** Each lake's drawn shore (body and the islands in it), by lake. */
  const lakeShores: PathCmd[][] = [];
  const lakeOf = new Map<number, number>();
  lakeBodies.forEach((lake, k) => lake.forEach((i) => lakeOf.set(i, k)));
  const lakeBodyOf = (lake: number[]): PathCmd[] => {
    const rand = (k: number) => unit(seed, 'lake', lake[0]!, k);
    return lakeBodyPath(
      surfaceEdges(terrain!, size, (side) => side === 'lake', new Set(lake)),
      size,
      rand,
      (p) => (isThinLand(p) ? 0.1 : 1),
      { amplitude: lakeShoreAmplitude, noise: (x, y, k) => unit(seed, 'lake', Math.round(x * 1000), Math.round(y * 1000), k) },
      lakeShoreInset,
    );
  };
  let lakeDraws = lakeBodies.map(lakeBodyOf);
  // A hex whose land share a lake shore sets is measured on the shore as drawn (smoothed and roughened) and the
  // shore moved until the hex shows its share: the land and the lake's border round it, which counts as land.
  const aims = traced?.lakeAim;
  if (aims && aims.size > 0) {
    const hexArea = 1.5 * Math.sqrt(3) * size * size;
    for (let pass = 0; pass < 6; pass++) {
      const rings = lakeDraws.flatMap((d) => pathPolylines(d, 4));
      let miss = 0;
      for (const [h, aim] of aims) {
        const corners = hexCorners(h % cols, Math.floor(h / cols), size);
        // The shore's length in the hex: the stretches whose middle is nearest this hex's centre.
        let length = 0;
        for (const ring of rings) {
          for (let k = 0; k < ring.length; k++) {
            const a = ring[k]!;
            const b = ring[(k + 1) % ring.length]!;
            if (nearestHex({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, cols, rows, size) === h) length += Math.hypot(b.x - a.x, b.y - a.y);
          }
        }
        if (length < 1e-6) continue;
        const water = Math.max(0, coveredArea(rings, corners, 64) - length * inkReachOf);
        const err = aim.land - (1 - water / hexArea);
        miss = Math.max(miss, Math.abs(err));
        const step = ((err * hexArea) / length) * 0.8;
        if (aim.lake) lakeFix.set(h, (lakeFix.get(h) ?? 0) + step);
        else landFix.set(h, (landFix.get(h) ?? 0) - step);
      }
      if (miss < 0.005) break;
      lakeDraws = lakeBodies.map(lakeBodyOf);
    }
  }
  for (const [k, lake] of lakeBodies.entries()) {
    const d = lakeDraws[k]!;
    const isles = lake.filter((i) => lakeIslands.has(i)).flatMap(islandPath);
    lakeOutlines.push(...d, ...isles);
    lakeShores.push([...d, ...isles]);
    prims.push({ kind: 'path', d, fill: palette.lake });
    if (knobs.water !== 'flat' && !(knobs.water === 'ripples' && knobs.ripples === 0)) {
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
          ...[...(coast?.toLand ?? []), ...(coast?.grown ?? [])].filter((s) => base?.[s.donor] === 'Glacier').flatMap((s) => s.d),
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
      strokeWidth: Math.max(0.8, size * palette.coastWidth * knobs.lineWeight),
      round: true,
    });
  }

  // Glacier against pack ice: ice on ice, so the coast's ink gives way to a pale seam.
  if (texturedIce && !thematic && glacierHexes.length > 0 && iceHexes.length > 0 && coastLines.length > 0) {
    const nearPack = nearHexes(cols, rows, size, (i) => (base?.[i] === 'Sea Ice' ? 'Smooth' : null), 1.25);
    prims.push(
      ...iceSeam(coastLines, size, (p) => nearGlacier(p) !== null && nearPack(p) !== null, mix(palette.seaIce, palette.iceShade, 0.35), Math.max(0.8, size * palette.coastWidth * knobs.lineWeight)),
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
    for (const sliver of [...(traced?.geometry.toLand ?? []), ...(traced?.geometry.grown ?? [])]) {
      const owner = polities.owner[sliver.donor];
      if (owner) addLand(owner, sliver.d);
    }
    // The banks of a strait belong to the realms whose land they face, unless
    // the strait hex is itself owned: then its own region colours them.
    for (const [i, split] of terrain?.split ?? []) {
      if (base?.[i] === 'Strait' && polities.owner[i]) continue;
      // A strait's banks are drawn to its width, reaching in from the edges that face land as far as that
      // needs: the realm colours them as drawn, each bank in the colour of the land it grows from.
      const banks = base?.[i] === 'Strait' ? traced?.geometry.land.get(i) : undefined;
      if (banks && banks.length > 0) {
        const pieces = split.sides
          .map((side, p) => ({ side, p, at: centroidOf(piecePoints(i % cols, Math.floor(i / cols), p, size)) }))
          .filter((piece) => piece.side === 'land');
        for (const poly of banks) {
          const c = centroidOf(poly);
          let nearest = pieces[0];
          for (const piece of pieces) if (!nearest || Math.hypot(piece.at.x - c.x, piece.at.y - c.y) < Math.hypot(nearest.at.x - c.x, nearest.at.y - c.y)) nearest = piece;
          const owner = nearest ? polities.owner[split.donors[nearest.p]!] : null;
          if (owner) addLand(owner, [...poly.map((q, k) => [k === 0 ? 'M' : 'L', q.x, q.y] as PathCmd), ['Z']]);
        }
        continue;
      }
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
    // Bands and borders stop at the water as drawn: they are cut to the land
    // inside the coast as it is drawn, then to everything outside the lake
    // bodies (less the islands in them). Two clips, not one even-odd mask of
    // both: a lake reaching past the coast would flip the sea beside it to land.
    // (Cutting out the water pieces instead goes wrong where one lies under
    // land the coast has since bulged over.)
    const pageRect: PathCmd[] = [['M', -size, -size], ['L', width + size, -size], ['L', width + size, height + size], ['L', -size, height + size], ['Z']];
    const onLand = (inner: Prim[]): Prim[] => {
      const dry: Prim[] = lakeOutlines.length > 0 ? [{ kind: 'group', clip: [...pageRect, ...lakeOutlines], clipRule: 'evenodd', prims: inner }] : inner;
      return traced ? [{ kind: 'group', clip: drawnLand(traced.geometry, width, height, size), clipRule: 'evenodd', prims: dry }] : dry;
    };
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
        prims: onLand([
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
        ]),
      });
    }
    // A fine ink line where one realm ends and the next begins.
    if (knobs.frontier !== 'none' && frontier.length > 0) {
      const d = chainEdges(frontier).flatMap((chain) =>
        chain.points.map((p, k) => [k === 0 ? 'M' : 'L', p.x, p.y] as PathCmd).concat(chain.closed ? [['Z'] as PathCmd] : []),
      );
      prims.push(...onLand([{
        kind: 'path',
        d,
        stroke: palette.frontier,
        strokeWidth: Math.max(0.8, size * 0.0375 * knobs.lineWeight),
        dash: knobs.frontier === 'dashed'
          ? [size * 0.22, size * 0.12]
          : knobs.frontier === 'dashdot'
            ? [size * 0.3, size * 0.1, size * 0.04, size * 0.1]
            : undefined,
        round: true,
      }]));
    }
    if (internal.length > 0) {
      prims.push(...onLand([{
        kind: 'path',
        d: internal,
        stroke: palette.frontier,
        strokeWidth: Math.max(0.8, size * 0.034 * knobs.lineWeight),
        dash: [size * 0.16, size * 0.1],
        round: true,
      }]));
    }
  }

  // --- drawn relief and vegetation ----------------------------------------------------
  /** Where each drawn relief or vegetation symbol sits in `prims`, so names can later fade those under them. */
  const reliefRuns: Array<{ hex: number; at: Point; from: number; to: number }> = [];
  if (relief === 'illustrated' && base) {
    const vegetation = opts.visible.vegetation ? layers.vegetation.data : null;
    const placed: Placed[] = [];
    // A symbol stands on the land as drawn, not on the hex it belongs to: a hex cut back to a
    // small land share keeps its peaks on that land, and an island's or a strait's bank's
    // relief stands on the island or the bank.
    const dry = landAt;
    for (let i = 0; i < cols * rows; i++) {
      if (inLakeBody.has(i)) continue;
      if (isWater(i) && !(isIslandType(base[i]) || base[i] === 'Strait')) continue;
      const height = elevationData?.[i] ?? null;
      const cover = vegetation?.[i] ?? null;
      if (!height && !cover) continue;
      const firstOfHex = placed.length;
      const col = i % cols;
      const row = Math.floor(i / cols);
      const centre = hexCenter(col, row, size);
      const rand = (k: number) => unit(seed, 'symbol', i, k);
      const colours = { ground: groundColour(i), ink: palette.ink };
      const crowded = height === 'Mountains' || height === 'Highland' || height === 'Hills' || height === 'Plateau';
      const draw = (at: Point, s: number): Placed[] => [
        ...(height ? reliefSymbols(at, s, height, rand, colours) : []),
        ...(cover && height !== 'Mountains' ? vegetationSymbols(at, s, cover, rand, colours, crowded) : []),
      ];
      const inHex = (p: Point): boolean => {
        const at = pixelToOffset(p.x, p.y, size);
        return at.col === col && at.row === row;
      };
      const fitted = fitSymbols(`${i}/${height ?? ''}/${cover ?? ''}`, draw, centre, dry, inHex);
      placed.push(...fitted.placed);
      trace(i, fitted.placed);
      noteFit(i, `${[height, height !== 'Mountains' ? cover : null].filter(Boolean).join(' and ')} symbols`, fitted);
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
          const [a, b] = hexEdgePoints(col, row, e, size);
          const scarp = escarpment(a, b, centre, size, colours, (k) => rand(600 + e * 20 + k));
          // An escarpment runs along a border with land; where reshaping has put water there, it is left out.
          if (standsOnLand(scarp, dry)) {
            placed.push(scarp);
            trace(i, [scarp]);
          }
        }
      }
      for (let k = firstOfHex; k < placed.length; k++) placed[k]!.hex = i;
    }
    placed.sort((a, b) => a.y - b.y);
    for (const p of placed) {
      if (p.hex !== undefined) reliefRuns.push({ hex: p.hex, at: symbolAnchor(p), from: prims.length, to: prims.length + p.prims.length });
      prims.push(...p.prims);
    }
  }

  /** A city marker's radius: grows with population, at a little under the old markers' weight. */
  const markerRadius = (population: number) =>
    0.85 * Math.max(size * 0.16, Math.min(size * 0.46, size * 0.1 * Math.log10(Math.max(10, population))));
  // --- rivers --------------------------------------------------------------
  const rivers = opts.visible.rivers ? layers.rivers.data : null;
  const tapered = knobs.rivers === 'tapered';
  const courses = new Map<string, Point[]>();
  const meanWidths = new Map<string, number>();
  const widthProfiles = new Map<string, number[]>();
  // The land as drawn, coast and all, which a river keeps to and which a river into the sea ends at.
  const shoreLand = traced && rivers && tapered
    ? (() => {
        const side = landBySide(traced.geometry.paths.flatMap((d) => pathPolylines(d, 6)), size * 0.9, (p) => traced.onLand(p));
        return (p: Point): boolean => side(p) || isleAt(p);
      })()
    : null;
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
          onLand: shoreLand,
        };
      }, (opts.visible.cities ? layers.cities.data?.cities ?? [] : [])
        .filter((city) => city.onRiver && city.riverId)
        .map((city) => {
          const symbol = citySymbolForPopulation(city.population);
          return {
            riverId: city.riverId!,
            id: city.id,
            at: hexCenter(city.col, city.row, size),
            radius: markerRadius(city.population),
            // A city on its river (not a port at the shore) is set into the bank and shapes the course.
            icon: resolvedSite(city, lakeEdgesOf(city, base, cols)).kind === 'river'
              ? { reach: iconClearance(knobs.cityMarkers, symbol, markerRadius(city.population)), ...riverStance(knobs.cityRiver, symbol), dy: iconDrop(knobs.cityMarkers, symbol, markerRadius(city.population)) }
              : undefined,
          };
        }), knobs.riverWander)
    : new Map();
  // Everything a river draws, cut to the land below: over a lake or the sea it does not show, so a river through a lake
  // shows on either side of the water only.
  const riverList: Prim[] = [];
  const riverPrims = (_river: River): Prim[] => riverList;
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
    if (tapered) {
      // Every river's edge first, then every river's water over it, so where
      // one river joins another the edge stops at the join.
      const drawn = rivers.rivers.flatMap((river) => {
        const course = tapering.get(river.id);
        if (!course) return [];
        courses.set(river.id, course.centreline);
        widthProfiles.set(river.id, course.widths);
        meanWidths.set(river.id, course.widths.reduce((sum, w) => sum + w, 0) / course.widths.length);
        return [{ river, course }];
      });
      for (const { river, course } of drawn) {
        for (const points of course.bank) riverPrims(river).push({ kind: 'polyline', points, stroke: palette.riverBank, strokeWidth: Math.max(1, size * 0.04), round: true });
      }
      for (const { river, course } of drawn) {
        riverPrims(river).push({ kind: 'path', d: course.outline, fill: palette.river, stroke: palette.river, strokeWidth: Math.max(0.3, size * 0.01), round: true });
      }
    }
    for (const river of tapered ? [] : rivers.rivers) {
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
        riverPrims(river).push({
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

  // A river never shows over open water, whatever its course does: it is cut to the page less the sea and the lakes
  // (a river through a lake shows on either side of the water only). Islands in a lake are land, and show.
  const seaWater = waterClip('sea') ?? [];
  if (seaWater.length + lakeOutlines.length === 0) prims.push(...riverList);
  else if (riverList.length > 0) {
    const page: PathCmd[] = [['M', -size, -size], ['L', width + size, -size], ['L', width + size, height + size], ['L', -size, height + size], ['Z']];
    prims.push({ kind: 'group', clip: [...page, ...seaWater, ...lakeOutlines], clipRule: 'evenodd', prims: riverList });
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
  const riverIcons = new Map<string, Point>([...tapering.values()].flatMap((course) => course.icons.map((icon) => [icon.id, icon.at] as [string, Point])));
  const sites = new Map<string, Point>(
    (cities?.cities ?? []).map((city) => [
      city.id,
      citySite(city, {
        size,
        base,
        cols,
        riverLine: (id) => courses.get(id) ?? null,
        // A river city's icon is set into the bank, where the course was bowed round it.
        riverIcon: (id) => riverIcons.get(id) ?? null,
        islandCentre: (i) => islandCentre(i),
        onLand: landAt,
      }),
    ]),
  );
  const siteOf = (city: { id: string; col: number; row: number }) => sites.get(city.id) ?? hexCenter(city.col, city.row, size);
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
      const colours = { ink: palette.cityFill, paper: palette.cityRing, river: palette.river };
      const line = city.riverId && resolvedSite(city, lakeEdgesOf(city, base, cols)).kind === 'river' ? courses.get(city.riverId) : null;
      const widths = city.riverId ? widthProfiles.get(city.riverId) : null;
      if (line && widths) {
        // The icon is drawn whole, on top of the river; the style says whether the river bows round it, runs behind it,
        // or (a larger icon) is shown through it.
        const plain = knobs.cityMarkers === 'symbols'
          ? symbolMarker(symbol, c, r, colours, true)
          : cityMarker(knobs.cityMarkers, symbol, c, r, colours, (k) => unit(seed, 'city', city.id, k));
        prims.push(...plain);
        if (showsRiver(symbol)) prims.push(...riverThroughIcon(knobs.cityRiver, plain, c, iconClearance(knobs.cityMarkers, symbol, r), { line, widths }, { river: knobs.cityMarkers === 'classic' ? palette.river : mix(palette.river, palette.cityRing, 0.4) }, Math.max(1, size * 0.04)));
      } else if (knobs.cityMarkers === 'symbols') {
        prims.push({ kind: 'city', c, r, onRiver: city.onRiver, symbol, riverDot: palette.river, fill: palette.cityFill, ring: palette.cityRing });
      } else {
        prims.push(...cityMarker(knobs.cityMarkers, symbol, c, r, colours, (k) => unit(seed, 'city', city.id, k)));
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
  // A small city-state is known by its capital alone: no realm name, and its
  // seat is lettered in capitals as a realm's name would be.
  const seats = polities && cities ? cityStateSeats(polities.polities, polities.owner, cities.cities, cols, opts.cityStateMax) : new Map<string, string>();
  const seatIds = new Set(seats.values());
  const unnamed = new Set(seats.keys());
  /** Realms named other than as asked, or not at all. */
  const nameNotesOut: PolityLabelNote[] = [];
  if (opts.labels && polities) {
    const labelLakes =new Set<number>((traced?.lakes ?? []).flat());
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
    const nameNotes = nameNotesOut;
    if (maxDepth === 0) {
      // The land as drawn depends on the traced coast and on how the islands are laid out.
      const landKey = [traced, map.islandSpecs, map.hexDimensions, knobs.islands, knobs.coast];
      const named = cachedPolityLabels(namingPolities!, cities, cols, rows, size, obstacles, opts.polityNames, knobs.realmNames, realmRole, lettering.id, labelLakes, unnamed, quickLandAt, landKey);
      nameNotes.push(...named.notes);
      levels.push({ labels: named.labels, depth: 0 });
    } else {
      const claimed: LabelObstacle[] = [...obstacles];
      for (let depth = 0; depth <= maxDepth; depth++) {
        const labels = placePolityLabels({
          cols,
          rows,
          size,
          owner: ownersAtDepth(polities.polities, namingPolities!.owner, depth),
          polities: polities.polities.filter((p) => depths.get(p.id) === depth && !unnamed.has(p.id)),
          obstacles: claimed,
          minHexes: opts.polityNames,
          scale: depth === 0 ? 1 : 0.62 ** depth,
          sizing: knobs.realmNames,
          lakes: labelLakes,
          land: quickLandAt,
          notes: nameNotes,
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
            tag: { kind: 'polity', owner: label.polityId },
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

  // Names given up or set awkwardly are reported against every hex of their realm (and its parts).
  if (polities && nameNotesOut.length > 0) {
    for (const note of nameNotesOut) {
      const own = new Set([note.polityId, ...descendantsOf(polities.polities, note.polityId)]);
      const hexes = polities.owner.flatMap((o, i) => (o && own.has(o) ? [i] : []));
      compromises.push({ hexes, what: note.what, why: note.why });
    }
  }

  // Relief under a realm's name is faded, not removed: the name stays legible
  // over mountains and woods while the ground still shows through. The `taken`
  // list holds only realm names at this point.
  if (reliefRuns.length > 0 && taken.length > 0) {
    const reach = size * RELIEF_FADE_REACH;
    const near = taken.map((b) => ({ ...b, halfW: b.halfW + reach, halfH: b.halfH + reach }));
    // Latest first, so earlier runs keep their positions as each is wrapped.
    for (let k = reliefRuns.length - 1; k >= 0; k--) {
      const run = reliefRuns[k]!;
      // Where the symbol stands, which on a hex with little land is not the hex's middle.
      const c = run.at;
      if (!near.some((b) => insideBox(b, c.x, c.y))) continue;
      prims.splice(run.from, run.to - run.from, { kind: 'group', opacity: RELIEF_FADE, prims: prims.slice(run.from, run.to) });
    }
  }

  // City markers, which river names keep clear of.
  const cityBoxes: OrientedBox[] = (cities?.cities ?? []).map((city) => {
    const c = siteOf(city);
    const reach = markerReach(city.population, city.capital) * 1.15;
    return { cx: c.x, cy: c.y, halfW: reach, halfH: reach, rotation: 0 };
  });

  // --- river and mountain range names -------------------------------------
  if (rivers && opts.riverNames) {
    const pathFor = tapered ? (id: string) => courses.get(id) ?? null : undefined;
    for (const l of placeRiverLabels(rivers.rivers, size, pathFor, lettering.river, [...taken, ...cityBoxes], (id) => meanWidths.get(id), inLakeWater, (id) => widthProfiles.get(id))) {
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
        tag: { kind: 'river' },
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
        tag: { kind: 'range' },
        glyphs: l.glyphs,
      });
      taken.push({ cx: l.at.x, cy: l.at.y, halfW: (roleEm(rangeRole, l.text) * l.size) / 2, halfH: l.size * 0.6, rotation: l.rotation });
    }
  }

  const geoNames = base ? geoNamesOf(map) : [];
  /** The named areas of these kinds, cut down to the hexes that are still eligible. */
  const liveNames = (kinds: GeoNameKind[]) =>
    geoNames
      .filter((n) => !n.hidden && kinds.includes(n.kind))
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
        tag: { kind: 'water' },
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
        tag: { kind: 'land' },
        glyphs: l.glyphs,
      });
      taken.push({ cx: l.at.x, cy: l.at.y, halfW: (roleEm(landRole, l.text) * l.size) / 2, halfH: l.size * 0.6, rotation: l.rotation });
    }
  }

  if (opts.labels && cities) {
    const fontSize = Math.max(8, size * 0.36) * (lettering.city.scale ?? 1);
    // A capital, or the seat of a city-state, is named in capitals.
    const shown = (city: { id?: string; name: string; capital?: boolean }) =>
      city.capital || (city.id && seatIds.has(city.id)) ? city.name.toLocaleUpperCase() : city.name;
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
        tag: { kind: 'city' },
        ...(lettering.city.italic ? { italic: true } : {}),
      });
    }
  }

  const scene: Scene = {
    width,
    height,
    // The sea colour, so the half-hex notches along the left and right edges
    // read as more sea rather than as a black serrated border.
    background: opts.transparentBackground ? 'transparent' : palette.sea,
    prims,
    ...(compromises.length > 0 ? { compromises } : {}),
    markers: (cities?.cities ?? []).map((city) => {
      const c = siteOf(city);
      const reach = markerReach(city.population, city.capital);
      return { cx: c.x, cy: c.y, halfW: reach, halfH: reach, rotation: 0 };
    }),
  };
  landTests.set(scene, landAt);
  symbolTraces.set(scene, traces);
  return scene;
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
