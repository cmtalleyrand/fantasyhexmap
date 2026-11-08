import type { Point } from '../../shared/hex.js';
import type { PathCmd } from './prims.js';
import { pathPolylines } from './ice.js';

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** `points` cut at the circle round `centre`: the runs inside it, each with where it starts and ends in `points`. */
function insideRuns(points: Point[], centre: Point, radius: number): Array<{ from: number; to: number; points: Point[] }> {
  const runs: Array<{ from: number; to: number; points: Point[] }> = [];
  let current: { from: number; points: Point[] } | null = null;
  const inside = (p: Point) => dist(p, centre) < radius;
  const crossing = (a: Point, b: Point): Point => {
    const dx = b.x - a.x, dy = b.y - a.y, x = a.x - centre.x, y = a.y - centre.y;
    const aa = dx * dx + dy * dy, bb = 2 * (x * dx + y * dy), cc = x * x + y * y - radius * radius;
    const root = Math.sqrt(Math.max(0, bb * bb - 4 * aa * cc));
    const ts = [(-bb - root) / (2 * aa), (-bb + root) / (2 * aa)].filter(t => t >= 0 && t <= 1);
    const t = ts[0] ?? 0.5;
    return { x: a.x + dx * t, y: a.y + dy * t };
  };
  for (let k = 0; k < points.length; k++) {
    const p = points[k]!;
    if (inside(p)) {
      if (!current) current = { from: k, points: k === 0 ? [p] : [crossing(points[k - 1]!, p), p] };
      else current.points.push(p);
    } else if (current) {
      current.points.push(crossing(points[k - 1]!, p));
      runs.push({ from: current.from, to: k, points: current.points });
      current = null;
    }
  }
  if (current) runs.push({ from: current.from, to: points.length, points: current.points });
  return runs;
}

/**
 * Coastline chains with the part of each inside the circle round `centre` replaced by the matching
 * part of `rings` (a reshaped shore that agrees with the chains outside the circle). Each run of a
 * chain inside the circle takes the arc of `rings` that enters and leaves the circle where it does.
 * Null when the two disagree there in how they cross it (the reshaping changed which coasts join),
 * so that the caller keeps the coast it had rather than drawing a broken one.
 */
export function spliceChainPaths(paths: PathCmd[][], rings: Point[][], centre: Point, radius: number, tolerance: number): PathCmd[][] | null {
  const arcs: Point[][] = [];
  for (const ring of rings) {
    // Start the ring outside the circle, so that every arc inside it is whole.
    const start = ring.findIndex(p => dist(p, centre) >= radius);
    if (start < 0) continue;
    const turned = [...ring.slice(start), ...ring.slice(1, start + 1)];
    for (const run of insideRuns(turned, centre, radius)) if (run.points.length >= 2) arcs.push(run.points);
  }
  const used = new Set<number>();
  const out = paths.map(path => {
    const closed = path.some(cmd => cmd[0] === 'Z');
    let points = pathPolylines(path, 12)[0];
    if (!points) return path;
    if (closed) {
      // Start a closed chain outside the circle, so that every run inside it is whole.
      const start = points.findIndex(p => dist(p, centre) >= radius);
      if (start < 0) return null;
      const ring = dist(points[0]!, points.at(-1)!) < 1e-9 ? points.slice(0, -1) : points;
      points = [...ring.slice(start), ...ring.slice(0, start + 1)];
    }
    const runs = insideRuns(points, centre, radius);
    if (!runs.length) return path;
    let rebuilt: Point[] = [], at = 0;
    for (const run of runs) {
      const a = run.points[0]!, b = run.points.at(-1)!;
      // A run that starts or ends inside (a chain ending at the page rim within reach) is left as it is.
      if (run.from === 0 || run.to === points.length) return null;
      const match = arcs.findIndex((arc, k) => !used.has(k) &&
        ((dist(arc[0]!, a) < tolerance && dist(arc.at(-1)!, b) < tolerance) || (dist(arc[0]!, b) < tolerance && dist(arc.at(-1)!, a) < tolerance)));
      if (match < 0) return null;
      used.add(match);
      const arc = dist(arcs[match]![0]!, a) < tolerance ? arcs[match]! : [...arcs[match]!].reverse();
      rebuilt = [...rebuilt, ...points.slice(at, run.from), ...arc];
      at = run.to;
    }
    rebuilt = [...rebuilt, ...points.slice(at)];
    return [...rebuilt.map((p, k): PathCmd => [k ? 'L' : 'M', p.x, p.y]), ...(closed ? [['Z'] as PathCmd] : [])];
  });
  if (out.some(path => path === null) || used.size !== arcs.length) return null;
  return out as PathCmd[][];
}
