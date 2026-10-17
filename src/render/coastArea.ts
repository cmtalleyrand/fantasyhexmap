/** Fit residual local shares on the final silhouette, preserving hex crossings. */
import { hexCenter, hexCorners, type Point } from '../../shared/hex.js';
import { coastClearance } from './componentCoast.js';
import { drawnLand, drawnLandLayout, type CoastChain, type CoastGeometry } from './coast.js';
import { areaCoverage, coverageOf, nearestHex, nearestOn, type CoverageRing } from './footprint.js';
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

export function fitCoastAreas(geometry: CoastGeometry, targets: ReadonlyMap<number, { share: number; width?: number }>,
  cols: number, rows: number, size: number, page: { width: number; height: number }, ink: number): CoastGeometry {
  if (!geometry.component || !targets.size) return geometry;
  const hexArea = 1.5 * Math.sqrt(3) * size * size;
  let result: CoastGeometry = { ...geometry, paths: geometry.paths.map((d, k) => {
    if (!geometry.chains[k]!.closed) return d;
    const ring = pathPolylines(d, 8)[0];
    if (!ring?.length) return d;
    return [...untangle(ring).map((p, j) => [j === 0 ? 'M' : 'L', p.x, p.y] as PathCmd), ['Z'] as PathCmd];
  }) };
  for (let sweep = 0; sweep < 3; sweep++) for (const [hex, target] of targets) {
    const clip = hexCorners(hex % cols, Math.floor(hex / cols), size);
    const centre = hexCenter(hex % cols, Math.floor(hex / cols), size);
    const measure = (g: CoastGeometry) => areaCoverage(pathPolylines(drawnLand(g, page.width, page.height, size), 8),
      { evenOdd: true, stroke: { rings: g.paths.flatMap(d => pathPolylines(d, 8)), reach: ink }, within: clip })(clip, 128) / hexArea;
    let bestError = Math.abs(measure(result) - target.share);
    if (bestError < 0.004) continue;
    const rings = result.paths.map(d => pathPolylines(d, 8)[0] ?? []);
    const chains: CoastChain[] = rings.map((ring, k) => ({ closed: result.chains[k]!.closed,
      points: ring, edges: ring.slice(0, -1).map((p, j) => ({ from: p, to: ring[j + 1]!, land: hex, water: -1 })) }));
    const clearance = coastClearance(chains, size);
    // A point outside the hex's box lies outside the hex, where its depth, and so its
    // move, is nothing: skip finding its nearest hex and clearance.
    const hexBox = [Math.min(...clip.map(p => p.x)), Math.min(...clip.map(p => p.y)), Math.max(...clip.map(p => p.x)), Math.max(...clip.map(p => p.y))];
    const moves = rings.map((ring, k) => ring.map((p, j) => {
      if (p.x < hexBox[0]! || p.x > hexBox[2]! || p.y < hexBox[1]! || p.y > hexBox[3]!) return { x: 0, y: 0 };
      if (nearestHex(p, cols, rows, size) !== hex) return { x: 0, y: 0 };
      let depth = Infinity;
      for (let e = 0; e < 6; e++) {
        const a = clip[e]!, b = clip[(e + 1) % 6]!;
        depth = Math.min(depth, ((p.x - a.x) * (a.y - b.y) + (p.y - a.y) * (b.x - a.x)) / Math.hypot(b.x - a.x, b.y - a.y));
      }
      // Shared crossings stay fixed, so fitting one hex cannot change another's
      // coverage or break a mainland join. Keep an explicit channel's junction.
      let fade = Math.max(0, Math.min(1, depth / (size * 0.2)));
      if (target.width !== undefined) fade *= Math.max(0, Math.min(1, (Math.hypot(p.x - centre.x, p.y - centre.y) - size * 0.3) / (size * 0.2)));
      const last = ring.length - 1;
      if (!result.chains[k]!.closed && (j === 0 || j === last)) fade = 0;
      const previous = ring[j === 0 ? Math.max(0, last - 1) : j - 1]!, next = ring[j === last ? Math.min(1, last) : j + 1]!;
      const dx = next.x - previous.x, dy = next.y - previous.y, length = Math.hypot(dx, dy) || 1;
      const limit = Math.min(size * 0.35, clearance(p, chains[k]!, j * size / 20) * 0.3,
        target.width === undefined ? Infinity : target.width * 0.15);
      if (target.width === undefined) {
        // A positive local scale keeps detailed capes from folding while
        // changing area. Its displacement fades before the hex boundary.
        const scale = Math.min(0.16, limit / (Math.hypot(p.x - centre.x, p.y - centre.y) || 1));
        return { x: (p.x - centre.x) * fade * scale, y: (p.y - centre.y) * fade * scale };
      }
      return { x: dy / length * fade * limit, y: -dx / length * fade * limit };
    }));
    const movedRing = moves.map(ring => ring.some(m => m.x !== 0 || m.y !== 0));
    const build = (k: number, offset: number): PathCmd[] => {
      const d: PathCmd[] = rings[k]!.map((p, j) => [j === 0 ? 'M' : 'L', p.x + moves[k]![j]!.x * offset, p.y + moves[k]![j]!.y * offset]);
      if (result.chains[k]!.closed) d.push(['Z']);
      return d;
    };
    // A ring nothing moves is the same at every offset: build it once.
    const still: PathCmd[][] = [];
    const candidate = (offset: number): CoastGeometry => ({ ...result,
      paths: rings.map((_, k) => movedRing[k] ? build(k, offset) : (still[k] ??= build(k, 0))),
    });
    const shareOf = localShare(result, rings, moves, clip, size, page, ink) ?? ((offset: number) => measure(candidate(offset)));
    const segments = rings.flatMap((ring, k) => ring.slice(0, -1).map((p, j) => ({ k, j,
      moved: moves[k]![j]!.x !== 0 || moves[k]![j]!.y !== 0 || moves[k]![j + 1]!.x !== 0 || moves[k]![j + 1]!.y !== 0,
      box: [Math.min(p.x, ring[j + 1]!.x) - size * 0.35, Math.min(p.y, ring[j + 1]!.y) - size * 0.35,
        Math.max(p.x, ring[j + 1]!.x) + size * 0.35, Math.max(p.y, ring[j + 1]!.y) + size * 0.35] })))
      .filter(s => s.box[2]! >= centre.x - size && s.box[0]! <= centre.x + size && s.box[3]! >= centre.y - size && s.box[1]! <= centre.y + size);
    const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const simple = (g: CoastGeometry) => {
      const found: Point[][] = [];
      const points = new Proxy(found, { get: (_, k) => found[Number(k)] ??= g.paths[Number(k)]!.filter(c => c[0] !== 'Z').map(c => ({ x: c[1] as number, y: c[2] as number })) }) as Point[][];
      for (const s of segments) {
        if (!s.moved) continue;
        const a = points[s.k]![s.j]!, b = points[s.k]![s.j + 1]!;
        const originalA = rings[s.k]![s.j]!, originalB = rings[s.k]![s.j + 1]!;
        if ((b.x - a.x) * (originalB.x - originalA.x) + (b.y - a.y) * (originalB.y - originalA.y) <= 0) return false;
        for (const t of segments) {
          if (s.k === t.k && (Math.abs(s.j - t.j) <= 1 || Math.abs(s.j - t.j) === rings[s.k]!.length - 2)) continue;
          const c = points[t.k]![t.j]!, d = points[t.k]![t.j + 1]!;
          if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.min(a.x, b.x) > Math.max(c.x, d.x) ||
            Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.min(a.y, b.y) > Math.max(c.y, d.y)) continue;
          if (cross(a, b, c) * cross(a, b, d) < -1e-8 && cross(c, d, a) * cross(c, d, b) < -1e-8) return false;
        }
      }
      return true;
    };
    let selected = result;
    const sample = (offset: number) => {
      const g = candidate(offset);
      if (!simple(g)) return undefined;
      const share = shareOf(offset), error = Math.abs(share - target.share);
      if (error < bestError) { bestError = error; selected = g; }
      return share;
    };
    let low = -1, high = 1;
    let minimum = sample(low), maximum = sample(high);
    for (let step = 0; minimum === undefined && step < 8; step++) minimum = sample(low /= 2);
    for (let step = 0; maximum === undefined && step < 8; step++) maximum = sample(high /= 2);
    if (minimum !== undefined && maximum !== undefined && target.share > minimum && target.share < maximum) for (let step = 0; step < 14 && bestError > 0.002; step++) {
      const middle = (low + high) / 2;
      const share = sample(middle);
      if (share === undefined) break;
      if (share < target.share) low = middle;
      else high = middle;
    }
    result = selected;
  }
  if (result !== geometry) {
    const rings = result.paths.flatMap(d => pathPolylines(d, 8));
    result = { ...result, anchors: new Map([...geometry.anchors].map(([key, p]) => [key, nearestOn(p, rings).at])) };
  }
  return result;
}

