/**
 * Redrawing the coast round an edit from a small region (DECISIONS §103).
 *
 * After a local edit the coast is traced and fitted again over a crop of the map round it only.
 * Within a disc round the edit that crop's coast replaces the old one; across a band outside the
 * disc the two are blended through their signed distance fields, so that the new coast meets the
 * old where the band ends; beyond it the old coast is kept as it was. The new coast is then cut
 * into the old at a circle and reconnected, which also joins or splits rings where the edit does.
 */
import type { Point } from '../../shared/hex.js';

/** A coastline as points, with land on its right. */
export interface ShoreLine { points: Point[]; closed: boolean }

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Signed distance to `lines` (land positive, by even-odd `land`), within `reach`, for points
 * within `extent` of `centre`.
 */
function signedDistance(land: Point[][], lines: Point[][], centre: Point, extent: number, reach: number, cell: number): (x: number, y: number) => number {
  const inside = bandParity(land, centre.y - extent, centre.y + extent, cell / 2);
  const grid = new Map<number, number[]>();
  const key = (x: number, y: number) => (x + 32768) * 65536 + (y + 32768);
  const segments: number[] = [];
  for (const line of lines) for (let k = 1; k < line.length; k++) {
    const a = line[k - 1]!, b = line[k]!;
    if (Math.max(a.x, b.x) < centre.x - extent - reach || Math.min(a.x, b.x) > centre.x + extent + reach
      || Math.max(a.y, b.y) < centre.y - extent - reach || Math.min(a.y, b.y) > centre.y + extent + reach) continue;
    const id = segments.length;
    segments.push(a.x, a.y, b.x, b.y);
    for (let x = Math.floor((Math.min(a.x, b.x) - reach) / cell); x <= Math.floor((Math.max(a.x, b.x) + reach) / cell); x++)
      for (let y = Math.floor((Math.min(a.y, b.y) - reach) / cell); y <= Math.floor((Math.max(a.y, b.y) + reach) / cell); y++) {
        const list = grid.get(key(x, y));
        if (list) list.push(id); else grid.set(key(x, y), [id]);
      }
  }
  return (px: number, py: number) => {
    let d2 = reach * reach;
    const list = grid.get(key(Math.floor(px / cell), Math.floor(py / cell)));
    if (list) for (const id of list) {
      const ax = segments[id]!, ay = segments[id + 1]!, ex = segments[id + 2]! - ax, ey = segments[id + 3]! - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / (ex * ex + ey * ey || 1)));
      const dx = px - ax - ex * t, dy = py - ay - ey * t, e = dx * dx + dy * dy;
      if (e < d2) d2 = e;
    }
    const d = Math.sqrt(d2);
    return inside(px, py) ? d : -d;
  };
}

/**
 * Even-odd inside test for points with y between `top` and `bottom`: only the rings' edges that
 * reach that band are read, so that a test near an edit costs nothing for the rest of the map.
 */
function bandParity(rings: Point[][], top: number, bottom: number, band: number): (x: number, y: number) => boolean {
  const rows = new Map<number, number[]>(), edges: number[] = [];
  for (const ring of rings) for (let k = 0; k < ring.length; k++) {
    const a = ring[k]!, b = ring[(k + 1) % ring.length]!;
    if (a.y === b.y || Math.max(a.y, b.y) < top || Math.min(a.y, b.y) > bottom) continue;
    const id = edges.length;
    edges.push(a.x, a.y, b.x, b.y);
    for (let r = Math.floor(Math.max(top, Math.min(a.y, b.y)) / band); r <= Math.floor(Math.min(bottom, Math.max(a.y, b.y)) / band); r++)
      (rows.get(r) ?? rows.set(r, []).get(r)!).push(id);
  }
  return (x: number, y: number) => {
    let inside = false;
    const list = rows.get(Math.floor(y / band));
    if (list) for (const id of list) {
      const ax = edges[id]!, ay = edges[id + 1]!, bx = edges[id + 2]!, by = edges[id + 3]!;
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
    }
    return inside;
  };
}

/**
 * The coast within `radius` of `centre`: the fresh coast (`fresh`) out to `inner`, blended into the
 * old coast (`old`) between `inner` and `outer`, and the old coast beyond, as directed segments with
 * land on their right. `radius` must lie beyond `outer`.
 */
