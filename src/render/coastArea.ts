import { roundLoopJoins } from './coastCorners.js';
import { profileCount, profilePhases, profileTime } from './profile.js';
/** Fit every hex's share on the final coastline (see `fitCoastAreas`). */
import { hexCenter, hexCorners, type Point } from '../../shared/hex.js';
import { LAND_SHARE_TOLERANCE } from '../../shared/surfaceArea.js';
import { coastClearance, detailKey } from './componentCoast.js';
import { drawnLand, drawnLandLayout, evenOddTest, type CoastChain, type CoastGeometry } from './coast.js';
import { areaCoverage, nearestHex } from './footprint.js';
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
 * Fit every hex's share at once on the final outline. The coast moves along its own
 * normal (positive pushes it out to sea, adding land) by a smooth field along each coast:
 * control points every half hex of coast by distance, unrelated to where hex edges fall,
 * eased between by a cubic B-spline. The coast keeps its shape and is not cut into even
 * blocks hex by hex. To first order a hex's area changes by the field integrated along
 * its coast, so the smallest smooth field that brings every hex to its share solves one
 * sparse least-squares system; the outline is then measured exactly and the system solved
 * again for what remains.
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
  passageHexes: Iterable<number> = [], rounds = 4, repairEdges = false): CoastGeometry {
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
  // Detail held back from the paths (see `Roughness.deferDetail`) belongs to points, which
  // the fit moves but keeps in order: carry each point's offset along, filling in points
  // the loop repairs added from those beside them.
  const held = geometry.detail ? current.map(ring => {
    const offsets = ring.map(p => geometry.detail!.get(detailKey(p)) ?? NaN);
    offsets.forEach((v, j) => {
      if (!Number.isNaN(v)) return;
      let a = j - 1, b = j + 1;
      while (a >= 0 && Number.isNaN(offsets[a]!)) a--;
      while (b < offsets.length && Number.isNaN(offsets[b]!)) b++;
      offsets[j] = a < 0 || b >= offsets.length ? 0 : offsets[a]! + (offsets[b]! - offsets[a]!) * (j - a) / (b - a);
    });
    return offsets;
  }) : null;
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
  const initial = profileTime('fit.measure', () => measureAll(current, touched));
  const want = new Map([...touched].map(h => [h, targets.get(h)?.share ?? initial.get(h)!]));
  // A share within the tolerance is as good as exact, so a hex is only pulled back to the
  // near edge of its band (kept a little inside it, for the detail added later), and a hex
  // inside its band is left alone: the coast moves no more than the shares need.
  const band = LAND_SHARE_TOLERANCE * 0.4;
  const outside = (h: number, m: Map<number, number>) => {
    const miss = want.get(h)! - m.get(h)!;
    return Math.sign(miss) * Math.max(0, Math.abs(miss) - band);
  };
  const error = (m: Map<number, number>) => [...targets.keys()].reduce((s, h) => s + outside(h, m) ** 2, 0)
    + [...touched].filter(h => !targets.has(h)).reduce((s, h) => s + 0.25 * outside(h, m) ** 2, 0);
  let shown = initial;
  // Bound the total deformation, not just each accepted step.
  const referenceRings = current;
  // Fixed page endpoints make edge shares converge more slowly. After the normal
  // fit, only boundary shares still outside tolerance request a correction; all
  // other hexes constrain it to preserve their areas. Stop as soon as those shares fit.
  const atEdge = (h: number) => h % cols === 0 || h % cols === cols - 1
    || Math.floor(h / cols) === 0 || Math.floor(h / cols) === rows - 1;
  for (let round = 0; round < rounds + (repairEdges ? 4 : 0); round++) {
    phase('field');
    profileCount('fit.rounds');
    const final = round >= rounds;
    const short = new Map([...touched].map(h => [h,
      final && (!targets.has(h) || !atEdge(h) || Math.abs(want.get(h)! - shown.get(h)!) <= LAND_SHARE_TOLERANCE)
        ? 0 : outside(h, shown) * hexArea]));
    // Done once every hex with a share is inside its band.
    if (Math.max(...[...targets.keys()].map(h => Math.abs(short.get(h)!))) <= 0.002 * hexArea) break;
    // Every point's direction to the sea (each ring's orientation found by probing which
    // side is land), averaged over a short stretch so the roughening's small teeth do not
    // turn it; how far it may move; and the length of coast it stands for.
    const land = evenOddTest(landRings(current), size / 8);
    const chains: CoastChain[] = current.map((ring, k) => ({ closed: closed[k]!, points: ring,
      edges: ring.slice(0, -1).map((p, j) => ({ from: p, to: ring[j + 1]!, land: -1, water: -1 })) }));
    const clearance = coastClearance(chains, size);
    type Sample = { n: Point; reach: number; length: number };
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
        out.push({ n: { x: nx / nl, y: ny / nl }, reach: ends * passageFade(p), length: (before + after) / 2 });
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
    // The correction is a smooth field along each coast, not one amount per hex: control
    // points every half hex of coast by distance, unrelated to where hex edges fall, eased
    // between by a cubic B-spline. Each point's place on its coast picks its four controls.
    const spacing = size * 0.5;
    const controls: Array<{ base: number; count: number; closed: boolean }> = [];
    let unknowns = 0;
    const support = current.map((ring, k) => {
      const count = ring.length;
      if (count < 3) { controls.push({ base: unknowns, count: 0, closed: closed[k]! }); return []; }
      const arcs = [0];
      for (let j = 1; j < count; j++) arcs.push(arcs[j - 1]! + Math.hypot(ring[j]!.x - ring[j - 1]!.x, ring[j]!.y - ring[j - 1]!.y));
      const total = arcs[count - 1]! || 1;
      const m = closed[k] ? Math.max(4, Math.round(total / spacing)) : Math.max(4, Math.round(total / spacing) + 3);
      controls.push({ base: unknowns, count: m, closed: closed[k]! });
      const base = unknowns;
      unknowns += m;
      return arcs.map(a => {
        // Uniform cubic B-spline: an open coast's controls run one past each end.
        const t = closed[k] ? (a / total) * m : (a / total) * (m - 3);
        const cell = Math.min(Math.floor(t), closed[k] ? m - 1 : m - 4), u = t - cell;
        const w = [(1 - u) ** 3 / 6, (3 * u ** 3 - 6 * u * u + 4) / 6, (-3 * u ** 3 + 3 * u * u + 3 * u + 1) / 6, u ** 3 / 6];
        return w.map((weight, q): [number, number] => [base + (closed[k] ? (cell + q - 1 + m) % m : cell + q), weight]);
      });
    });
    // Rows of M (area change of hex g per unit of each control), by the length of coast
    // each point stands for in the hex it lies in.
    const matrix = new Map<number, Map<number, number>>();
    current.forEach((ring, k) => samples[k]!.forEach((s, j) => {
      if (!s.reach || (closed[k] && j === ring.length - 1)) return;
      const g = index.get(nearestHex(ring[j]!, cols, rows, size, centres));
      if (g === undefined) return;
      let row = matrix.get(g);
      if (!row) { row = new Map(); matrix.set(g, row); }
      for (const [i, w] of support[k]![j]!) row.set(i, (row.get(i) ?? 0) + w * s.length);
    }));
    // Least squares with a small penalty on the controls and a larger one on how sharply
    // they bend, by conjugate gradients on the normal equations: the smallest smooth
    // correction that brings every hex to its share.
    phase('solve');
    // Match the acceptance error: incidental hexes have a quarter of a target's
    // squared-error weight, so both their matrix row and right-hand side are halved.
    const matrixRows = [...matrix].map(([g, row]) => ({ g, indices: Int32Array.from(row.keys()),
      values: Float64Array.from(row.values(), v => v * (targets.has(hexes[g]!) ? 1 : 0.5)) }));
    const forward = new Float64Array(hexes.length), transpose = new Float64Array(unknowns);
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
    // A weak bend penalty lets the extra controls undo a lake's concentration while
    // reaching its total area. Keep the correction broad enough to retain that shape.
    const lambda = (size * 0.05) ** 2, mu = size ** 2;
    // Scale the residual by the system's diagonal and stop relative to the original
    // residual, rather than requiring each iteration to improve by eight orders.
    const bends: Array<[number, number, number]> = [];
    const diagonal = new Float64Array(unknowns).fill(lambda);
    for (const { indices, values } of matrixRows) for (let j = 0; j < indices.length; j++) {
      diagonal[indices[j]!] = diagonal[indices[j]!]! + values[j]! ** 2;
    }
    for (const { base, count, closed: loop } of controls) for (let c = loop ? 0 : 1; c < (loop ? count : count - 1); c++) {
      const a = base + (c - 1 + count) % count, b = base + c, d = base + (c + 1) % count;
      bends.push([a, b, d]);
      diagonal[a] = diagonal[a]! + mu; diagonal[b] = diagonal[b]! + 4 * mu; diagonal[d] = diagonal[d]! + mu;
    }
    const rhs = Float64Array.from(timesT(Float64Array.from(hexes, h => short.get(h)! * (targets.has(h) ? 1 : 0.5))));
    const x = new Float64Array(unknowns);
    const r = Float64Array.from(rhs), dir = Float64Array.from(r, (v, j) => v / diagonal[j]!);
    let rz = r.reduce((sum, v, j) => sum + v * dir[j]!, 0);
    const tolerance = r.reduce((sum, v) => sum + v * v, 0) * 1e-8;
    for (let iteration = 0; iteration < 80 && rz > 1e-12; iteration++) {
      profileCount('fit.solverIterations');
      const q = timesT(times(dir));
      for (let j = 0; j < unknowns; j++) q[j] = q[j]! + lambda * dir[j]!;
      for (const [a, b, d] of bends) {
        const second = mu * (dir[a]! - 2 * dir[b]! + dir[d]!);
        q[a] = q[a]! + second; q[b] = q[b]! - 2 * second; q[d] = q[d]! + second;
      }
      const alpha = rz / (dir.reduce((sum, v, j) => sum + v * q[j]!, 0) || 1);
      let residual = 0, next = 0;
      for (let j = 0; j < unknowns; j++) {
        x[j] = x[j]! + alpha * dir[j]!; r[j] = r[j]! - alpha * q[j]!;
        residual += r[j]! ** 2; next += r[j]! ** 2 / diagonal[j]!;
      }
      if (residual <= tolerance) break;
      for (let j = 0; j < unknowns; j++) dir[j] = r[j]! / diagonal[j]! + (next / rz) * dir[j]!;
      rz = next;
    }
    // No round moves the coast by more than a quarter of a hex.
    for (let i = 0; i < unknowns; i++) x[i] = Math.max(-size * 0.25, Math.min(size * 0.25, x[i]!));
    // Each control's share of its amount; a spot the step would kink or make cross another
    // coast halves the controls moving it, and only those, until it is clean.
    const factor = new Float64Array(unknowns).fill(1);
    const moveBy = () => current.map((ring, k) => {
      if (ring.length < 3) return ring;
      const moved = ring.map((p, j) => {
        const s = samples[k]![j]!;
        if (!s.reach) return p;
        let d = 0;
        for (const [i, w] of support[k]![j]!) d += w * x[i]! * factor[i]!;
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
      // A control shared by several faulty points is halved once, not once per point.
      const hit = new Set<number>();
      for (const [k, j] of faults) for (const [i] of support[k]?.[j] ?? []) hit.add(i);
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
  const detail = held ? new Map(current.flatMap((ring, k) => ring.map((p, j): [string, number] => [detailKey(p), held[k]![j]!]))) : undefined;
  const result = { ...geometry, paths, detail, anchors: snapAnchors(geometry.anchors, paths, size) };
  phase();
  return result;
}

/**
 * Where (ring, point) moving `before` to `after` stretches a stretch of coast to more than twice its
 * length or turns it by more than about 50 degrees: what a field too steep for the
 * detail it carries does, drawing a small cape out into a spike. Stretches are at least
 * `span` long, so the roughening's smallest teeth, which any movement turns, do not count.
 */
function distorts(before: Point[][], after: Point[][], span: number): Array<[number, number]> {
  const faults: Array<[number, number]> = [];
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
      if (lv > lu * 2 || (ux * vx + uy * vy) < lu * lv * 0.64) faults.push([k, j], [k, e]);
    }
  }
  return faults;
}

/**
 * Where (ring, point) moving `before` to `after` makes a segment cross another that it did not cross
 * before (adjacent segments of one ring aside). Crossings the outline already had, where
 * chains meet, are not the step's doing.
 */
function newCrossings(before: Point[][], after: Point[][], closed: boolean[], size: number): Array<[number, number]> {
  const faults: Array<[number, number]> = [];
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
          if (crosses(after, k, j, m, i) && !crosses(before, k, j, m, i)) faults.push([k, j], [m, i]);
        }
        list.push([k, j]);
        grid.set(key, list);
      }
    }
  }
  return faults;
}

