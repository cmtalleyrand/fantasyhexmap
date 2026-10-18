import { profileCount, profilePhases, profileTime } from './profile.js';
/** Fit every hex's share on the final coastline (see `fitCoastAreas`). */
import { hexCenter, hexCorners, type Point } from '../../shared/hex.js';
import { coastClearance } from './componentCoast.js';
import { drawnLand, drawnLandLayout, evenOddTest, type CoastChain, type CoastGeometry } from './coast.js';
import { areaCoverage, nearestHex, nearestOn } from './footprint.js';
import { pathPolylines } from './ice.js';
import type { PathCmd } from './prims.js';

/** Remove small fold-back loops already introduced by roughening tight caps. */
function untangle(ring: Point[]): Point[] {
  const area = (points: Point[]) => Math.abs(points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length]!;
    return sum + p.x * q.y - q.x * p.y;
  }, 0));
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  let points = ring.slice(0, -1);
  for (let pass = 0; pass < 32; pass++) {
    const n = points.length;
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
    for (let k = 0; k < n; k++) cellsOf(k, c => { const list = grid.get(c); if (list) list.push(k); else grid.set(c, [k]); });
    let hit: { i: number; j: number } | null = null;
    for (let i = 0; i < n && !hit; i++) {
      const a = points[i]!, b = points[(i + 1) % n]!;
      let best = Infinity;
      cellsOf(i, c => {
        for (const j of grid.get(c)!) {
          if (j < i + 2 || j >= best || (i === 0 && j === n - 1)) continue;
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
    const outer = [...points.slice(0, i + 1), intersection, ...points.slice(j + 1)];
    const loop = [intersection, ...points.slice(i + 1, j + 1)];
    points = area(outer) >= area(loop) ? outer : loop;
  }
  return [...points, points[0]!];
}

/**
 * Fit every hex's share at once on the final outline. The coast is moved along its
 * normal by a smooth field: each hex has one amount (positive pushes the coast out to
 * sea, adding land), spread over the plane by weights that fall off from the hex's
 * centre and sum to one, so the coast moves continuously across hex edges instead of
 * being held still at them. To first order a hex's area changes by the field integrated
 * along the coast inside it, so the amounts that bring every hex to its share solve one
 * small linear system, whose coupling is exactly the land neighbouring hexes trade. The
 * outline is then measured exactly and the system solved again for what remains.
 *
 * `targets` are the hexes with a share to reach; every other hex the coast runs through
 * keeps the land it had. Movement is held well inside the clearance to other coasts (a
 * strait is never closed, two coasts never meet), fades out at the map's edge and, for a
 * passage of set width, near the passage's middle; a step that would make the outline
 * cross itself is shortened. A hex whose share cannot be reached within those limits is
 * left as near as they allow, for the caller to report.
 */
export function fitCoastAreas(geometry: CoastGeometry, targets: ReadonlyMap<number, { share: number; width?: number }>,
  cols: number, rows: number, size: number, page: { width: number; height: number }, ink: number,
  /** Every strait and isthmus drawn at a set width, whether or not its share is fitted. */
  passageHexes: Iterable<number> = [],
  /** A seeded value in [0, 1) for each hex and key, so the fit differs between hexes and maps. */
  noise: (hex: number, key: number) => number = () => 0.5, rounds = 8): CoastGeometry {
  if (!geometry.component || !targets.size) return geometry;
  const phase = profilePhases('fit');
  phase('prepare');
  const hexArea = 1.5 * Math.sqrt(3) * size * size;
  const closed = geometry.chains.map(c => c.closed);
  let rings = geometry.paths.map((d, k) => {
    const ring = pathPolylines(d, 8)[0] ?? [];
    if (!closed[k] || ring.length < 4) return ring;
    return untangle(ring);
  });
  const pathsOf = (rs: Point[][]): PathCmd[][] => rs.map((ring, k) => {
    if (!ring.length) return geometry.paths[k]!;
    const d: PathCmd[] = ring.map((p, j) => [j === 0 ? 'M' : 'L', p.x, p.y]);
    if (closed[k]) d.push(['Z']);
    return d;
  });
  const geometryOf = (rs: Point[][]): CoastGeometry => ({ ...geometry, paths: pathsOf(rs) });
  // Fixed for the duration of a solve. Moving point-dependent inputs stay separate.
  const centres = Array.from({ length: cols * rows }, (_, h) => hexCenter(h % cols, Math.floor(h / cols), size));
  const centreOf = (h: number) => centres[h]!;
  const corners = new Map<number, Point[]>();
  const cornersOf = (h: number) => {
    let hit = corners.get(h);
    if (!hit) { hit = hexCorners(h % cols, Math.floor(h / cols), size); corners.set(h, hit); }
    return hit;
  };
  // Open ends never move: the field fades to zero there. Reuse the page-edge joins,
  // then supply the evolving polylines directly, including the original Z closure.
  const layout = drawnLandLayout(geometryOf(rings), page.width, page.height, size);
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
  const sigma = size * 0.6;
  /** Each hex near `p`, with its weight in the field there. */
  const weights = (p: Point): Array<[number, number]> => {
    const home = nearestHex(p, cols, rows, size, centres), hc = home % cols, hr = Math.floor(home / cols);
    const out: Array<[number, number]> = [];
    let total = 0;
    for (let r = hr - 2; r <= hr + 2; r++) for (let c = hc - 2; c <= hc + 2; c++) {
      if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
      const h = r * cols + c, q = centreOf(h), d2 = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d2 > (size * 1.8) ** 2) continue;
      const w = Math.exp(-d2 / (2 * sigma * sigma));
      out.push([h, w]);
      total += w;
    }
    const result: Array<[number, number]> = out.map(([h, w]) => [h, w / total]);
    return result;
  };
  // A strait or isthmus keeps its shape, which outranks its share: no movement through
  // the passage's hex or across its joins to the land beside it (its share was fitted
  // when its banks were shaped), easing in beyond them.
  const passages = [...new Set([...passageHexes, ...[...targets].filter(([, t]) => t.width !== undefined).map(([h]) => h)])].map(centreOf);
  const passageFade = (p: Point) => {
    const fade = passages.reduce((f, c) => Math.min(f, Math.max(0, Math.min(1, (Math.hypot(p.x - c.x, p.y - c.y) - size * 1.05) / (size * 0.4)))), 1);
    return fade;
  };
  const measureAll = (rs: Point[][], hexes: Iterable<number>) => {
    profileCount('fit.measurements');
    const coverage = areaCoverage(landRings(rs),
      { evenOdd: true, stroke: { rings: strokeRings(rs), reach: ink }, reuseScanlines: true });
    const out = new Map<number, number>();
    for (const h of hexes) { profileCount('fit.hexMeasurements'); out.set(h, coverage(cornersOf(h), 128) / hexArea); }
    return out;
  };
  function skewAlongShore(rs: Point[][]): Point[][] {
    const land = evenOddTest(landRings(rs), size / 8);
    const along = new Map<number, Point>();
    rs.forEach(ring => {
      if (ring.length < 3) return;
      let votes = 0;
      const step = Math.max(1, Math.floor(ring.length / 24));
      for (let j = 0; j + 1 < ring.length; j += step) {
        const a = ring[j]!, b = ring[j + 1]!, length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        votes += land({ x: (a.x + b.x) / 2 + (b.y - a.y) / length * size * 0.08, y: (a.y + b.y) / 2 - (b.x - a.x) / length * size * 0.08 }) ? -1 : 1;
      }
      const sign = votes >= 0 ? 1 : -1;
      for (let j = 0; j + 1 < ring.length; j++) {
        const a = ring[j]!, b = ring[j + 1]!, length = Math.hypot(b.x - a.x, b.y - a.y);
        if (!length) continue;
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        // The direction along the shore, oriented the same way round every ring (land on one side).
        for (const [h, w] of weights(m)) {
          const t = along.get(h) ?? { x: 0, y: 0 };
          along.set(h, { x: t.x + sign * (b.x - a.x) * w, y: t.y + sign * (b.y - a.y) * w });
        }
      }
    });
    const slide = new Map<number, Point>();
    for (const [h, t] of along) {
      const length = Math.hypot(t.x, t.y);
      if (length < size * 0.15) continue;
      const amount = (noise(h, 3) - 0.5) * size * 0.9;
      slide.set(h, { x: t.x / length * amount, y: t.y / length * amount });
    }
    const moveBy = (scale: number) => rs.map((ring, k) => {
      if (ring.length < 3) return ring;
      let arc = 0, total = 0;
      for (let j = 0; j + 1 < ring.length; j++) total += Math.hypot(ring[j + 1]!.x - ring[j]!.x, ring[j + 1]!.y - ring[j]!.y);
      return ring.map((p, j) => {
        if (j) arc += Math.hypot(p.x - ring[j - 1]!.x, p.y - ring[j - 1]!.y);
        const fade = (closed[k] ? 1 : Math.min(1, arc / size, (total - arc) / size)) * passageFade(p) * scale;
        if (!fade) return p;
        let dx = 0, dy = 0;
        for (const [h, w] of weights(p)) {
          const v = slide.get(h);
          if (v) { dx += v.x * w; dy += v.y * w; }
        }
        return { x: p.x + dx * fade, y: p.y + dy * fade };
      });
    });
    for (const scale of [1, 0.5, 0.25]) {
      const trial = moveBy(scale).map((ring, k) => closed[k] && ring.length ? [...ring.slice(0, -1), ring[0]!] : ring);
      if (!distorts(rs, trial) && !newCrossings(rs, trial, closed, size)) return trial;
    }
    return rs;
  }
  // Every hex the coast runs through takes part: those with a share aim at it, the rest keep theirs.
  const touched = new Set<number>();
  for (const ring of rings) for (const p of ring) touched.add(nearestHex(p, cols, rows, size, centres));
  for (const h of targets.keys()) touched.add(h);
  // Along a coast running across the grid, every other hex stands half a hex further out,
  // and each hex keeping its share makes the coast bulge out through each of those: a row
  // of bulges, each a mirror image of itself. Slide each hex's stretch of coast along the
  // shore by a seeded amount first (which moves little land), so each bulge leans its own
  // way with one flank steeper than the other; the fit below then restores every share.
  const hexes = [...touched];
  const index = new Map(hexes.map((h, i) => [h, i]));
  const neighbours: Array<[number, number]> = [];
  hexes.forEach((h, i) => {
    const c = centreOf(h), hc = h % cols, hr = Math.floor(h / cols);
    const nearby: number[] = [];
    for (let r = Math.max(0, hr - 2); r <= Math.min(rows - 1, hr + 2); r++) {
      for (let col = Math.max(0, hc - 2); col <= Math.min(cols - 1, hc + 2); col++) {
        const k = r * cols + col, j = index.get(k);
        if (j === undefined || j <= i) continue;
        const q = centreOf(k);
        if (Math.hypot(c.x - q.x, c.y - q.y) <= size * 1.9) nearby.push(j);
      }
    }
    // Preserve the old matrix accumulation order, which followed touched insertion order.
    nearby.sort((a, b) => a - b);
    for (const j of nearby) neighbours.push([i, j]);
  });
  const swellCentres = new Map<number, Point>();
  const forward = new Float64Array(hexes.length), transpose = new Float64Array(hexes.length * 2);
  rings = skewAlongShore(rings);
  const initial = profileTime('fit.measure', () => measureAll(rings, touched));
  const want = new Map([...touched].map(h => [h, targets.get(h)?.share ?? initial.get(h)!]));
  let shown = initial;
  for (let round = 0; round < rounds; round++) {
    phase('field');
    profileCount('fit.rounds');
    const short = new Map([...touched].map(h => [h, (want.get(h)! - shown.get(h)!) * hexArea]));
    if (Math.max(...[...targets.keys()].map(h => Math.abs(short.get(h)!))) < 0.003 * hexArea) break;
    // The direction to the sea along each ring (its orientation found by probing which
    // side is land), and how much room each hex's coast has before it meets another.
    const land = evenOddTest(landRings(rings), size / 8);
    const chains: CoastChain[] = rings.map((ring, k) => ({ closed: closed[k]!, points: ring,
      edges: ring.slice(0, -1).map((p, j) => ({ from: p, to: ring[j + 1]!, land: -1, water: -1 })) }));
    const clearance = coastClearance(chains, size);
    type Segment = { m: Point; n: Point; length: number; hex: number; fade: number; weights: Array<[number, number]> };
    const segments: Segment[] = [];
    const room = new Map<number, number>();
    rings.forEach((ring, k) => {
      if (ring.length < 3) return;
      let votes = 0;
      const step = Math.max(1, Math.floor(ring.length / 24));
      for (let j = 0; j + 1 < ring.length; j += step) {
        const a = ring[j]!, b = ring[j + 1]!, length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const q = { x: (a.x + b.x) / 2 + (b.y - a.y) / length * size * 0.08, y: (a.y + b.y) / 2 - (b.x - a.x) / length * size * 0.08 };
        votes += land(q) ? -1 : 1;
      }
      const sign = votes >= 0 ? 1 : -1;
      let arc = 0, total = 0;
      for (let j = 0; j + 1 < ring.length; j++) total += Math.hypot(ring[j + 1]!.x - ring[j]!.x, ring[j + 1]!.y - ring[j]!.y);
      for (let j = 0; j + 1 < ring.length; j++) {
        const a = ring[j]!, b = ring[j + 1]!, length = Math.hypot(b.x - a.x, b.y - a.y);
        if (!length) continue;
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, hex = nearestHex(m, cols, rows, size, centres);
        const ends = closed[k] ? 1 : Math.min(1, (arc + length / 2) / size, (total - arc - length / 2) / size);
        arc += length;
        segments.push({ m, n: { x: sign * (b.y - a.y) / length, y: -sign * (b.x - a.x) / length }, length, hex, fade: ends * passageFade(m), weights: weights(m) });
        if (j % 4 === 0) room.set(hex, Math.min(room.get(hex) ?? Infinity, clearance(m, chains[k]!, arc)));
      }
    });
    // Two fields per hex: a shift towards its sea (the coast's mean direction to the
    // water there), and a swelling about its centre (which also serves an island or a
    // bay lying wholly in the hex, whose mean direction is nothing).
    const toSea = new Map<number, Point>();
    for (const s of segments) for (const [h, w] of s.weights) {
      const u = toSea.get(h) ?? { x: 0, y: 0 };
      toSea.set(h, { x: u.x + s.n.x * w * s.length, y: u.y + s.n.y * w * s.length });
    }
    for (const [h, u] of toSea) {
      const length = Math.hypot(u.x, u.y);
      toSea.set(h, length > size * 0.15 ? { x: u.x / length, y: u.y / length } : { x: 0, y: 0 });
    }
    // Each hex swells about a point off its middle by a seeded amount: swelling about the
    // middle itself grew every hex's coast into the same bulge, a mirror image of itself.
    const swellCentre = (h: number) => {
      const c = centreOf(h), angle = noise(h, 1) * Math.PI * 2, reach = size * (0.25 + 0.2 * noise(h, 2));
      return { x: c.x + Math.cos(angle) * reach, y: c.y + Math.sin(angle) * reach };
    };
    const basis = (h: number, p: Point, w: number): [Point, Point] => {
      const u = toSea.get(h) ?? { x: 0, y: 0 };
      let c = swellCentres.get(h);
      if (!c) { c = swellCentre(h); swellCentres.set(h, c); }
      return [{ x: w * u.x, y: w * u.y }, { x: w * (p.x - c.x) / size, y: w * (p.y - c.y) / size }];
    };
    // Sparse rows of M (area change of hex g per unit of each field) over unknowns
    // [shift of hex i, swelling of hex i] at 2i and 2i + 1.
    const matrix = new Map<number, Map<number, number>>();
    for (const s of segments) {
      const g = index.get(s.hex);
      if (g === undefined || !s.fade) continue;
      let row = matrix.get(g);
      if (!row) { row = new Map(); matrix.set(g, row); }
      for (const [h, w] of s.weights) {
        const i = index.get(h);
        if (i === undefined) continue;
        const [t, d] = basis(h, s.m, w);
        row.set(2 * i, (row.get(2 * i) ?? 0) + (t.x * s.n.x + t.y * s.n.y) * s.length * s.fade);
        row.set(2 * i + 1, (row.get(2 * i + 1) ?? 0) + (d.x * s.n.x + d.y * s.n.y) * s.length * s.fade);
      }
    }
    // Least squares with a small penalty on the amounts, by conjugate gradients on the
    // normal equations; then each amount is held inside its hex's room.
    phase('solve');
    // Freeze the sparse row order once per round instead of allocating Map iterators
    // for every conjugate-gradient multiplication. Summation order is unchanged.
    const matrixRows = [...matrix].map(([g, row]) => ({ g, indices: Int32Array.from(row.keys()), values: Float64Array.from(row.values()) }));
    const unknowns = hexes.length * 2;
    const times = (x: Float64Array) => {
      const out = forward;
      out.fill(0);
      for (const { g, indices, values } of matrixRows) {
        let sum = 0;
        for (let k = 0; k < indices.length; k++) sum += values[k]! * x[indices[k]!]!;
        out[g] = sum;
      }
      return out;
    };
    const timesT = (y: Float64Array) => {
      const out = transpose;
      out.fill(0);
      for (const { g, indices, values } of matrixRows) for (let k = 0; k < indices.length; k++) {
        const j = indices[k]!;
        out[j] = out[j]! + values[k]! * y[g]!;
      }
      return out;
    };
    // A small penalty on the amounts, and a larger one on how they differ between
    // neighbouring hexes: neighbours pushing opposite ways draw the coast out into spikes.
    const lambda = (size * 0.15) ** 2, mu = (size * 0.2) ** 2;
    const pairs: Array<[number, number, number]> = neighbours.map(([i, j]) => {
      const u = toSea.get(hexes[i]!) ?? { x: 0, y: 0 }, v = toSea.get(hexes[j]!) ?? { x: 0, y: 0 };
      return [i, j, u.x * v.x + u.y * v.y];
    });
    const normal = (x: Float64Array) => {
      const out = timesT(times(x));
      for (let j = 0; j < unknowns; j++) out[j] = out[j]! + lambda * x[j]!;
      for (const [i, j, dot] of pairs) {
        // |a_i u_i - a_j u_j|^2 and (b_i - b_j)^2.
        out[2 * i] = out[2 * i]! + mu * (x[2 * i]! - dot * x[2 * j]!);
        out[2 * j] = out[2 * j]! + mu * (x[2 * j]! - dot * x[2 * i]!);
        out[2 * i + 1] = out[2 * i + 1]! + mu * (x[2 * i + 1]! - x[2 * j + 1]!);
        out[2 * j + 1] = out[2 * j + 1]! + mu * (x[2 * j + 1]! - x[2 * i + 1]!);
      }
      return out;
    };
    const rhs = timesT(Float64Array.from(hexes, h => short.get(h)!));
    const x = new Float64Array(unknowns);
    let r = Float64Array.from(rhs), dir = Float64Array.from(r);
    let rr = r.reduce((sum, v) => sum + v * v, 0);
    for (let iteration = 0; iteration < 200 && rr > 1e-12; iteration++) {
      profileCount('fit.solverIterations');
      const q = normal(dir);
      const alpha = rr / (dir.reduce((sum, v, j) => sum + v * q[j]!, 0) || 1);
      for (let j = 0; j < unknowns; j++) { x[j] = x[j]! + alpha * dir[j]!; r[j] = r[j]! - alpha * q[j]!; }
      const next = r.reduce((sum, v) => sum + v * v, 0);
      if (next < rr * 1e-10) break;
      for (let j = 0; j < unknowns; j++) dir[j] = r[j]! + (next / rr) * dir[j]!;
      rr = next;
    }
    // A field that moves points by more than about a third of its own reach can fold
    // the outline; and no coast may close more than a third of the gap to another.
    // Each round's field is kept gentle (a field moving points by more than about a third
    // of its reach can fold the outline) and moves no coast more than three tenths of the
    // way to the nearest other coast; the crossing check below catches what slips past.
    hexes.forEach((h, i) => {
      const bound = Math.min(sigma * 0.35, (room.get(h) ?? Infinity) * 0.3);
      x[2 * i] = Math.max(-bound, Math.min(bound, x[2 * i]!));
      x[2 * i + 1] = Math.max(-bound, Math.min(bound, x[2 * i + 1]!));
    });
    const moveBy = (scale: number) => rings.map((ring, k) => {
      if (ring.length < 3) return ring;
      let arc = 0, total = 0;
      for (let j = 0; j + 1 < ring.length; j++) total += Math.hypot(ring[j + 1]!.x - ring[j]!.x, ring[j + 1]!.y - ring[j]!.y);
      return ring.map((p, j) => {
        if (j) arc += Math.hypot(p.x - ring[j - 1]!.x, p.y - ring[j - 1]!.y);
        const fade = (closed[k] ? 1 : Math.min(1, arc / size, (total - arc) / size)) * passageFade(p) * scale;
        if (!fade) return p;
        let dx = 0, dy = 0;
        for (const [h, w] of weights(p)) {
          const i = index.get(h);
          if (i === undefined) continue;
          const [t, d] = basis(h, p, w);
          dx += t.x * x[2 * i]! + d.x * x[2 * i + 1]!;
          dy += t.y * x[2 * i]! + d.y * x[2 * i + 1]!;
        }
        return { x: p.x + dx * fade, y: p.y + dy * fade };
      });
    });
    phase('moveAndCheck');
    let next: Point[][] | null = null;
    for (const scale of [1, 0.5, 0.25, 0.125]) {
      profileCount('fit.trials');
      const trial = moveBy(scale);
      if (!distorts(rings, trial) && !newCrossings(rings, trial, closed, size)) { next = trial; break; }
    }
    if (!next) break;
    // Keep closed rings closed on their first point.
    next = next.map((ring, k) => closed[k] && ring.length ? [...ring.slice(0, -1), ring[0]!] : ring);
    phase('measureAndAccept');
    const measured = profileTime('fit.measure', () => measureAll(next!, touched));
    // Accept the round only if it brought the targets nearer overall.
    const error = (m: Map<number, number>) => [...targets.keys()].reduce((s, h) => s + (want.get(h)! - m.get(h)!) ** 2, 0)
      + [...touched].filter(h => !targets.has(h)).reduce((s, h) => s + 0.25 * (want.get(h)! - m.get(h)!) ** 2, 0);
    if (error(measured) >= error(shown)) break;
    rings = next;
    shown = measured;
  }
  phase('anchors');
  const paths = pathsOf(rings);
  const all = paths.flatMap(d => pathPolylines(d, 8));
  const result = { ...geometry, paths, anchors: new Map([...geometry.anchors].map(([key, p]) => [key, nearestOn(p, all).at])) };
  phase();
  return result;
}

/**
 * Whether moving `before` to `after` stretches a stretch of coast to more than twice its
 * length or turns it by more than about 50 degrees: what a field too steep for the
 * detail it carries does, drawing a small cape out into a spike.
 */
function distorts(before: Point[][], after: Point[][]): boolean {
  for (let k = 0; k < before.length; k++) {
    const a = before[k]!, b = after[k]!;
    // Over a few samples, so a single short segment's direction does not decide it.
    for (let j = 0; j + 3 < a.length; j += 2) {
      const ux = a[j + 3]!.x - a[j]!.x, uy = a[j + 3]!.y - a[j]!.y, vx = b[j + 3]!.x - b[j]!.x, vy = b[j + 3]!.y - b[j]!.y;
      const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      if (lu < 1e-6) continue;
      if (lv > lu * 2 || (ux * vx + uy * vy) < lu * lv * 0.64) return true;
    }
  }
  return false;
}

/**
 * Whether moving `before` to `after` makes a segment cross another that it did not cross
 * before (adjacent segments of one ring aside). Crossings the outline already had, where
 * chains meet, are not the step's doing.
 */
function newCrossings(before: Point[][], after: Point[][], closed: boolean[], size: number): boolean {
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
          if (crosses(after, k, j, m, i) && !crosses(before, k, j, m, i)) return true;
        }
        list.push([k, j]);
        grid.set(key, list);
      }
    }
  }
  return false;
}