export function blendedShore(old: { land: Point[][]; lines: Point[][] }, fresh: { land: Point[][]; lines: Point[][] },
  centre: Point, inner: number, outer: number, radius: number, size: number, bounds: Bounds): Array<[Point, Point]> {
  const step = size / 32, extent = radius + 3 * step, reach = size * 0.5, cell = size / 4;
  const fOld = signedDistance(old.land, old.lines, centre, extent, reach, cell);
  const fNew = signedDistance(fresh.land, fresh.lines, centre, Math.min(extent, outer + 3 * step), reach, cell);
  const n = Math.ceil(2 * extent / step) + 1, x0 = centre.x - extent, y0 = centre.y - extent;
  const field = (x: number, y: number) => {
    const d = Math.hypot(x - centre.x, y - centre.y);
    if (d <= inner) return fNew(x, y);
    if (d >= outer) return fOld(x, y);
    const s = (outer - d) / (outer - inner), w = s * s * (3 - 2 * s);
    return w * fNew(x, y) + (1 - w) * fOld(x, y);
  };
  // Coarse first. Each field changes by no more than the distance moved, and the blend by at most
  // twice that (its weight changes by 1.5 over the band's 1.6 hexes, between fields at most twice
  // `reach` apart), so a coarse cell whose corners all lie that far clear of the line on one side
  // holds none of it, and its fine nodes need only that side's sign. The cell is kept small enough
  // for that to be less than `reach`, which the fields are capped at.
  const values = new Float64Array(n * n).fill(NaN);
  const span = 4, m = Math.ceil((n - 1) / span) + 1, coarse = new Float64Array(m * m);
  for (let gy = 0; gy < m; gy++) for (let gx = 0; gx < m; gx++) coarse[gy * m + gx] = field(x0 + gx * span * step, y0 + gy * span * step);
  const clear = span * step * Math.SQRT2 * 2, limit = extent * extent;
  for (let gy = 0; gy + 1 < m; gy++) for (let gx = 0; gx + 1 < m; gx++) {
    const c = [coarse[gy * m + gx]!, coarse[gy * m + gx + 1]!, coarse[(gy + 1) * m + gx]!, coarse[(gy + 1) * m + gx + 1]!];
    const far = c.every(v => v > clear) ? 1 : c.every(v => v < -clear) ? -1 : 0;
    for (let y = gy * span; y <= Math.min(n - 1, (gy + 1) * span); y++) for (let x = gx * span; x <= Math.min(n - 1, (gx + 1) * span); x++) {
      const i = y * n + x;
      if (!Number.isNaN(values[i]!)) continue;
      const px = x0 + x * step, py = y0 + y * step;
      // Nodes a little beyond the cut, so that the line reaches it.
      if ((px - centre.x) ** 2 + (py - centre.y) ** 2 > limit || px < bounds.x0 - 3 * step || px > bounds.x1 + 3 * step
        || py < bounds.y0 - 3 * step || py > bounds.y1 + 3 * step) continue;
      let v = far !== 0 ? far * clear : field(px, py);
      // A node exactly on the line would make a segment of no length.
      if (v === 0) v = 1e-9;
      values[i] = v;
    }
  }
  const out: Array<[Point, Point]> = [];
  const cut = (i: number, j: number): Point => {
    // From the lower node, so that the two triangles sharing an edge cut it at the same point.
    const lo = Math.min(i, j), hi = Math.max(i, j), t = values[lo]! / (values[lo]! - values[hi]!);
    const ax = x0 + (lo % n) * step, ay = y0 + Math.floor(lo / n) * step, bx = x0 + (hi % n) * step, by = y0 + Math.floor(hi / n) * step;
    return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t };
  };
  const triangle = (i: number, j: number, k: number) => {
    const ids = [i, j, k], cuts: Point[] = [];
    let landward = -1;
    for (let e = 0; e < 3; e++) {
      const a = ids[e]!, b = ids[(e + 1) % 3]!;
      if (values[a]! > 0) landward = a;
      if ((values[a]! > 0) !== (values[b]! > 0)) cuts.push(cut(a, b));
    }
    if (cuts.length !== 2 || landward < 0) return;
    let [a, b] = cuts as [Point, Point];
    const lx = x0 + (landward % n) * step, ly = y0 + Math.floor(landward / n) * step;
    // Land on the right, as on every coast chain (y runs down the page).
    if ((b.x - a.x) * (ly - a.y) - (b.y - a.y) * (lx - a.x) < 0) [a, b] = [b, a];
    if (dist(a, b) > 1e-9) out.push([a, b]);
  };
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const i = y * n + x, a = values[i]!, b = values[i + 1]!, c = values[i + n]!, d = values[i + n + 1]!;
    if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) continue;
    const pos = (a > 0 ? 1 : 0) + (b > 0 ? 1 : 0) + (c > 0 ? 1 : 0) + (d > 0 ? 1 : 0);
    if (pos === 0 || pos === 4) continue;
    triangle(i, i + 1, i + n + 1);
    triangle(i, i + n + 1, i + n);
  }
  return out;
}

