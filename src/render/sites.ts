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

import { hexCenter, type Point } from '../../shared/hex.js';
import { isIslandType, type BaseGeo, type City } from '../../shared/types.js';

export interface SiteContext {
  size: number;
  base: ReadonlyArray<BaseGeo | null> | null;
  cols: number;
  /** The drawn centreline of each river, when rivers are drawn as curves. */
  riverLine?: (riverId: string) => Point[] | null;
  /** The centre of the land in an island hex, which need not be the hex centre. */
  islandCentre?: (index: number) => Point | null;
}

/** How far toward a coastal edge a port is drawn, as a fraction of the hex size. */
const COAST_REACH = 0.55;

export type ResolvedSite = 'inland' | 'river' | 'coast';

/** The site a city is actually drawn at, after 'auto' and any impossible choice are resolved. */
export function resolvedSite(city: City): { kind: ResolvedSite; edges: number[] } {
  const site = city.site ?? 'auto';
  if (site === 'inland') return { kind: 'inland', edges: [] };
  if (site === 'river') return city.onRiver ? { kind: 'river', edges: [] } : { kind: 'inland', edges: [] };
  if (typeof site === 'object') {
    return city.coastalEdges.includes(site.coast)
      ? { kind: 'coast', edges: [site.coast] }
      : city.coastalEdges.length > 0
        ? { kind: 'coast', edges: city.coastalEdges }
        : { kind: 'inland', edges: [] };
  }
  if (city.onRiver) return { kind: 'river', edges: [] };
  if (city.coastalEdges.length > 0) return { kind: 'coast', edges: city.coastalEdges };
  return { kind: 'inland', edges: [] };
}

export function citySite(city: City, ctx: SiteContext): Point {
  const { size } = ctx;
  const centre = hexCenter(city.col, city.row, size);
  const index = city.row * ctx.cols + city.col;
  // On an island the land is the island, wherever it lies in the hex.
  if (isIslandType(ctx.base?.[index] ?? null)) return ctx.islandCentre?.(index) ?? centre;
  const { kind, edges } = resolvedSite(city);
  if (kind === 'river') {
    const line = city.riverId ? ctx.riverLine?.(city.riverId) : null;
    if (!line || line.length === 0) return centre;
    let best = line[0]!;
    let d = Infinity;
    for (const p of line) {
      const dp = Math.hypot(p.x - centre.x, p.y - centre.y);
      if (dp < d) {
        d = dp;
        best = p;
      }
    }
    // A river that only clips the hex would pull the city out of it.
    return d < size * 0.8 ? best : centre;
  }
  if (kind === 'coast') {
    // Toward the middle of the coastal edges; edge e's midpoint lies at 60e degrees.
    let dx = 0;
    let dy = 0;
    for (const e of edges) {
      dx += Math.cos((e * Math.PI) / 3);
      dy += Math.sin((e * Math.PI) / 3);
    }
    const len = Math.hypot(dx, dy);
    // Coast all round (or on opposite sides): there is no one shore to stand on.
    if (len < 0.5) return centre;
    return { x: centre.x + (dx / len) * size * COAST_REACH, y: centre.y + (dy / len) * size * COAST_REACH };
  }
  return centre;
}
