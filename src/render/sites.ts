/**
 * Where a city's marker sits inside its hex.
 *
 * A port is drawn on its shore and a river town on its river, rather than at
 * the hex centre where the data happens to index it. The city's `site` says
 * which; 'auto' (or no site) means on its river if it has one, else against
 * its coastal edges, else at the centre. Every part of the scene that needs a
 * city's position - the marker, the name, the obstacles realm names avoid -
 * asks here, so they cannot disagree.
 */

import { hexCenter, inBounds, neighbourOf, SQRT3, type Point } from '../../shared/hex.js';
import { isIslandType, type BaseGeo, type City } from '../../shared/types.js';

export interface SiteContext {
  size: number;
  base: ReadonlyArray<BaseGeo | null> | null;
  cols: number;
  /** The drawn centreline of each river, when rivers are drawn as curves. */
  riverLine?: (riverId: string) => Point[] | null;
  /** The centre of the land in an island hex, which need not be the hex centre. */
  islandCentre?: (index: number) => Point | null;
  /** Whether a point is land as the coast is drawn (insets and split hexes included). */
  onLand?: (p: Point) => boolean;
  /** Where the icon of a city on a river is drawn, set into its bank, if the river is drawn as a curve. */
  riverIcon?: (cityId: string) => Point | null;
}

/** How far toward a coastal edge a port is drawn, as a fraction of the hex size. */
const COAST_REACH = 0.55;

/** How far toward a corner of the hex a city is drawn, and how far a free offset may reach, as fractions of the hex size. */
const CORNER_REACH = 0.6;
const OFFSET_REACH = 0.8;
/** How far back from the shore a landward city stands, as a fraction of the hex size. */
const LANDWARD_REACH = 0.4;

export type ResolvedSite = 'inland' | 'river' | 'coast' | 'port' | 'bank' | 'neck' | 'landward' | 'corner' | 'offset';

/** The hex's edges that face a Lake: the water a neck of land between two lakes lies between. */
export function lakeEdgesOf(city: Pick<City, 'col' | 'row'>, base: ReadonlyArray<BaseGeo | null> | null | undefined, cols: number): number[] {
  if (!base || cols <= 0) return [];
  const rows = Math.floor(base.length / cols);
  const edges: number[] = [];
  for (let e = 0; e < 6; e++) {
    const n = neighbourOf(city.col, city.row, e);
    if (inBounds(cols, rows, n.col, n.row) && base[n.row * cols + n.col] === 'Lake') edges.push(e);
  }
  return edges;
}

/**
 * Whether lake edges leave land between two lakes: two of them that are not neighbours (a lake on the east and
 * another on the west, or on the east and the south-west, with the land running through between). Lakes on
 * neighbouring edges are one bay, which is a shore, not a neck.
 */
export function isLakeNeck(lakeEdges: readonly number[]): boolean {
  return lakeEdges.some((a) => lakeEdges.some((b) => {
    const d = Math.abs(a - b) % 6;
    return Math.min(d, 6 - d) >= 2;
  }));
}

/**
 * The site a city is actually drawn at, after 'auto' and any impossible choice are resolved. `lakeEdges` are the
 * hex's lake-facing edges (`lakeEdgesOf`); without them no land between two lakes is recognised.
 */