/**
 * Each anchor moved to the nearest point of the coast as drawn (`paths`), found from a grid
 * of the coast's segments so only those nearby are checked.
 */
function snapAnchors(anchors: Map<string, Point>, paths: PathCmd[][], size: number): Map<string, Point> {
  const lines = paths.flatMap(d => pathPolylines(d, 8));
  const grid = new Map<number, Array<[Point, Point]>>();
  const key = (x: number, y: number) => x * 65536 + y;
  for (const line of lines) for (let j = 0; j + 1 < line.length; j++) {
    const a = line[j]!, b = line[j + 1]!;
    for (let x = Math.floor(Math.min(a.x, b.x) / size); x <= Math.floor(Math.max(a.x, b.x) / size); x++)
      for (let y = Math.floor(Math.min(a.y, b.y) / size); y <= Math.floor(Math.max(a.y, b.y) / size); y++) {
        const cell = grid.get(key(x, y));
        if (cell) cell.push([a, b]); else grid.set(key(x, y), [[a, b]]);
      }
  }
  const nearest = (p: Point): Point => {
    const cx = Math.floor(p.x / size), cy = Math.floor(p.y / size);
    let best = Infinity, at = p;
    // Ring by ring outwards; a ring further out than the best distance found cannot hold a nearer segment.
    for (let r = 0; r < 64 && (r - 1) * size < best; r++) {
      for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
        for (const [a, b] of grid.get(key(x, y)) ?? []) {
          const ex = b.x - a.x, ey = b.y - a.y;
          const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / (ex * ex + ey * ey || 1)));
          const q = { x: a.x + ex * t, y: a.y + ey * t }, d = Math.hypot(p.x - q.x, p.y - q.y);
          if (d < best) { best = d; at = q; }
        }
      }
    }
    return at;
  };
  return new Map([...anchors].map(([id, p]) => [id, nearest(p)]));
}

