import { roundLoopJoins } from './coastCorners.js';
import { profileCount, profilePhases, profileTime } from './profile.js';
/** Fit every hex's share on the final coastline (see `fitCoastAreas`). */
import { hexCenter, hexCorners, type Point } from '../../shared/hex.js';
import { LAND_SHARE_TOLERANCE } from '../../shared/surfaceArea.js';
import { coastClearance } from './componentCoast.js';
import { drawnLand, drawnLandLayout, evenOddTest, type CoastChain, type CoastGeometry } from './coast.js';
import { areaCoverage, nearestHex, nearestOn } from './footprint.js';
import { pathPolylines } from './ice.js';
import type { PathCmd } from './prims.js';

/** Measuring lines per hex while fitting. 64 moves the fitted coast by under a hundredth
 * of a hex against 128 at about a third less measuring cost (DECISIONS §77). */
export const FIT_COVERAGE_LINES = 64;

/** Remove small fold-back loops already introduced by roughening tight caps. */
export function untangle(ring: Point[], closed: boolean): { ring: Point[]; joins: Point[] } {
  const joins: Point[] = [];
  const area = (points: Point[]) => Math.abs(points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length]!;
    return sum + p.x * q.y - q.x * p.y;
  }, 0));
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  let points = closed ? ring.slice(0, -1) : ring.slice();
  for (let pass = 0; pass < 32; pass++) {
    const n = points.length;
    const segments = closed ? n : n - 1;
    // The first crossing in (i, j) order, as an all-pairs search would find it, from a grid
    // of the segments' boxes: only segments whose boxes meet can cross.
    let xs = Infinity, ys = Infinity, xe = -Infinity, ye = -Infinity;
    for (const p of points) { xs = Math.min(xs, p.x); ys = Math.min(ys, p.y); xe = Math.max(xe, p.x); ye = Math.max(ye, p.y); }
    const cell = Math.max(1e-6, Math.max(xe - xs, ye - ys) / Math.max(1, Math.sqrt(n)));
    const grid = new Map<number, number[]>();
    const key = (x: number, y: number) => x * 1048576 + y;
    const cellsOf = (k: number, visit: (key: number) => void) => {
      const a = points[k]!, b = points[(k + 1) % n]!;
      const x0 = Math.floor((Math.min(a.x, b.x) - xs) / cell), x1 = Math.floor((Math.max(a.x, b.x) - xs) / cell);
      const y0 = Math.floor((Math.min(a.y, b.y) - ys) / cell), y1 = Math.floor((Math.max(a.y, b.y) - ys) / cell);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) visit(key(x, y));
    };
    for (let k = 0; k < segments; k++) cellsOf(k, c => { const list = grid.get(c); if (list) list.push(k); else grid.set(c, [k]); });
    let hit: { i: number; j: number } | null = null;
    for (let i = 0; i < segments && !hit; i++) {
      const a = points[i]!, b = points[(i + 1) % n]!;
      let best = Infinity;
      cellsOf(i, c => {
        for (const j of grid.get(c)!) {
          if (j < i + 2 || j >= best || (closed && i === 0 && j === n - 1)) continue;
          const c0 = points[j]!, d = points[(j + 1) % n]!;
          if (Math.max(a.x, b.x) < Math.min(c0.x, d.x) || Math.min(a.x, b.x) > Math.max(c0.x, d.x) ||
            Math.max(a.y, b.y) < Math.min(c0.y, d.y) || Math.min(a.y, b.y) > Math.max(c0.y, d.y)) continue;
          if (!(cross(a, b, c0) * cross(a, b, d) < -1e-8 && cross(c0, d, a) * cross(c0, d, b) < -1e-8)) continue;
          best = j;
        }
      });
      if (best < Infinity) hit = { i, j: best };
    }
    if (!hit) break;
    const { i, j } = hit;
    const a = points[i]!, b = points[(i + 1) % n]!, c = points[j]!, d = points[(j + 1) % n]!;
    const dx = b.x - a.x, dy = b.y - a.y, ex = d.x - c.x, ey = d.y - c.y;
    const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / (dx * ey - dy * ex);
    const intersection = { x: a.x + t * dx, y: a.y + t * dy };
    joins.push(intersection);
    const outer = [...points.slice(0, i + 1), intersection, ...points.slice(j + 1)];
    const loop = [intersection, ...points.slice(i + 1, j + 1)];
    // An open coast must keep both endpoints: its little loop cannot become a new island.
    points = !closed || area(outer) >= area(loop) ? outer : loop;
  }
  return { ring: closed ? [...points, points[0]!] : points, joins };
}