export function resolvedSite(city: City, lakeEdges: readonly number[] = []): { kind: ResolvedSite; edges: number[] } {
  const site = city.site ?? 'auto';
  const neck = isLakeNeck(lakeEdges);
  if (site === 'inland') return { kind: 'inland', edges: [] };
  if (site === 'river') return city.onRiver ? { kind: 'river', edges: [] } : { kind: 'inland', edges: [] };
  if (site === 'neck' && neck) return { kind: 'neck', edges: [...lakeEdges] };
  if (site === 'landward') return city.coastalEdges.length > 0 ? { kind: 'landward', edges: city.coastalEdges } : { kind: 'inland', edges: [] };
  if (typeof site === 'object' && 'bank' in site) return { kind: 'bank', edges: [site.bank] };
  if (typeof site === 'object' && 'corner' in site) return { kind: 'corner', edges: [((Math.round(site.corner) % 6) + 6) % 6] };
  if (typeof site === 'object' && 'offset' in site) return { kind: 'offset', edges: [] };
  if (typeof site === 'object' && 'coast' in site) {
    const edges = city.coastalEdges.includes(site.coast) ? [site.coast] : city.coastalEdges;
    if (edges.length === 0) return city.onRiver && site.river ? { kind: 'river', edges: [] } : { kind: 'inland', edges: [] };
    return { kind: site.river && city.onRiver ? 'port' : 'coast', edges };
  }
  // A river city on the coast is a port: it stands where the river meets the shore.
  if (city.onRiver && city.coastalEdges.length > 0) return { kind: 'port', edges: city.coastalEdges };
  if (city.onRiver) return { kind: 'river', edges: [] };
  // Land between two lakes has no one shore to stand on: it stands midway between them.
  if (neck) return { kind: 'neck', edges: [...lakeEdges] };
  if (city.coastalEdges.length > 0) return { kind: 'coast', edges: city.coastalEdges };
  return { kind: 'inland', edges: [] };
}

/** The point toward the middle of `edges`, or null when they surround the hex. */
function towardEdges(centre: Point, edges: number[], size: number): Point | null {
  // Edge e's midpoint lies at 60e degrees from the centre.
  let dx = 0;
  let dy = 0;
  for (const e of edges) {
    dx += Math.cos((e * Math.PI) / 3);
    dy += Math.sin((e * Math.PI) / 3);
  }
  const len = Math.hypot(dx, dy);
  // Coast all round (or on opposite sides): there is no one shore to stand on.
  if (len < 0.5) return null;
  return { x: centre.x + (dx / len) * size * COAST_REACH, y: centre.y + (dy / len) * size * COAST_REACH };
}

/** The point of `line` nearest `target`, if it lies within `reach` of the hex centre. */
function onLine(line: Point[] | null | undefined, target: Point, centre: Point, reach: number): Point | null {
  if (!line || line.length === 0) return null;
  let best: Point | null = null;
  let d = Infinity;
  for (const p of line) {
    if (Math.hypot(p.x - centre.x, p.y - centre.y) > reach) continue;
    const dp = Math.hypot(p.x - target.x, p.y - target.y);
    if (dp < d) {
      d = dp;
      best = p;
    }
  }
  return best;
}

/** How far toward its edge a city on a strait's bank is drawn: out on the land tip, past the channel. */
const BANK_REACH = 0.66;

/**
 * `want` if it stands on land with some room round it; else the nearest such
 * point, looking first back along the way to the hex centre (so a port stays on
 * its shore side) and then anywhere in the hex. A hex with no room anywhere
 * falls back to any land at all, then to `want`.
 */
function onLandNear(want: Point, centre: Point, size: number, onLand: (p: Point) => boolean): Point {
  for (const room of [size * 0.12, 0]) {
    const clear = (p: Point) =>
      onLand(p) && (room === 0 || [0, 1, 2, 3, 4, 5].every((k) => onLand({ x: p.x + Math.cos((k * Math.PI) / 3) * room, y: p.y + Math.sin((k * Math.PI) / 3) * room })));
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const p = { x: want.x + (centre.x - want.x) * t, y: want.y + (centre.y - want.y) * t };
      if (clear(p)) return p;
    }
    let best: Point | null = null;
    let d = Infinity;
    for (let r = 0.1; r <= 0.9; r += 0.1) {
      for (let k = 0; k < 24; k++) {
        const a = (k * Math.PI) / 12;
        const p = { x: centre.x + Math.cos(a) * size * r, y: centre.y + Math.sin(a) * size * r };
        const dp = Math.hypot(p.x - want.x, p.y - want.y);
        if (dp < d && clear(p)) {
          d = dp;
          best = p;
        }
      }
    }
    if (best) return best;
  }
  return want;
}

