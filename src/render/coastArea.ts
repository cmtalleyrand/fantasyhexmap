/** Fit residual local shares on the final silhouette, preserving hex crossings. */
import { hexCenter, hexCorners, type Point } from '../../shared/hex.js';
import { coastClearance } from './componentCoast.js';
import { drawnLand, type CoastChain, type CoastGeometry } from './coast.js';
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
    let found = false;
    search: for (let i = 0; i < points.length; i++) for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      const a = points[i]!, b = points[(i + 1) % points.length]!, c = points[j]!, d = points[(j + 1) % points.length]!;
      if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.min(a.x, b.x) > Math.max(c.x, d.x) ||
        Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.min(a.y, b.y) > Math.max(c.y, d.y)) continue;
      if (!(cross(a, b, c) * cross(a, b, d) < -1e-8 && cross(c, d, a) * cross(c, d, b) < -1e-8)) continue;
      const dx = b.x - a.x, dy = b.y - a.y, ex = d.x - c.x, ey = d.y - c.y;
      const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / (dx * ey - dy * ex);
      const intersection = { x: a.x + t * dx, y: a.y + t * dy };
      const outer = [...points.slice(0, i + 1), intersection, ...points.slice(j + 1)];
      const loop = [intersection, ...points.slice(i + 1, j + 1)];
      points = area(outer) >= area(loop) ? outer : loop;
      found = true;
      break search;
    }
    if (!found) break;
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
      { evenOdd: true, stroke: { rings: g.paths.flatMap(d => pathPolylines(d, 8)), reach: ink } })(clip, 128) / hexArea;
    let bestError = Math.abs(measure(result) - target.share);
    if (bestError < 0.004) continue;
    const rings = result.paths.map(d => pathPolylines(d, 8)[0] ?? []);
    const chains: CoastChain[] = rings.map((ring, k) => ({ closed: result.chains[k]!.closed,
      points: ring, edges: ring.slice(0, -1).map((p, j) => ({ from: p, to: ring[j + 1]!, land: hex, water: -1 })) }));
    const clearance = coastClearance(chains, size);
    const moves = rings.map((ring, k) => ring.map((p, j) => {
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
    const candidate = (offset: number): CoastGeometry => ({ ...result,
      paths: rings.map((ring, k) => {
        const d: PathCmd[] = ring.map((p, j) => [j === 0 ? 'M' : 'L', p.x + moves[k]![j]!.x * offset, p.y + moves[k]![j]!.y * offset]);
        if (result.chains[k]!.closed) d.push(['Z']);
        return d;
      }),
    });
    const segments = rings.flatMap((ring, k) => ring.slice(0, -1).map((p, j) => ({ k, j,
      moved: moves[k]![j]!.x !== 0 || moves[k]![j]!.y !== 0 || moves[k]![j + 1]!.x !== 0 || moves[k]![j + 1]!.y !== 0,
      box: [Math.min(p.x, ring[j + 1]!.x) - size * 0.35, Math.min(p.y, ring[j + 1]!.y) - size * 0.35,
        Math.max(p.x, ring[j + 1]!.x) + size * 0.35, Math.max(p.y, ring[j + 1]!.y) + size * 0.35] })))
      .filter(s => s.box[2]! >= centre.x - size && s.box[0]! <= centre.x + size && s.box[3]! >= centre.y - size && s.box[1]! <= centre.y + size);
    const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const simple = (g: CoastGeometry) => {
      const points = g.paths.map(d => d.filter(c => c[0] !== 'Z').map(c => ({ x: c[1] as number, y: c[2] as number })));
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
      const share = measure(g), error = Math.abs(share - target.share);
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
