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
export function coastClearance(chains: CoastChain[], size: number) {
  type Entry = {
    edge: CoastEdge;
    chain: CoastChain;
    arc: number;
    length: number;
  };
  const bins = new Map<number, Map<number, Entry[]>>();
  const lengths = new Map<CoastChain, number>();
  for (const chain of chains) {
    let arc = 0;
    for (const edge of chain.edges) {
      const length = distance(edge.from, edge.to);
      const entry = { edge, chain, arc, length };
      for (let x = Math.floor(Math.min(edge.from.x, edge.to.x) / size); x <= Math.floor(Math.max(edge.from.x, edge.to.x) / size); x++)
        for (let y = Math.floor(Math.min(edge.from.y, edge.to.y) / size); y <= Math.floor(Math.max(edge.from.y, edge.to.y) / size); y++) {
          let column = bins.get(x);
          if (!column) { column = new Map(); bins.set(x, column); }
          const bin = column.get(y);
          if (bin) bin.push(entry);
          else column.set(y, [entry]);
        }
      arc += length;
    }
    lengths.set(chain, arc);
  }
  const candidates = new Map<number, Map<number, Entry[]>>();
  const measure = (p: Point, chain: CoastChain, arc: number, otherComponentsOnly = false) => {
    let nearest = size * 3;
    const x = Math.floor(p.x / size), y = Math.floor(p.y / size);
    let column = candidates.get(x);
    if (!column) { column = new Map(); candidates.set(x, column); }
    let entries = column.get(y);
    if (!entries) {
      const nearby = new Set<Entry>();
      for (let dx = -3; dx <= 3; dx++) for (let dy = -3; dy <= 3; dy++) {
        for (const entry of bins.get(x + dx)?.get(y + dy) ?? []) nearby.add(entry);
      }
      entries = [...nearby]; column.set(y, entries);
    }
    for (const e of entries) {
      if (e.chain === chain) {
        if (otherComponentsOnly) continue;
        let gap = Math.abs(arc - (e.arc + e.length / 2));
        if (chain.closed) gap = Math.min(gap, lengths.get(chain)! - gap);
        if (gap < size * 2 + e.length / 2) continue;
      }
      const a = e.edge.from, b = e.edge.to;
      const bx = Math.max(0, Math.min(a.x, b.x) - p.x, p.x - Math.max(a.x, b.x));
      const by = Math.max(0, Math.min(a.y, b.y) - p.y, p.y - Math.max(a.y, b.y));
      if (bx * bx + by * by > nearest * nearest) continue;
      nearest = Math.min(nearest, segmentDistance(p, e.edge));
    }
    return nearest;
  };
  // A fitting pass can move one coast while leaving distant components alone.
  // Include every edge that their clearance queries could inspect so cached
  // silhouettes are invalidated whenever a nearby constraint changes.
  const signature = (chain: CoastChain): string => {
    const nearby = new Set<Entry>();
    for (const edge of chain.edges) {
      for (let x = Math.floor(Math.min(edge.from.x, edge.to.x) / size) - 3; x <= Math.floor(Math.max(edge.from.x, edge.to.x) / size) + 3; x++) {
        const column = bins.get(x);
        if (!column) continue;
        for (let y = Math.floor(Math.min(edge.from.y, edge.to.y) / size) - 3; y <= Math.floor(Math.max(edge.from.y, edge.to.y) / size) + 3; y++) {
          for (const entry of column.get(y) ?? []) nearby.add(entry);
        }
      }
    }
    return JSON.stringify([...nearby].map(e => [e.edge.from.x, e.edge.from.y, e.edge.to.x, e.edge.to.y,
      e.chain === chain ? e.arc : null, e.length]));
  };
  return Object.assign(measure, { signature });
}
/** Uniform arc-length samples, a multi-hex low-pass silhouette, then independently shaped bays, capes and cuts.
* No source corner or edge midpoint is a mandatory waypoint. Source correspondence is kept
* solely for donor colours, fill correction, border ends and explicit geographic constraints.
*/
export function componentCoast(chain: CoastChain, rough: Roughness, clearance: ReturnType<typeof coastClearance>) {
  const { size } = rough;
  const targetArea = chain.closed ? rough.componentArea?.(chain) : undefined;
  const aggregate = targetArea !== undefined;
  // Policy values belong to source edges, not to each of their dense samples.
  const edgeSettings = new Map(chain.edges.map(edge => [edge, {
    amplitude: rough.amplitude(edge),
    lean: rough.lean?.(edge) ?? 0,
    limit: rough.displacementLimit?.(edge) ?? Infinity,
  }]));
  const starts: number[] = [];
  let perimeter = 0;
  for (const e of chain.edges) {
    starts.push(perimeter);
    perimeter += distance(e.from, e.to);
  }
  const count = Math.max(12, Math.ceil(perimeter / (size / 20)));
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
  // The sampling step is fixed for a component. Reuse Gaussian coefficients
  // instead of evaluating exp for every sample in every smoothing pass.
  const kernels = new Map<number, { reach: number; weights: number[]; total: number }>();
  const kernel = (radius: number) => {
    let cached = kernels.get(radius);
    if (!cached) {
      const reach = Math.ceil(radius * 3 / step);
      const weights = Array.from({ length: 2 * reach + 1 }, (_, j) => Math.exp(-0.5 * ((j - reach) * step / radius) ** 2));
      cached = { reach, weights, total: weights.reduce((sum, w) => sum + w, 0) };
      kernels.set(radius, cached);
    }
    return cached;
  };
  const sigma = Math.min(size * (aggregate ? 1.3 : 0.85), perimeter / 6);
  const silhouetteKernel = kernel(sigma);
  const span = silhouetteKernel.reach;
  const paddedSource = Array.from({ length: n + 2 * span }, (_, j) => at(j - span));
  const silhouette = source.map((_, i) => {
    let x = 0, y = 0;
    for (let k = -span; k <= span; k++) {
      const w = silhouetteKernel.weights[k + span]!, q = paddedSource[i + k + span]!;
      x += q.x * w;
      y += q.y * w;
    }
    return { x: x / silhouetteKernel.total, y: y / silhouetteKernel.total };
  });
  // Restore the area removed by curvature smoothing, without restoring grid corners.
  if (chain.closed && !aggregate) {
    const area = (pts: Point[]) => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]!; return s + p.x * q.y - q.x * p.y; }, 0));
    const scale = Math.min(1.45, Math.sqrt(area(source) / (area(silhouette) || 1)));
    const c = { x: silhouette.reduce((s, p) => s + p.x, 0) / n, y: silhouette.reduce((s, p) => s + p.y, 0) / n };
    silhouette.forEach((p, i) => silhouette[i] = { x: c.x + (p.x - c.x) * scale, y: c.y + (p.y - c.y) * scale });
  }
  // Features belong to the whole component, with independent locations, signs,
  // extents and profiles. Accumulate their finite supports into uniform samples;
  // there is no alternating knot sequence or one repeated motif per hex edge.
  const centre = { x: source.reduce((sum, p) => sum + p.x, 0) / n, y: source.reduce((sum, p) => sum + p.y, 0) / n };
  const random = (feature: number, role: number) => rough.noise(centre.x / size, centre.y / size, feature * 31 + role);
  const features = (band: number) => {
    const broad = band === 0;
    const values = Array<number>(n).fill(0);
    const count = Math.max(broad ? 3 : 8, Math.ceil(perimeter / (size * (broad ? 3.5 : band === 1 ? 0.9 : 0.23))));
    for (let f = 0; f < count; f++) {
      const id = f + (broad ? 1000 : band === 1 ? 10000 : 20000);
      const position = random(id, 0) * perimeter;
      const width = size * (broad ? 0.9 + random(id, 1) * 2.7 : band === 1 ? 0.2 + random(id, 1) ** 2 * 1.0 : 0.06 + random(id, 1) ** 2 * 0.3);
      const left = Math.min(perimeter / 4, width * (0.4 + random(id, 2) * 1.2));
      const right = Math.min(perimeter / 4, width * (0.4 + random(id, 3) * 1.2));
      const height = (random(id, 4) * 2 - 1) * Math.min(broad ? 0.55 : band === 1 ? 0.4 : 0.16, Math.min(left, right) / size * (broad ? 0.7 : 1.15));
      const kind = Math.floor(random(id, 5) * 4);
      const power = 1 + random(id, 6) * 1.25;
      const shelf = 0.15 + random(id, 7) * 0.45;
      const first = Math.ceil((position - left) / step), last = Math.floor((position + right) / step);
      for (let j = first; j <= last; j++) {
        if (!chain.closed && (j < 0 || j >= n)) continue;
        const i = (j % n + n) % n, delta = j * step - position;
        const u = Math.abs(delta) / (delta < 0 ? left : right);
        let shape: number;
        if (kind === 0) shape = (1 - u * u) ** 2;
        else if (kind === 1) shape = (1 - u) ** power;
        else if (kind === 2) shape = u < shelf ? 1 : (1 - u) / (1 - shelf);
        else shape = (1 - u * u) ** 2 * (1 - (delta < 0 ? 3 : 0.5) * u);
        values[i] = values[i]! + height * shape;
      }
    }
    return values;
  };
  const broadFeatures = features(0), cuts = features(1), fine = features(2);
  const shoreFeatures = cuts.map((v, i) => v + fine[i]!);
  const result = silhouette.map((p, i) => {
    const prev = silhouette[chain.closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!;
    const next = silhouette[chain.closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!;
    const dx = next.x - prev.x, dy = next.y - prev.y, len = Math.hypot(dx, dy) || 1;
    const amplitude = edgeSettings.get(donors[i]!)!.amplitude;
    const strength = aggregate || amplitude > 0 ? 1 : 0;
    const off = -edgeSettings.get(donors[i]!)!.lean * size + broadFeatures[i]! * size * amplitude / 0.12;
    const target = { x: p.x - dy / len * off, y: p.y + dx / len * off };
    const original = source[i]!;
    // Reserve movement for detail after the silhouette is eased. Explicit geographic limits
    // divide their budget between this stage and the final irregularity stage.
    const limit = Math.min(size * (aggregate ? 1.2 : 0.8), clearance(original, chain, i * step, aggregate) * 0.24, edgeSettings.get(donors[i]!)!.limit * 0.6);
    const move = distance(original, target);
    const ends = chain.closed ? 1 : Math.min(1, i * step / (size * 1.5), (perimeter - i * step) / (size * 1.5));
    return lerp(original, target, Math.min(strength, limit / (move || 1)) * ends);
  });
  // Ease the bounded displacement as a curve, so a local clearance limit cannot introduce
  // a new corner. In explicitly narrow features this last filter has a correspondingly short reach.
  const paddedResult = new Map<number, Point[]>();
  const eased = result.map((p, i) => {
    if (!chain.closed && (i === 0 || i === n - 1))
      return p;
    const widthLimit = edgeSettings.get(donors[i]!)!.limit;
    const radius = Math.min(size * 0.35, perimeter / 6, Math.max(size / 16, widthLimit * 0.5));
    const smoothingKernel = kernel(radius);
    const reach = smoothingKernel.reach;
    let padded = paddedResult.get(reach);
    if (!padded) {
      padded = Array.from({ length: n + 2 * reach }, (_, j) => result[chain.closed ? (j - reach + n) % n : Math.max(0, Math.min(n - 1, j - reach))]!);
      paddedResult.set(reach, padded);
    }
    let x = 0, y = 0;
    for (let k = -reach; k <= reach; k++) {
      const q = padded[i + k + reach]!;
      const w = smoothingKernel.weights[k + reach]!;
      x += q.x * w;
      y += q.y * w;
    }
    return { x: x / smoothingKernel.total, y: y / smoothingKernel.total };
  });
  result.splice(0, result.length, ...eased);
  const amplitudes = donors.map(edge => edgeSettings.get(edge)!.amplitude);
  const limits = donors.map((edge, i) => Math.min(size * 0.4, clearance(source[i]!, chain, i * step) * 0.14,
    edgeSettings.get(edge)!.limit * 0.4));
  const neighbour = (i: number) => chain.closed ? (i % n + n) % n : Math.max(0, Math.min(n - 1, i));
  const amplitudeSpan = Math.ceil(size * 0.45 / step);
  const amplitudeWeights = Array.from({ length: 2 * amplitudeSpan + 1 }, (_, j) => Math.exp(-0.5 * ((j - amplitudeSpan) * step / (size * 0.15)) ** 2));
  // Ease scalar settings, never the detailed contour: mixed roughness levels and width limits
  // must not create steps at their source hex boundaries or erase the detail after it is formed.
  const settings = amplitudes.map((_, i) => {
    let amplitude = 0, weight = 0, limit = limits[i]!;
    for (let k = -amplitudeSpan; k <= amplitudeSpan; k++) {
      const j = neighbour(i + k), w = amplitudeWeights[k + amplitudeSpan]!;
      amplitude += amplitudes[j]! * w;
      weight += w;
      limit = Math.min(limit, limits[j]! + Math.abs(k) * step * 0.2);
    }
    return { amplitude: amplitude / weight, limit };
  });
  const detail = eased.map((p, i) => {
    const previous = eased[chain.closed ? (i - 1 + n) % n : Math.max(0, i - 1)]!;
    const next = eased[chain.closed ? (i + 1) % n : Math.min(n - 1, i + 1)]!;
    const dx = next.x - previous.x, dy = next.y - previous.y, length = Math.hypot(dx, dy) || 1;
    const arc = i * step;
    const amplitude = settings[i]!.amplitude * size;
    // Keep local cuts and capes after the component-scale silhouette filter. Their
    // profiles range from curved bays to skewed wedges and shelves, rather than
    // covering the whole coast with the same ridged high-frequency field.
    const offset = shoreFeatures[i]! * amplitude / 0.12;
    const move = { x: -dy / length * offset, y: dx / length * offset };
    // The component filter can form tight end caps. Detail must stay inside their
    // curvature radius, not merely the width of the old hex-derived outline.
    const turn = Math.abs((p.x - previous.x) * (next.y - previous.y) - (p.y - previous.y) * (next.x - previous.x));
    const radius = turn > 1e-9 ? distance(previous, p) * distance(p, next) * distance(previous, next) / (2 * turn) : Infinity;
    const limit = Math.min(settings[i]!.limit, aggregate ? radius * 0.3 : Infinity);
    const moveLength = Math.hypot(move.x, move.y) || 1;
    const ends = chain.closed ? 1 : Math.min(1, arc / size, (perimeter - arc) / size);
    const gain = limit > 0 ? limit * Math.tanh(moveLength / limit) / moveLength * ends : 0;
    return { x: p.x + move.x * gain, y: p.y + move.y * gain };
  });
  if (targetArea !== undefined) {
    // A positive affine transform changes the component's area without folding
    // its contour or reintroducing per-hex width constraints. For elongated land,
    // concentrate the area change across its short axis to retain its long reach.
    const centre = { x: detail.reduce((sum, p) => sum + p.x, 0) / n, y: detail.reduce((sum, p) => sum + p.y, 0) / n };
    let xx = 0, xy = 0, yy = 0;
    for (const p of detail) {
      const x = p.x - centre.x, y = p.y - centre.y;
      xx += x * x; xy += x * y; yy += y * y;
    }
    const angle = Math.atan2(2 * xy, xx - yy) / 2;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const difference = Math.hypot(xx - yy, 2 * xy);
    const aspect = Math.sqrt((xx + yy + difference) / Math.max(1e-8, xx + yy - difference));
    const area = Math.abs(detail.reduce((sum, p, i) => { const q = detail[(i + 1) % n]!; return sum + p.x * q.y - q.x * p.y; }, 0)) / 2;
    const exponent = 0.5 / Math.max(1, aspect);
    let ratio = targetArea / Math.max(1e-8, area);
    if ((rough.componentInk ?? 0) > 0 && targetArea > 0) {
      const edges = detail.map((p, i) => {
        const q = detail[(i + 1) % n]!, dx = q.x - p.x, dy = q.y - p.y;
        return { u: dx * cos + dy * sin, v: -dx * sin + dy * cos };
      });
      let low = 0, high = ratio;
      for (let pass = 0; pass < 32; pass++) {
        const mid = (low + high) / 2, along = mid ** exponent, across = mid / along;
        const perimeter = edges.reduce((sum, e) => sum + Math.hypot(e.u * along, e.v * across), 0);
        if (area * mid + rough.componentInk! * perimeter > targetArea) high = mid;
        else low = mid;
      }
      ratio = (low + high) / 2;
    }
    const along = ratio ** exponent, across = ratio === 0 ? 0 : ratio / along;
    detail.forEach((p, i) => {
      const x = p.x - centre.x, y = p.y - centre.y;
      const u = (x * cos + y * sin) * along, v = (-x * sin + y * cos) * across;
      detail[i] = { x: centre.x + u * cos - v * sin, y: centre.y + u * sin + v * cos };
    });
  }
  result.splice(0, result.length, ...detail);
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
  if (targetArea === 0) path.length = 0;
  return { path, toLand, toWater, anchors };
}