/**
 * Fit every hex's share at once on the final outline. Each hex has one amount, an even
 * offset of its stretch of coast along the coast's own normal (positive pushes it out
 * to sea, adding land): the coast keeps its shape and grows or shrinks in place, rather
 * than being slid towards one side or swollen about a point. The amounts blend only
 * near hex edges, so the coast moves continuously from one hex to the next. To first
 * order a hex's area changes by its offset times its length of coast, with a little
 * traded across its edges, so the amounts that bring every hex to its share solve one
 * small, nearly diagonal linear system. The outline is then measured exactly and the
 * system solved again for what remains.
 *
 * `targets` are the hexes with a share to reach; every other hex the coast runs through
 * keeps the land it had. Each point moves at most a third of the way to the nearest
 * other coast (a strait is never closed, a thin cape never pinched through), not at all
 * at the map's edge and, for a passage of set width, near the passage's middle; a step
 * that would make the outline cross itself is shortened. A hex whose share cannot be
 * reached within those limits is left as near as they allow, for the caller to report.
 */
export function fitCoastAreas(geometry: CoastGeometry, targets: ReadonlyMap<number, { share: number; width?: number }>,
  cols: number, rows: number, size: number, page: { width: number; height: number }, ink: number,
  /** Every strait and isthmus drawn at a set width, whether or not its share is fitted. */
  passageHexes: Iterable<number> = [], rounds = 4): CoastGeometry {
  if (!geometry.component || !targets.size) return geometry;
  const phase = profilePhases('fit');
  phase('prepare');
  const hexArea = 1.5 * Math.sqrt(3) * size * size;
  const closed = geometry.chains.map(c => c.closed);
  const pathsOf = (rs: Point[][]): PathCmd[][] => rs.map((ring, k) => {
    if (!ring.length) return geometry.paths[k]!;
    const d: PathCmd[] = ring.map((p, j) => [j === 0 ? 'M' : 'L', p.x, p.y]);
    if (closed[k]) d.push(['Z']);
    return d;
  });
  const geometryOf = (rs: Point[][]): CoastGeometry => ({ ...geometry, paths: pathsOf(rs) });
  const centres = Array.from({ length: cols * rows }, (_, h) => hexCenter(h % cols, Math.floor(h / cols), size));
  const centreOf = (h: number) => centres[h]!;
  const corners = new Map<number, Point[]>();
  const cornersOf = (h: number) => {
    let hit = corners.get(h);
    if (!hit) { hit = hexCorners(h % cols, Math.floor(h / cols), size); corners.set(h, hit); }
    return hit;
  };
  // A strait or isthmus keeps its shape, which outranks its share: no movement through
  // the passage's hex or across its joins to the land beside it (its share was fitted
  // when its banks were shaped), easing in beyond them.
  const passages = [...new Set([...passageHexes, ...[...targets].filter(([, t]) => t.width !== undefined).map(([h]) => h)])].map(centreOf);
  const passageFade = (p: Point) => passages.reduce((f, c) =>
    Math.min(f, Math.max(0, Math.min(1, (Math.hypot(p.x - c.x, p.y - c.y) - size * 1.05) / (size * 0.4)))), 1);
  // Remove the fold-back loops roughening left and round their joins, rings in order so
  // each repair checks the rings already repaired.
  let current: Point[][] = [];
  geometry.paths.forEach((d, k) => {
    const ring = pathPolylines(d, 8)[0] ?? [];
    if (ring.length < 4) { current.push(ring); return; }
    const { ring: untangled, joins } = untangle(ring, closed[k]!);
    current.push(roundLoopJoins(untangled, closed[k]!, joins, size * .32, p => passageFade(p) >= 1, current));
  });
  // Open ends never move. Reuse the page-edge joins, then supply the evolving
  // polylines directly, including the original Z closure.
  const layout = drawnLandLayout(geometryOf(current), page.width, page.height, size);
  const strokeRings = (rs: Point[][]) => rs.flatMap((ring, k) => ring.length > 1
    ? [closed[k] ? [...ring, ring[0]!] : ring] : []);
  const landRings = (rs: Point[][]): Point[][] => {
    if (rs.some(ring => ring.length < 2)) return pathPolylines(drawnLand(geometryOf(rs), page.width, page.height, size), 8);
    return layout.map(item => {
      if ('closed' in item) { const ring = rs[item.closed]!; return [...ring, ring[0]!]; }
      const ring: Point[] = [];
      for (const part of item.open) {
        if ('point' in part) ring.push(part.point);
        else ring.push(...(part.first ? rs[part.chain]! : rs[part.chain]!.slice(1)));
      }
      if (ring.length) ring.push(ring[0]!);
      return ring;
    }).filter(ring => ring.length > 1);
  };
  // Each hex's amount holds evenly over the middle of the hex and blends with its
  // neighbour's over about the third of a hex either side of their shared edge.
  const sigma = size * 0.4;
  const weights = (p: Point): Array<[number, number]> => {
    const home = nearestHex(p, cols, rows, size, centres), hc = home % cols, hr = Math.floor(home / cols);
    const out: Array<[number, number]> = [];
    let total = 0;
    for (let r = Math.max(0, hr - 1); r <= Math.min(rows - 1, hr + 1); r++) for (let c = Math.max(0, hc - 1); c <= Math.min(cols - 1, hc + 1); c++) {
      const h = r * cols + c, q = centreOf(h), d2 = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d2 > (size * 1.5) ** 2) continue;
      const w = Math.exp(-d2 / (2 * sigma * sigma));
      if (w < 1e-4) continue;
      out.push([h, w]);
      total += w;
    }
    return out.map(([h, w]) => [h, w / total]);
  };
  const measureAll = (rs: Point[][], hexes: Iterable<number>) => {
    profileCount('fit.measurements');
    const coverage = areaCoverage(landRings(rs),
      { evenOdd: true, stroke: { rings: strokeRings(rs), reach: ink }, reuseScanlines: true });
    const out = new Map<number, number>();
    for (const h of hexes) { profileCount('fit.hexMeasurements'); out.set(h, coverage(cornersOf(h), FIT_COVERAGE_LINES) / hexArea); }
    return out;
  };
  // Every hex the coast runs through takes part: those with a share aim at it, the rest keep theirs.
  const touched = new Set<number>();
  for (const ring of current) for (const p of ring) touched.add(nearestHex(p, cols, rows, size, centres));
  for (const h of targets.keys()) touched.add(h);
  const hexes = [...touched];
  const index = new Map(hexes.map((h, i) => [h, i]));
  // Neighbouring hexes, whose amounts are kept near each other: a coast pulled out in
  // one and back in the next is drawn into a kink at the edge between them.
  const pairs: Array<[number, number]> = [];
  hexes.forEach((h, i) => {
    const hc = h % cols, hr = Math.floor(h / cols);
    for (let r = Math.max(0, hr - 1); r <= Math.min(rows - 1, hr + 1); r++) for (let c = Math.max(0, hc - 1); c <= Math.min(cols - 1, hc + 1); c++) {
      const j = index.get(r * cols + c);
      if (j !== undefined && j > i && Math.hypot(centreOf(h).x - centreOf(r * cols + c).x, centreOf(h).y - centreOf(r * cols + c).y) < size * 1.9) pairs.push([i, j]);
    }
  });
  const initial = profileTime('fit.measure', () => measureAll(current, touched));
  const want = new Map([...touched].map(h => [h, targets.get(h)?.share ?? initial.get(h)!]));
  const error = (m: Map<number, number>) => [...targets.keys()].reduce((s, h) => s + (want.get(h)! - m.get(h)!) ** 2, 0)
    + [...touched].filter(h => !targets.has(h)).reduce((s, h) => s + 0.25 * (want.get(h)! - m.get(h)!) ** 2, 0);
  let shown = initial;
  // Bound the total deformation, not just each accepted step.
  const referenceRings = current;
  for (let round = 0; round < rounds; round++) {
    phase('field');
    profileCount('fit.rounds');
    const short = new Map([...touched].map(h => [h, (want.get(h)! - shown.get(h)!) * hexArea]));
    if (Math.max(...[...targets.keys()].map(h => Math.abs(short.get(h)!))) <= LAND_SHARE_TOLERANCE * hexArea) break;
    // Every point's direction to the sea (each ring's orientation found by probing which
    // side is land), averaged over a short stretch so the roughening's small teeth do not
    // turn it; its weights; how far it may move; and the length of coast it stands for.
    const land = evenOddTest(landRings(current), size / 8);
    const chains: CoastChain[] = current.map((ring, k) => ({ closed: closed[k]!, points: ring,
      edges: ring.slice(0, -1).map((p, j) => ({ from: p, to: ring[j + 1]!, land: -1, water: -1 })) }));
    const clearance = coastClearance(chains, size);
    type Sample = { n: Point; weights: Array<[number, number]>; reach: number; length: number };
    const samples: Sample[][] = current.map((ring, k) => {
      const count = ring.length;
      if (count < 3) return [];
      // A closed ring repeats its first point last; treat that pair as one point.
      const span = closed[k] && ring[0]!.x === ring[count - 1]!.x && ring[0]!.y === ring[count - 1]!.y ? count - 1 : count;
      let votes = 0;
      const step = Math.max(1, Math.floor(count / 24));
      for (let j = 0; j + 1 < count; j += step) {
        const a = ring[j]!, b = ring[j + 1]!, length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        votes += land({ x: (a.x + b.x) / 2 + (b.y - a.y) / length * size * 0.08, y: (a.y + b.y) / 2 - (b.x - a.x) / length * size * 0.08 }) ? -1 : 1;
      }
      const sign = votes >= 0 ? 1 : -1;
      const at = (j: number) => ring[closed[k] ? ((j % span) + span) % span : Math.max(0, Math.min(count - 1, j))]!;
      // Length-weighted segment normals summed over `window` of coast either side (by
      // prefix sums over the ring laid out three times, for a closed ring's wrap).
      const laps = closed[k] ? 3 : 1, segments = closed[k] ? span : count - 1;
      const sum = [{ x: 0, y: 0 }], arcs = [0];
      for (let j = 0; j < segments * laps; j++) {
        const a = at(j), b = at(j + 1), last = sum[j]!;
        sum.push({ x: last.x + sign * (b.y - a.y), y: last.y - sign * (b.x - a.x) });
        arcs.push(arcs[j]! + Math.hypot(b.x - a.x, b.y - a.y));
      }
      const total = closed[k] ? arcs[segments]! : arcs.at(-1)!;
      const window = size * 0.4;
      const below = (value: number) => { // the first index with arcs[i] >= value
        let lo = 0, hi = arcs.length - 1;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (arcs[mid]! < value) lo = mid + 1; else hi = mid; }
        return lo;
      };
      let arc = 0;
      const rooms = new Map<number, number>();
      const out: Sample[] = [];
      for (let j = 0; j < count; j++) {
        const p = ring[j]!;
        const centre = (closed[k] ? segments : 0) + Math.min(j, segments);
        const from = below(arcs[centre]! - window), to = below(arcs[centre]! + window);
        const nx = sum[to]!.x - sum[from]!.x, ny = sum[to]!.y - sum[from]!.y;
        const nl = Math.hypot(nx, ny) || 1;
        const before = j ? Math.hypot(p.x - ring[j - 1]!.x, p.y - ring[j - 1]!.y) : 0;
        const after = j + 1 < count ? Math.hypot(ring[j + 1]!.x - p.x, ring[j + 1]!.y - p.y) : 0;
        arc += before;
        const ends = closed[k] ? 1 : Math.min(1, arc / size, (total - arc) / size);
        if (j % 4 === 0 || j === count - 1) rooms.set(j, clearance(p, chains[k]!, arc));
        out.push({ n: { x: nx / nl, y: ny / nl }, weights: weights(p), reach: ends * passageFade(p), length: (before + after) / 2 });
      }
      // The clearance, found at every fourth point, eased between them; then lowered where
      // needed so it changes by at most half the length of coast it changes over, so a
      // point beside a narrow inlet does not hold still while its neighbours move.
      const reach = out.map((s, j) => {
        const a = j - j % 4, b = Math.min(a + 4, count - 1), t = b > a ? (j - a) / (b - a) : 0;
        return s.reach * ((1 - t) * rooms.get(a)! + t * rooms.get(b)!) / 3;
      });
      for (let pass = 0; pass < (closed[k] ? 2 : 1); pass++) {
        for (let j = 1; j < count; j++) reach[j] = Math.min(reach[j]!, reach[j - 1]! + out[j]!.length * 0.5);
        for (let j = count - 2; j >= 0; j--) reach[j] = Math.min(reach[j]!, reach[j + 1]! + out[j]!.length * 0.5);
        if (closed[k]) { reach[0] = reach[count - 1] = Math.min(reach[0]!, reach[count - 1]!); }
      }
      out.forEach((s, j) => { s.reach = reach[j]!; });
      return out;
    });
    // Rows of M (area change of hex g per unit offset of each hex), by the length of
    // coast each point stands for in the hex it lies in.
    const matrix = new Map<number, Map<number, number>>();
    current.forEach((ring, k) => samples[k]!.forEach((s, j) => {
      if (!s.reach || (closed[k] && j === ring.length - 1)) return;
      const g = index.get(nearestHex(ring[j]!, cols, rows, size, centres));
      if (g === undefined) return;
      let row = matrix.get(g);
      if (!row) { row = new Map(); matrix.set(g, row); }
      for (const [h, w] of s.weights) {
        const i = index.get(h);
        if (i !== undefined) row.set(i, (row.get(i) ?? 0) + w * s.length);
      }
    }));
    // Least squares with a small penalty on the amounts, by conjugate gradients on the
    // normal equations. Almost every row is its own hex's length of coast, so a few
    // iterations settle it.
    phase('solve');
    const matrixRows = [...matrix].map(([g, row]) => ({ g, indices: Int32Array.from(row.keys()), values: Float64Array.from(row.values()) }));
    const unknowns = hexes.length;
    const forward = new Float64Array(unknowns), transpose = new Float64Array(unknowns);
    const times = (x: Float64Array) => {
      forward.fill(0);
      for (const { g, indices, values } of matrixRows) {
        let sum = 0;
        for (let k = 0; k < indices.length; k++) sum += values[k]! * x[indices[k]!]!;
        forward[g] = sum;
      }
      return forward;
    };
    const timesT = (y: Float64Array) => {
      transpose.fill(0);
      for (const { g, indices, values } of matrixRows) for (let k = 0; k < indices.length; k++) {
        transpose[indices[k]!] = transpose[indices[k]!]! + values[k]! * y[g]!;
      }
      return transpose;
    };
    const lambda = (size * 0.15) ** 2, mu = (size * 0.15) ** 2;
    const rhs = Float64Array.from(timesT(Float64Array.from(hexes, h => short.get(h)!)));
    const x = new Float64Array(unknowns);
    const r = Float64Array.from(rhs), dir = Float64Array.from(r);
    let rr = r.reduce((sum, v) => sum + v * v, 0);
    for (let iteration = 0; iteration < 60 && rr > 1e-12; iteration++) {
      profileCount('fit.solverIterations');
      const q = timesT(times(dir));
      for (let j = 0; j < unknowns; j++) q[j] = q[j]! + lambda * dir[j]!;
      for (const [i, j] of pairs) {
        const delta = mu * (dir[i]! - dir[j]!);
        q[i] = q[i]! + delta; q[j] = q[j]! - delta;
      }
      const alpha = rr / (dir.reduce((sum, v, j) => sum + v * q[j]!, 0) || 1);
      for (let j = 0; j < unknowns; j++) { x[j] = x[j]! + alpha * dir[j]!; r[j] = r[j]! - alpha * q[j]!; }
      const next = r.reduce((sum, v) => sum + v * v, 0);
      if (next < rr * 1e-8) break;
      for (let j = 0; j < unknowns; j++) dir[j] = r[j]! + (next / rr) * dir[j]!;
      rr = next;
    }
    // No round moves a hex's coast by more than a quarter of a hex.
    for (let i = 0; i < unknowns; i++) x[i] = Math.max(-size * 0.25, Math.min(size * 0.25, x[i]!));
    // Each hex's share of its amount; a spot the step would kink or make cross another
    // coast halves the amounts of the hexes moving it, and only theirs, until it is clean.
    const factor = new Float64Array(unknowns).fill(1);
    const moveBy = () => current.map((ring, k) => {
      if (ring.length < 3) return ring;
      const moved = ring.map((p, j) => {
        const s = samples[k]![j]!;
        if (!s.reach) return p;
        let d = 0;
        for (const [h, w] of s.weights) {
          const i = index.get(h);
          if (i !== undefined) d += w * x[i]! * factor[i]!;
        }
        d = Math.max(-s.reach, Math.min(s.reach, d));
        return { x: p.x + s.n.x * d, y: p.y + s.n.y * d };
      });
      // Keep closed rings closed on their first point.
      if (closed[k]) moved[moved.length - 1] = moved[0]!;
      return moved;
    });
    phase('moveAndCheck');
    let next: Point[][] | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      profileCount('fit.trials');
      const trial = moveBy();
      const faults = [...distorts(referenceRings, trial, size * 0.2), ...distorts(current, trial, size * 0.2),
        ...newCrossings(current, trial, closed, size)];
      if (!faults.length) { next = trial; break; }
      const hit = new Set<number>();
      for (const p of faults) for (const [h] of weights(p)) { const i = index.get(h); if (i !== undefined) hit.add(i); }
      for (const i of hit) factor[i] = attempt < 4 ? factor[i]! * 0.5 : 0;
    }
    if (!next) break;
    phase('measureAndAccept');
    const measured = profileTime('fit.measure', () => measureAll(next!, touched));
    // Accept the round only if it brought the targets nearer overall.
    if (error(measured) >= error(shown)) break;
    current = next;
    shown = measured;
  }
  phase('anchors');
  const paths = pathsOf(current);
  const all = paths.flatMap(d => pathPolylines(d, 8));
  const result = { ...geometry, paths, anchors: new Map([...geometry.anchors].map(([key, p]) => [key, nearestOn(p, all).at])) };
  phase();
  return result;
}