/**
 * The share of `clip` a candidate of `fitCoastAreas` shows, `rings` moved by `moves` times an
 * offset, measured as `areaCoverage` would measure the whole candidate outline (the same
 * outlines, edges and stroke segments, in the same order) but from the parts that can reach
 * the clip's measuring lines alone, rather than rebuilding the whole map's outline for each
 * candidate. Null where the candidate would not be assembled as `drawnLand` assembles `result`
 * (an empty or single-point ring), for the caller to measure in full.
 */
function localShare(result: CoastGeometry, rings: Point[][], moves: Point[][], clip: Point[], size: number,
  page: { width: number; height: number }, ink: number): ((offset: number) => number) | null {
  if (rings.some(ring => ring.length < 2)) return null;
  const band = 8;
  const hexArea = 1.5 * Math.sqrt(3) * size * size;
  const box = [Math.min(...clip.map(p => p.x)), Math.min(...clip.map(p => p.y)), Math.max(...clip.map(p => p.x)), Math.max(...clip.map(p => p.y))] as const;
  const firstRow = Math.floor(box[1] / band), lastRow = Math.floor(box[3] / band);
  // A point is a chain's sample (`k`, `j`; `j` past the end is a closed chain's return to its
  // start) or a fixed point on the page's edge (`k` = -1).
  type Ref = { k: number; j: number; at?: Point };
  const base = (r: Ref) => r.k < 0 ? r.at! : rings[r.k]![r.j < rings[r.k]!.length ? r.j : 0]!;
  const move = (r: Ref) => r.k < 0 ? { x: 0, y: 0 } : moves[r.k]![r.j < rings[r.k]!.length ? r.j : 0]!;
  const reach = (r: Ref) => Math.hypot(move(r).x, move(r).y);
  const value = (r: Ref, offset: number): Point => {
    const p = base(r), m = move(r);
    return { x: p.x + m.x * offset, y: p.y + m.y * offset };
  };
  const chainRefs = (k: number, from: number) => {
    const out: Ref[] = [];
    for (let j = from; j < rings[k]!.length; j++) out.push({ k, j });
    if (result.chains[k]!.closed) out.push({ k, j: rings[k]!.length });
    return out;
  };
  const outlines = drawnLandLayout(result, page.width, page.height, size).map(ring => {
    const refs: Ref[] = 'closed' in ring ? chainRefs(ring.closed, 0)
      : ring.open.flatMap(item => 'point' in item ? [{ k: -1, j: 0, at: item.point }] : chainRefs(item.chain, item.first ? 0 : 1));
    if (!('closed' in ring)) refs.push(refs[0]!);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const moving: Ref[] = [];
    for (const r of refs) {
      if (reach(r) > 0) { moving.push(r); continue; }
      const p = base(r);
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
    }
    const edges: number[] = [];
    for (let e = 0; e < refs.length; e++) {
      const a = refs[e]!, b = refs[(e + 1) % refs.length]!, slack = Math.max(reach(a), reach(b));
      const top = Math.min(base(a).y, base(b).y) - slack, bottom = Math.max(base(a).y, base(b).y) + slack;
      if (Math.floor(bottom / band) >= firstRow && Math.floor(top / band) <= lastRow) edges.push(e);
    }
    return { refs, still: [x0, y0, x1, y1], moving, edges };
  }).filter(o => o.edges.length > 0);
  const strokes: Array<[Ref, Ref]> = [];
  rings.forEach((_, k) => {
    const refs = chainRefs(k, 0);
    for (let j = 0; j + 1 < refs.length; j++) {
      const a = refs[j]!, b = refs[j + 1]!, slack = ink + Math.max(reach(a), reach(b));
      const p = base(a), q = base(b);
      if (Math.max(p.x, q.x) + slack < box[0] || Math.min(p.x, q.x) - slack > box[2] || Math.max(p.y, q.y) + slack < box[1] || Math.min(p.y, q.y) - slack > box[3]) continue;
      strokes.push([a, b]);
    }
  });
  return (offset) => {
    const prepared: CoverageRing[] = outlines.map(({ refs, still, moving, edges }) => {
      let [x0, y0, x1, y1] = still as [number, number, number, number];
      for (const r of moving) {
        const p = value(r, offset);
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      return { box: [x0, y0, x1, y1], edges: (visit) => { for (const e of edges) visit(value(refs[e]!, offset), value(refs[(e + 1) % refs.length]!, offset)); } };
    });
    return coverageOf(prepared, (visit) => { for (const [a, b] of strokes) visit(value(a, offset), value(b, offset)); },
      { evenOdd: true, reach: ink, within: clip })(clip, 128) / hexArea;
  };
}
