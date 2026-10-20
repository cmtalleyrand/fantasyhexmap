import type { Point } from '../../shared/hex.js';
import { alike, coastKey, type CoastGeometry, type Sliver } from './coast.js';
import { pathPolylines } from './ice.js';
import { polygonSliver } from './sliver.js';
import type { PathCmd } from './prims.js';

const paintCache = new WeakMap<CoastGeometry, { size: number; patches: Sliver[] }>();
const pathCache = new WeakMap<Sliver[], Map<number, PathCmd[]>>();

/** Immutable geometry can share its compound donor paths across style redraws. */
export function coastPaintPaths(patches: Sliver[]): Map<number, PathCmd[]> {
  const cached = pathCache.get(patches);
  if (cached) return cached;
  const paths = new Map<number, PathCmd[]>();
  for (const s of patches) {
    let d = paths.get(s.donor);
    if (!d) paths.set(s.donor, d = []);
    for (const cmd of s.d) d.push(cmd);
  }
  for (const [donor, d] of paths) paths.set(donor, alike(d));
  pathCache.set(patches, paths);
  return paths;
}

/**
 * Extend donor ground to the FINAL shore, including movement during area fitting.
 * A union of convex patches cannot cancel itself when the swept
 * ribbon folds at a cape. Consumers must clip it to the final land silhouette.
 */
export function coastPaintPatches(geometry: CoastGeometry, size: number): Sliver[] {
  if (!geometry.component) return geometry.toLand;
  const cached = paintCache.get(geometry);
  if (cached?.size === size) return cached.patches;
  const patches: Sliver[] = [];
  const seal = Math.max(0.4, size * 0.02);
  geometry.chains.forEach((chain, k) => {
    const ring = pathPolylines(geometry.paths[k] ?? [], 8)[0];
    if (!ring || ring.length < 2 || !chain.edges.length) return;
    const count = ring.length - 1;
    // Index the final shore once. Source-corner anchors already follow fitting,
    // so their projections retain donor order without a search per tiny segment.
    const bins = new Map<string, Set<number>>();
    let indexed = false;
    const index = () => {
      if (indexed) return;
      indexed = true;
      for (let j = 0; j < count; j++) {
        const a = ring[j]!, b = ring[j + 1]!;
        for (let x = Math.floor(Math.min(a.x, b.x) / size); x <= Math.floor(Math.max(a.x, b.x) / size); x++) {
          for (let y = Math.floor(Math.min(a.y, b.y) / size); y <= Math.floor(Math.max(a.y, b.y) / size); y++) {
            const key = `${x},${y}`;
            let bin = bins.get(key);
            if (!bin) bins.set(key, bin = new Set());
            bin.add(j);
          }
        }
      }
    };
    const position = (source: Point, hint: number): number => {
      const p = geometry.anchors.get(coastKey(source)) ?? source;
      let best = Infinity, at = 0;
      const scan = (indices: Iterable<number>) => {
        for (const j of indices) {
          const a = ring[j]!, b = ring[j + 1]!, dx = b.x - a.x, dy = b.y - a.y;
          const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
          const distance = (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
          if (distance < best) { best = distance; at = j + t; }
        }
      };
      // Component samples retain their order through fitting. The normalized
      // source arc predicts a short local window; fall back to the spatial
      // index only when untangling has removed enough samples to shift it.
      const window = new Set<number>();
      for (let j = Math.floor(hint) - 16; j <= Math.floor(hint) + 16; j++) {
        const k = chain.closed ? (j % count + count) % count : j;
        if (k >= 0 && k < count) window.add(k);
      }
      scan(window);
      if (geometry.anchors.has(coastKey(source)) && best < 1e-12) return at;
      index();
      const bx = Math.floor(p.x / size), by = Math.floor(p.y / size);
      const nearby = new Set<number>();
      for (let x = bx - 1; x <= bx + 1; x++) for (let y = by - 1; y <= by + 1; y++) {
        for (const j of bins.get(`${x},${y}`) ?? []) nearby.add(j);
      }
      scan(nearby);
      if (best > size * size) scan(Array.from({ length: count }, (_, j) => j));
      return at;
    };
    const lengths = chain.edges.map(e => Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y));
    const perimeter = lengths.reduce((a, b) => a + b, 0) || 1;
    const first = chain.closed ? position(chain.edges[0]!.from, 0) : 0;
    const end = chain.closed ? first + count : count;
    const positions = [first];
    let arc = 0;
    for (let j = 1; j < chain.edges.length; j++) {
      arc += lengths[j - 1]!;
      const edge = chain.edges[j]!;
      let at = position(edge.from, count * arc / perimeter);
      if (chain.closed && at < first) at += count;
      // Removed fold-back loops can project two source corners onto one point.
      positions.push(Math.max(positions.at(-1)!, Math.min(end, at)));
    }
    positions.push(end);
    const pointAt = (at: number): Point => {
      const t = chain.closed ? at % count : Math.min(count, at);
      const j = Math.min(count - 1, Math.floor(t)), f = t - j;
      const a = ring[j]!, b = ring[j + 1]!;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    };
    chain.edges.forEach((edge, j) => {
      const start = positions[j]!, finish = positions[j + 1]!;
      const points = [edge.from, edge.to, pointAt(start)];
      for (let at = Math.floor(start) + 1; at < finish; at++) points.push(pointAt(at));
      points.push(pointAt(finish));
      // One convex donor envelope per source edge replaces dozens of tiny
      // swept quads. The final silhouette supplies all coastal detail and holes.
      const hull = convexHull(points);
      const sealed = hull.flatMap(p => [
        { x: p.x - seal, y: p.y - seal }, { x: p.x + seal, y: p.y - seal },
        { x: p.x + seal, y: p.y + seal }, { x: p.x - seal, y: p.y + seal },
      ]);
      patches.push(polygonSliver(convexHull(sealed), edge.land));
    });
  });
  paintCache.set(geometry, { size, patches });
  return patches;
}

function convexHull(points: Point[]): Point[] {
  const sorted = points.sort((a, b) => a.x - b.x || a.y - b.y);
  const half = (ps: Point[]) => {
    const hull: Point[] = [];
    for (const p of ps) {
      while (hull.length >= 2) {
        const a = hull[hull.length - 2]!, b = hull[hull.length - 1]!;
        if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) > 0) break;
        hull.pop();
      }
      hull.push(p);
    }
    return hull.slice(0, -1);
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}