/** A rectangle: the page, grown a little. */
export interface Bounds { x0: number; y0: number; x1: number; y1: number }

/**
 * The old coast (`lines`, one per chain) with everything in the region replaced by `segments` (from
 * `blendedShore`), reconnected where they cross its edge: the coast lines that reach the region,
 * rebuilt, each with the old lines it was made from. The region is the disc of `radius` round
 * `centre`, cut off by `bounds` (the page and a little): a new line reaching that cut ends there,
 * to be run on to the page's rim, and the old lines' runs beyond the page are dropped. Lines that
 * do not reach the region are left out (they are unchanged). Null where the two do not meet one
 * for one at the circle.
 */
export function reconnectShore(lines: ShoreLine[], segments: Array<[Point, Point]>, centre: Point, radius: number, tolerance: number,
  bounds: Bounds, page: Bounds): { lines: Array<ShoreLine & { from: number[] }>; reached: Set<number> } | null {
  const inside = (p: Point) => dist(p, centre) < radius && p.x > bounds.x0 && p.x < bounds.x1 && p.y > bounds.y0 && p.y < bounds.y1;
  const onPage = (p: Point) => p.x >= page.x0 && p.x <= page.x1 && p.y >= page.y0 && p.y <= page.y1;
  /** Where a→b crosses the region's edge (one end in, one out), and whether that is at the cut. */
  const crossing = (a: Point, b: Point): { at: Point; cut: boolean } => {
    let lo = 0, hi = 1;
    const inA = inside(a);
    for (let k = 0; k < 40; k++) {
      const t = (lo + hi) / 2, p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (inside(p) === inA) lo = t; else hi = t;
    }
    const t = (lo + hi) / 2, at = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    return { at, cut: Math.abs(dist(at, centre) - radius) > 1e-6 * radius + 1e-9 };
  };
  // The new coast within the region, chained: each piece from where it enters to where it leaves.
  const key = (p: Point) => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)}`;
  const kept: Array<[Point, Point]> = [];
  const cuts = new Set<string>();
  for (const [a, b] of segments) {
    const ia = inside(a), ib = inside(b);
    if (ia && ib) kept.push([a, b]);
    else if (ia || ib) {
      const c = crossing(a, b);
      if (c.cut) cuts.add(key(c.at));
      kept.push(ia ? [a, c.at] : [c.at, b]);
    }
  }
  const starting = new Map<string, number[]>(), ending = new Set<string>();
  kept.forEach(([a, b], s) => {
    const k = key(a);
    (starting.get(k) ?? starting.set(k, []).get(k)!).push(s);
    ending.add(key(b));
  });
  const used = new Array<boolean>(kept.length).fill(false);
  const follow = (s: number): Point[] => {
    const points = [kept[s]![0]];
    let at = s;
    for (;;) {
      used[at] = true;
      const end = kept[at]![1];
      points.push(end);
      const next = starting.get(key(end))?.find(t => !used[t]);
      if (next === undefined) break;
      at = next;
    }
    return points;
  };
  const pieces: Point[][] = [], loops: Point[][] = [];
  kept.forEach((seg, s) => { if (!used[s] && !ending.has(key(seg[0]))) pieces.push(follow(s)); });
  kept.forEach((_, s) => { if (!used[s]) loops.push(follow(s)); });
  // Every open piece runs from the region's edge to its edge.
  const onEdge = (p: Point) => cuts.has(key(p)) || Math.abs(dist(p, centre) - radius) < tolerance * 0.5;
  if (pieces.some(p => !onEdge(p[0]!) || !onEdge(p.at(-1)!))) return null;
  for (const loop of loops) if (dist(loop[0]!, loop.at(-1)!) > tolerance) return null;
  const atCut = (p: Point) => cuts.has(key(p));

  // The old coast outside the region, as runs, each with where it leaves and enters it across the
  // circle (an end at the cut, or at the line's own end, is open).
  type Run = { points: Point[]; from: number; enters: Point | null; leaves: Point | null; used?: boolean };
  const runs: Run[] = [];
  const reached = new Set<number>();
  lines.forEach((line, index) => {
    let points = line.points;
    if (!points.some(inside)) return;
    reached.add(index);
    if (line.closed) {
      const ring = dist(points[0]!, points.at(-1)!) < 1e-9 ? points.slice(0, -1) : points;
      const start = ring.findIndex(p => !inside(p));
      if (start < 0) return; // wholly within the region: replaced
      points = [...ring.slice(start), ...ring.slice(0, start + 1)];
    }
    const mine: Run[] = [];
    let current: Run | null = inside(points[0]!) ? null : { points: [points[0]!], from: index, enters: null, leaves: null };
    for (let k = 1; k < points.length; k++) {
      const a = points[k - 1]!, b = points[k]!;
      if (current) {
        if (inside(b)) {
          const c = crossing(a, b);
          current.points.push(c.at);
          current.leaves = c.cut ? null : c.at;
          mine.push(current);
          current = null;
        } else current.points.push(b);
      } else if (!inside(b)) {
        const c = crossing(a, b);
        current = { points: [c.at, b], from: index, enters: c.cut ? null : c.at, leaves: null };
      }
    }
    if (current) {
      // A ring began outside: its last run continues into its first.
      const first = line.closed ? mine.find(r => r === mine[0] && r.points[0] === points[0]) : undefined;
      if (first) { first.points = [...current.points, ...first.points.slice(1)]; first.enters = current.enters; }
      else mine.push(current);
    }
    // A run wholly beyond the page (where a line runs out to the rim) goes with the cut.
    for (const run of mine) if (run.points.some(onPage)) runs.push(run);
  });

  // Each place an old run leaves across the circle must meet the start of one new piece, and each
  // new piece's end on the circle the place an old run enters.
  const nearest = <T>(items: T[], at: (item: T) => Point | null, p: Point, taken: (item: T) => boolean): T | null => {
    let best: T | null = null, bestD = tolerance, second = Infinity;
    for (const item of items) {
      const q = at(item);
      if (!q || taken(item)) continue;
      const d = dist(p, q);
      if (d < bestD) { second = bestD; bestD = d; best = item; }
      else if (d < second) second = d;
    }
    // Two candidates nearly as close: ambiguous.
    if (best && second < bestD + tolerance * 0.25 && second < tolerance) return null;
    return best;
  };
  const pieceUsed = new Array<boolean>(pieces.length).fill(false);
  const out: Array<ShoreLine & { from: number[] }> = [];
  type Step = { run: Run } | { piece: number };
  const walk = (first: Step): (ShoreLine & { from: number[] }) | null => {
    const points: Point[] = [], from = new Set<number>();
    let step: Step = first;
    const startRun = 'run' in first ? first.run : null;
    for (;;) {
      let end: Point;
      if ('run' in step) {
        const run = step.run;
        run.used = true;
        from.add(run.from);
        points.push(...(points.length ? run.points.slice(1) : run.points));
        if (!run.leaves) return { points, closed: false, from: [...from] };
        const k = nearest(pieces.map((_, j) => j), j => atCut(pieces[j]![0]!) ? null : pieces[j]![0]!, run.leaves, j => pieceUsed[j]!);
        if (k === null) return null;
        step = { piece: k };
        continue;
      }
      const piece = pieces[step.piece]!;
      pieceUsed[step.piece] = true;
      if (!points.length) points.push(piece[0]!);
      points.push(...piece.slice(1, -1));
      end = piece.at(-1)!;
      if (atCut(end)) { points.push(end); return { points, closed: false, from: [...from] }; }
      const next = nearest(runs, r => r.enters, end, r => r.used === true && r !== startRun);
      if (!next) return null;
      if (next === startRun) { points.push(startRun.points[0]!); return { points, closed: true, from: [...from] }; }
      points.push(next.points[0]!);
      next.used = true;
      from.add(next.from);
      points.push(...next.points.slice(1));
      if (!next.leaves) return { points, closed: false, from: [...from] };
      const k = nearest(pieces.map((_, j) => j), j => atCut(pieces[j]![0]!) ? null : pieces[j]![0]!, next.leaves, j => pieceUsed[j]!);
      if (k === null) return null;
      step = { piece: k };
    }
  };
  for (const run of runs) if (!run.used && run.enters === null) { const line = walk({ run }); if (!line) return null; out.push(line); }
  for (let j = 0; j < pieces.length; j++) if (!pieceUsed[j] && atCut(pieces[j]![0]!)) { const line = walk({ piece: j }); if (!line) return null; out.push(line); }
  for (const run of runs) if (!run.used) { const line = walk({ run }); if (!line || !line.closed) return null; out.push(line); }
  if (pieceUsed.some(u => !u)) return null;
  for (const loop of loops) out.push({ points: loop, closed: true, from: [] });
  // A line that reached the region is replaced by those made from it; one wholly within it, by none.
  return { lines: out, reached };
}