/**
 * Where moving `before` to `after` stretches a stretch of coast to more than twice its
 * length or turns it by more than about 50 degrees: what a field too steep for the
 * detail it carries does, drawing a small cape out into a spike. Stretches are at least
 * `span` long, so the roughening's smallest teeth, which any movement turns, do not count.
 */
function distorts(before: Point[][], after: Point[][], span: number): Point[] {
  const faults: Point[] = [];
  for (let k = 0; k < before.length; k++) {
    const a = before[k]!, b = after[k]!;
    let e = 0, arc = 0;
    for (let j = 0; j < a.length; j += 2) {
      if (e < j) { e = j; arc = 0; }
      while (e + 1 < a.length && arc < span) { arc += Math.hypot(a[e + 1]!.x - a[e]!.x, a[e + 1]!.y - a[e]!.y); e++; }
      if (arc < span) break;
      const ux = a[e]!.x - a[j]!.x, uy = a[e]!.y - a[j]!.y, vx = b[e]!.x - b[j]!.x, vy = b[e]!.y - b[j]!.y;
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      arc -= Math.hypot(a[j + 1]!.x - a[j]!.x, a[j + 1]!.y - a[j]!.y) + (j + 2 < a.length ? Math.hypot(a[j + 2]!.x - a[j + 1]!.x, a[j + 2]!.y - a[j + 1]!.y) : 0);
      if (lu < span * 0.25) continue;
      if (lv > lu * 2 || (ux * vx + uy * vy) < lu * lv * 0.64) faults.push(a[j]!, a[e]!);
    }
  }
  return faults;
}