export function citySite(city: City, ctx: SiteContext): Point {
  const site = rawSite(city, ctx);
  if (!ctx.onLand) return site;
  // An island's own drawn land is not part of the coast's, so it is left where it is.
  if (isIslandType(ctx.base?.[city.row * ctx.cols + city.col] ?? null)) return site;
  return onLandNear(site, hexCenter(city.col, city.row, ctx.size), ctx.size, ctx.onLand);
}

function rawSite(city: City, ctx: SiteContext): Point {
  const { size } = ctx;
  const centre = hexCenter(city.col, city.row, size);
  const index = city.row * ctx.cols + city.col;
  // On an island the land is the island, wherever it lies in the hex.
  if (isIslandType(ctx.base?.[index] ?? null)) return ctx.islandCentre?.(index) ?? centre;
  const { kind, edges } = resolvedSite(city, lakeEdgesOf(city, ctx.base, ctx.cols));
  const line = city.riverId ? ctx.riverLine?.(city.riverId) : null;
  // Only the part of the river inside the hex counts: one that clips the hex
  // would otherwise pull the city out of it.
  const reach = size * 0.8;
  if (kind === 'river') {
    // The icon stands where the river was bowed round it; without a drawn curve, on the river.
    return ctx.riverIcon?.(city.id) ?? onLine(line, centre, centre, reach) ?? centre;
  }
  if (kind === 'bank') {
    const tip = towardEdges(centre, edges, size);
    return tip ? { x: centre.x + (tip.x - centre.x) * (BANK_REACH / COAST_REACH), y: centre.y + (tip.y - centre.y) * (BANK_REACH / COAST_REACH) } : centre;
  }
  if (kind === 'neck') {
    // Midway between the lakes: the mean of their edge midpoints, which is the centre for lakes on opposite
    // sides and shifts toward the pass for lakes two edges apart.
    const apothem = (size * SQRT3) / 2;
    let dx = 0;
    let dy = 0;
    for (const e of edges) {
      dx += Math.cos((e * Math.PI) / 3);
      dy += Math.sin((e * Math.PI) / 3);
    }
    return { x: centre.x + (dx / edges.length) * apothem, y: centre.y + (dy / edges.length) * apothem };
  }
  if (kind === 'corner') {
    // Corner c lies between edges c-1 and c, 30 degrees before edge c's midpoint.
    const a = ((edges[0]! * 60 - 30) * Math.PI) / 180;
    return { x: centre.x + Math.cos(a) * size * CORNER_REACH, y: centre.y + Math.sin(a) * size * CORNER_REACH };
  }
  if (kind === 'offset') {
    const o = typeof city.site === 'object' && 'offset' in city.site ? city.site.offset : { x: 0, y: 0 };
    const x = Number.isFinite(o.x) ? o.x : 0;
    const y = Number.isFinite(o.y) ? o.y : 0;
    const len = Math.hypot(x, y);
    const k = len > OFFSET_REACH ? OFFSET_REACH / len : 1;
    return { x: centre.x + x * k * size, y: centre.y + y * k * size };
  }
  const shore = towardEdges(centre, edges, size);
  if (kind === 'landward') {
    // Back from the water, on the side away from it; with water all round, the centre.
    if (!shore) return centre;
    const k = -LANDWARD_REACH / COAST_REACH;
    return { x: centre.x + (shore.x - centre.x) * k, y: centre.y + (shore.y - centre.y) * k };
  }
  if (kind === 'port') {
    // Where the river comes nearest the shore; without a drawn curve, on the shore.
    return onLine(line, shore ?? centre, centre, reach) ?? shore ?? centre;
  }
  if (kind === 'coast') return shore ?? centre;
  return centre;
}
