import type { Point } from '../../shared/hex.js';
import type { CoastChain, CoastEdge, Roughness, Sliver } from './coast.js';
import type { PathCmd } from './prims.js';
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const polygon = (pts: Point[]): PathCmd[] => [...pts.map((p, i) => [i ? 'L' : 'M', p.x, p.y] as PathCmd), ['Z']];
function segmentDistance(p: Point, e: CoastEdge): number {
  const dx = e.to.x - e.from.x, dy = e.to.y - e.from.y;
  const t = Math.max(0, Math.min(1, ((p.x - e.from.x) * dx + (p.y - e.from.y) * dy) / (dx * dx + dy * dy || 1)));
  return distance(p, lerp(e.from, e.to, t));
}
/** Spatial index shared by all component rings: nearby islands and holes constrain each other. */
export function coastClearance(chains: CoastChain[], size: number): (p: Point, chain: CoastChain, arc: number) => number {
  const bins = new Map<string, Array<{
    edge: CoastEdge;
    chain: CoastChain;
    arc: number;
    length: number;
  }>>();
  const lengths = new Map<CoastChain, number>();
  for (const chain of chains) {
    let arc = 0;
    for (const edge of chain.edges) {
      const length = distance(edge.from, edge.to);
      const entry = { edge, chain, arc, length };
      for (let x = Math.floor(Math.min(edge.from.x, edge.to.x) / size); x <= Math.floor(Math.max(edge.from.x, edge.to.x) / size); x++)
        for (let y = Math.floor(Math.min(edge.from.y, edge.to.y) / size); y <= Math.floor(Math.max(edge.from.y, edge.to.y) / size); y++) {
          const key = `${x},${y}`;
          const bin = bins.get(key);
          if (bin)
            bin.push(entry);
          else
            bins.set(key, [entry]);
        }
      arc += length;
    }
    lengths.set(chain, arc);
  }
  return (p, chain, arc) => {
    let nearest = size * 3;
    const x = Math.floor(p.x / size), y = Math.floor(p.y / size);
    for (let dx = -3; dx <= 3; dx++)
      for (let dy = -3; dy <= 3; dy++)
        for (const e of bins.get(`${x + dx},${y + dy}`) ?? []) {
          if (e.chain === chain) {
            let gap = Math.abs(arc - (e.arc + e.length / 2));
            if (chain.closed)
              gap = Math.min(gap, lengths.get(chain)! - gap);
            if (gap < size * 2 + e.length / 2)
              continue;
          }
          nearest = Math.min(nearest, segmentDistance(p, e.edge));
        }
    return nearest;
  };
}
/** Uniform arc-length samples, a multi-hex low-pass silhouette, then continuous spatial noise.
* No source corner or edge midpoint is a mandatory waypoint. Source correspondence is kept
* solely for donor colours, fill correction, border ends and explicit geographic constraints.
*/
export function componentCoast(chain: CoastChain, rough: Roughness, clearance: ReturnType<typeof coastClearance>) {
  const { size } = rough;
  const starts: number[] = [];
  let perimeter = 0;
  for (const e of chain.edges) {
    starts.push(perimeter);
    perimeter += distance(e.from, e.to);
  }
  const count = Math.max(12, Math.ceil(perimeter / (size / 8)));
  const step = perimeter / count;
  const n = chain.closed ? count : count + 1;
  let edgeIndex = 0;
  const source: Point[] = [], donors: CoastEdge[] = [];
  for (let i = 0; i < n; i++) {
    const arc = i * step;
    while (edgeIndex + 1 < starts.length && starts[edgeIndex + 1]! < arc)
      edgeIndex++;
    const e = chain.edges[edgeIndex]!;
    source.push(lerp(e.from, e.to, (arc - starts[edgeIndex]!) / (distance(e.from, e.to) || 1)));
    donors.push(e);
  }
  const at = (i: number) => source[chain.closed ? (i % n + n) % n : Math.max(0, Math.min(n - 1, i))]!;
  const sigma = Math.min(size * 0.85, perimeter / 6);
  const span = Math.ceil(sigma * 3 / step);
  const silhouette = source.map((_, i) => {
    let x = 0, y = 0, total = 0;
    for (let k = -span; k <= span; k++) {
      const w = Math.exp(-0.5 * (k * step / sigma) ** 2), q = at(i + k);
      x += q.x * w;
      y += q.y * w;
      total += w;
    }
    return { x: x / total, y: y / total };
  });
  // Restore the area removed by curvature smoothing, without restoring grid corners.
  if (chain.closed) {
    const area = (pts: Point[]) => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]!; return s + p.x * q.y - q.x * p.y; }, 0));
    const scale = Math.min(1.45, Math.sqrt(area(source) / (area(silhouette) || 1)));
    const c = { x: silhouette.reduce((s, p) => s + p.x, 0) / n, y: silhouette.reduce((s, p) => s + p.y, 0) / n };
    silhouette.forEach((p, i) => silhouette[i] = { x: c.x + (p.x - c.x) * scale, y: c.y + (p.y - c.y) * scale });
  }
  const noise = (p: Point, wavelength: number, k: number) => {
    const x = p.x / (size * wavelength), y = p.y / (size * wavelength), ix = Math.floor(x), iy = Math.floor(y);
    const ease = (t: number) => t * t * (3 - 2 * t), u = ease(x - ix), v = ease(y - iy);
    const a = rough.noise(ix, iy, k), b = rough.noise(ix + 1, iy, k), c = rough.noise(ix, iy + 1, k), d = rough.noise(ix + 1, iy + 1, k);
    return ((a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v) * 2 - 1;
  };
  const result = silhouette.map((p, i) => {
    const prev = silhouette[chain.closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!;
    const next = silhouette[chain.closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!;
    const dx = next.x - prev.x, dy = next.y - prev.y, len = Math.hypot(dx, dy) || 1;
    const amplitude = rough.amplitude(donors[i]!);
    const strength = amplitude > 0 ? 1 : 0;
    const off = amplitude * size * (noise(p, 2.4, 61) * 1.3 + noise(p, 0.55, 62) * 0.35) - (rough.lean?.(donors[i]!) ?? 0) * size;
    const target = { x: p.x - dy / len * off, y: p.y + dx / len * off };
    const original = source[i]!;
    // Both opposing shores can move by at most 28% of their separation, leaving a positive width.
    // A caller can tighten this bound to preserve a specified channel/neck width.
    const limit = Math.min(size * 0.8, clearance(original, chain, i * step) * 0.28, rough.displacementLimit?.(donors[i]!) ?? Infinity);
    const move = distance(original, target);
    const ends = chain.closed ? 1 : Math.min(1, i * step / (size * 1.5), (perimeter - i * step) / (size * 1.5));
    return lerp(original, target, Math.min(strength, limit / (move || 1)) * ends);
  });
  // Ease the bounded displacement as a curve, so a local clearance limit cannot introduce
  // a new corner. In explicitly narrow features this last filter has a correspondingly short reach.
  const eased = result.map((p, i) => {
    if (!chain.closed && (i === 0 || i === n - 1))
      return p;
    const widthLimit = rough.displacementLimit?.(donors[i]!) ?? Infinity;
    const radius = Math.min(size * 0.35, perimeter / 6, Math.max(size / 16, widthLimit * 0.5));
    const reach = Math.ceil(radius * 3 / step);
    let x = 0, y = 0, sum = 0;
    for (let k = -reach; k <= reach; k++) {
      const j = chain.closed ? (i + k + n) % n : Math.max(0, Math.min(n - 1, i + k));
      const w = Math.exp(-0.5 * (k * step / radius) ** 2);
      x += result[j]!.x * w;
      y += result[j]!.y * w;
      sum += w;
    }
    return { x: x / sum, y: y / sum };
  });
  result.splice(0, result.length, ...eased);
  const onResult = (arc: number) => {
    const t = arc / step, j = Math.min(n - 1, Math.floor(t));
    return lerp(result[j]!, result[chain.closed ? (j + 1) % n : Math.min(n - 1, j + 1)]!, t - j);
  };
  const toLand: Sliver[] = [], toWater: Sliver[] = [];
  // Split the swept ribbon at BOTH sample positions and source vertices. The source side then
  // follows the exact old boundary, including its donor changes; only the new side is resampled.
  chain.edges.forEach((e, edge) => {
    const start = starts[edge]!, length = distance(e.from, e.to), end = start + length;
    const cuts = [start];
    for (let j = Math.floor(start / step) + 1; j * step < end - 1e-8; j++)
      cuts.push(j * step);
    cuts.push(end);
    for (let k = 0; k < cuts.length - 1; k++) {
      const a = lerp(e.from, e.to, (cuts[k]! - start) / (length || 1));
      const b = lerp(e.from, e.to, (cuts[k + 1]! - start) / (length || 1));
      const p = onResult(cuts[k]!), q = onResult(cuts[k + 1]!);
      const cross = (v: Point) => (b.x - a.x) * (v.y - a.y) - (b.y - a.y) * (v.x - a.x);
      const sp = cross(p), sq = cross(q);
      const emit = (ring: Point[], sign: number) => {
        if (Math.abs(sign) < 1e-8)
          return;
        (sign > 0 ? toWater : toLand).push({ d: polygon(ring), donor: sign > 0 ? e.water : e.land });
      };
      if (sp * sq < 0) {
        const t = sp / (sp - sq), hit = lerp(p, q, t), base = lerp(a, b, t);
        emit([a, base, hit, p], sp);
        emit([base, b, q, hit], sq);
      }
      else
        emit([a, b, q, p], sp + sq);
    }
  });
  const anchors = new Map<string, Point>();
  chain.points.forEach((p, i) => {
    const arc = starts[Math.min(i, starts.length - 1)]! + (i === starts.length ? distance(chain.edges.at(-1)!.from, chain.edges.at(-1)!.to) : 0);
    const t = arc / step, j = Math.min(n - 1, Math.floor(t));
    anchors.set(`${Math.round(p.x * 100)},${Math.round(p.y * 100)}`, lerp(result[j]!, result[chain.closed ? (j + 1) % n : Math.min(n - 1, j + 1)]!, t - j));
  });
  const path: PathCmd[] = result.map((p, i) => [i ? 'L' : 'M', p.x, p.y] as PathCmd);
  if (chain.closed)
    path.push(['Z']);
  return { path, toLand, toWater, anchors };
}
