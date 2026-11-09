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

/** Twice the signed area of a ring, by the shoelace formula. */
const ringArea = (ring: Point[]) => Math.abs(ring.reduce((sum, p, k) => {
  const q = ring[(k + 1) % ring.length]!;
  return sum + p.x * q.y - q.x * p.y;
}, 0)) / 2;

/**
 * Coastline chains with the part of each inside the circle round `centre` replaced by the matching
 * part of `rings` (a reshaped shore that agrees with the chains outside the circle). Each arc of
 * `rings` inside the circle joins two places where a chain crosses it; the chain is rebuilt along the
 * arcs, from each crossing to the one its arc reaches. Where a chain only grazes the circle the arc
 * may cut across inside it, skipping a short stretch outside: that loop is dropped when it is under
 * four times `tolerance` squared in area (a twenty-fifth of a hex radius squared, at the caller's tolerance). Null when the two otherwise disagree in how they cross the circle (an
 * arc joins two chains, or runs back along one), so that the caller keeps the coast it had rather
 * than drawing a broken one.
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
    // A run that starts or ends inside (a chain ending at the page rim within reach) is left as it is.
    if (runs.some(run => run.from === 0 || run.to === points.length)) return null;
    // Where the chain crosses the circle, in order along it: each run's entry, then its exit.
    const crossings = runs.flatMap((run, r) => [{ r, end: 0, at: run.points[0]! }, { r, end: 1, at: run.points.at(-1)! }]);
    const near = (p: Point) => crossings.findIndex(c => dist(c.at, p) < tolerance);
    let rebuilt: Point[] = [], at = 0, k = 0;
    while (k < crossings.length) {
      const entry = crossings[k]!;
      const match = arcs.findIndex((arc, a) => !used.has(a) && (near(arc[0]!) === k || near(arc.at(-1)!) === k));
      if (match < 0) return null;
      const arc = near(arcs[match]![0]!) === k ? arcs[match]! : [...arcs[match]!].reverse();
      const exit = near(arc.at(-1)!);
      // The arc must run forward to an exit of this chain.
      if (exit <= k || crossings[exit]!.end !== 1) return null;
      used.add(match);
      const from = runs[entry.r]!, to = runs[crossings[exit]!.r]!;
      // Each stretch skipped outside the circle, between an exit and the next entry, is a sliver
      // where the chain grazes it, closed by its own short arc inside: both go.
      for (let j = k + 1; j < exit; j += 2) {
        const out = crossings[j]!, back = crossings[j + 1]!;
        const inner = arcs.findIndex((arc, a) => !used.has(a) && a !== match &&
          ((near(arc[0]!) === j && near(arc.at(-1)!) === j + 1) || (near(arc[0]!) === j + 1 && near(arc.at(-1)!) === j)));
        if (inner < 0) return null;
        const sliver = [out.at, ...points.slice(runs[out.r]!.to, runs[back.r]!.from), back.at];
        if (ringArea(sliver) > 4 * tolerance * tolerance) return null;
        used.add(inner);
      }
      rebuilt = [...rebuilt, ...points.slice(at, from.from), ...arc];
      at = to.to;
      k = exit + 1;
    }
    rebuilt = [...rebuilt, ...points.slice(at)];
    return [...rebuilt.map((p, k): PathCmd => [k ? 'L' : 'M', p.x, p.y]), ...(closed ? [['Z'] as PathCmd] : [])];
  });
  if (out.some(path => path === null) || used.size !== arcs.length) return null;
  return out as PathCmd[][];
}