/**
 * Where moving `before` to `after` makes a segment cross another that it did not cross
 * before (adjacent segments of one ring aside). Crossings the outline already had, where
 * chains meet, are not the step's doing.
 */
function newCrossings(before: Point[][], after: Point[][], closed: boolean[], size: number): Point[] {
  const faults: Point[] = [];
  const cell = size / 2;
  const grid = new Map<string, Array<[number, number]>>();
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const crosses = (rs: Point[][], k: number, j: number, m: number, i: number) => {
    const a = rs[k]![j]!, b = rs[k]![j + 1]!, c = rs[m]![i]!, d = rs[m]![i + 1]!;
    return cross(a, b, c) * cross(a, b, d) < -1e-8 && cross(c, d, a) * cross(c, d, b) < -1e-8;
  };
  const moved = (k: number, j: number) => {
    const p = before[k]![j]!, q = after[k]![j]!, r = before[k]![j + 1]!, t = after[k]![j + 1]!;
    return p.x !== q.x || p.y !== q.y || r.x !== t.x || r.y !== t.y;
  };
  for (let k = 0; k < after.length; k++) {
    const ring = after[k]!;
    for (let j = 0; j + 1 < ring.length; j++) {
      const a = ring[j]!, b = ring[j + 1]!;
      const x0 = Math.floor(Math.min(a.x, b.x) / cell), x1 = Math.floor(Math.max(a.x, b.x) / cell);
      const y0 = Math.floor(Math.min(a.y, b.y) / cell), y1 = Math.floor(Math.max(a.y, b.y) / cell);
      const mine = moved(k, j);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`;
        const list = grid.get(key) ?? [];
        for (const [m, i] of list) {
          if (m === k && (Math.abs(i - j) <= 1 || (closed[k] && Math.abs(i - j) >= ring.length - 2))) continue;
          if (!mine && !moved(m, i)) continue;
          if (crosses(after, k, j, m, i) && !crosses(before, k, j, m, i)) faults.push(before[k]![j]!, before[m]![i]!);
        }
        list.push([k, j]);
        grid.set(key, list);
      }
    }
  }
  return faults;
}