/**
 * Put the held-back detail back on every path: each point moves its recorded offset along
 * the coast's normal there (land on the right, as the offset was found). Points with none
 * recorded (a coast's run to the map's edge, say) stay where they are. The final spline
 * fit absorbs the area change without levelling the detail against individual hexes.
 */
export function applyCoastDetail(geometry: CoastGeometry, size: number): CoastGeometry {
  const detail = geometry.detail;
  if (!detail?.size) return geometry;
  const rings = geometry.paths.map(d => pathPolylines(d, 8)[0] ?? []);
  const paths = geometry.paths.map((d, k) => {
    const ring = rings[k]!;
    if (ring.length < 3) return d;
    const closed = geometry.chains[k]?.closed ?? false;
    const n = ring.length, last = closed && ring[0]!.x === ring[n - 1]!.x && ring[0]!.y === ring[n - 1]!.y ? n - 1 : n;
    const at = (j: number) => ring[closed ? (j + last) % last : Math.max(0, Math.min(n - 1, j))]!;
    const moved = ring.map((p, j) => {
      const offset = j < last ? detail.get(detailKey(p)) ?? 0 : 0;
      if (!offset) return p;
      const a = at(j - 1), b = at(j + 1), dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy) || 1;
      return { x: p.x - dy / length * offset, y: p.y + dx / length * offset };
    });
    if (last < n) moved[n - 1] = moved[0]!;
    const out: PathCmd[] = moved.map((p, j) => [j ? 'L' : 'M', p.x, p.y]);
    if (closed) out.push(['Z']);
    return out;
  });
  return { ...geometry, paths, detail: undefined, anchors: snapAnchors(geometry.anchors, paths, size) };
}
