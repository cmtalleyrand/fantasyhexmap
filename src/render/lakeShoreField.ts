import type { Point } from '../../shared/hex.js';
import type { PathCmd } from './prims.js';
import { pathPolylines } from './ice.js';
import { evenOddTest } from './coast.js';
import { areaCoverage } from './footprint.js';
import { localLakeShore } from './lakePassage.js';
/** Local shoreline controls, in scene coordinates. */
export interface LakeShorePassage {
  centre: Point;
  junction: Point;
  normal: Point;
  rootEdges: Array<[Point, Point]>;
  mouths: Point[];
  width: number;
  outline: Point[];
  land: number | null;
  ink: number;
  rough: number;
  phase: number[];
}
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const segmentDistance = (p: Point, a: Point, b: Point) => {
  const x = b.x - a.x, y = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * x + (p.y - a.y) * y) / (x * x + y * y || 1)));
  return Math.hypot(p.x - a.x - x * t, p.y - a.y - y * t);
};
const smoothMin = (a: number, b: number, k: number) => Math.min(a, b) - Math.max(0, k - Math.abs(a - b)) ** 2 / (4 * k);
/** Blend a curved, flaring passage into the existing lake's signed shore field. */
export function lakeShoreFields(original: PathCmd[], passages: LakeShorePassage[], size: number): PathCmd[] {
  let path = original;
  for (const spec of passages) {
    const rings = pathPolylines(path, 12), water = evenOddTest(rings, size / 8), cell = size / 4, reach = size * .7;
    const buckets = new Map<string, Array<[Point, Point]>>();
    for (const ring of rings)
      for (let k = 1; k < ring.length; k++) {
        const a = ring[k - 1]!, b = ring[k]!;
        for (let x = Math.floor((Math.min(a.x, b.x) - reach) / cell); x <= Math.floor((Math.max(a.x, b.x) + reach) / cell); x++)
          for (let y = Math.floor((Math.min(a.y, b.y) - reach) / cell); y <= Math.floor((Math.max(a.y, b.y) + reach) / cell); y++) {
            const key = `${x},${y}`, list = buckets.get(key);
            if (list)
              list.push([a, b]);
            else
              buckets.set(key, [[a, b]]);
          }
      }
    const oldField = (p: Point) => {
      let d = reach;
      for (const [a, b] of buckets.get(`${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`) ?? [])
        d = Math.min(d, segmentDistance(p, a, b));
      return water(p) ? d : -d;
    };
    // Curve through the two water mouths with a level tangent at the throat.
    const tangent = { x: spec.normal.y, y: -spec.normal.x };
    const projected = spec.mouths.map(p => {
      const u = (p.x - spec.junction.x) * tangent.x + (p.y - spec.junction.y) * tangent.y;
      return { u: Math.sign(u) * Math.max(Math.abs(u), size * .8), v: (p.x - spec.junction.x) * spec.normal.x + (p.y - spec.junction.y) * spec.normal.y };
    });
    const a = projected[0]!, b = projected[1]!;
    let c3 = (a.v / (a.u * a.u) - b.v / (b.u * b.u)) / (a.u - b.u), c2 = a.v / (a.u * a.u) - c3 * a.u;
    const steep = Math.max(...Array.from({ length: 21 }, (_, k) => { const u = (k / 10 - 1) * size; return Math.abs(2 * c2 * u + 3 * c3 * u * u); }));
    if (steep > .3) {
      c2 *= .3 / steep;
      c3 *= .3 / steep;
    }
    const noise = (u: number, side: number) => {
      const off = side > 0 ? 0 : 3, x = u / size;
      return .6 * Math.sin(x * 4.1 + spec.phase[off]!) + .27 * Math.sin(x * 10.3 + spec.phase[off + 1]!) + .13 * Math.sin(x * 21.7 + spec.phase[off + 2]!);
    };
    // Sample only the local edit. The old signed distance field keeps existing
    // coves and headlands as influence fades towards the surrounding lake.
    const step = size / 50, pad = size * 1.9, n = Math.ceil(pad * 2 / step) + 1, x0 = spec.centre.x - pad, y0 = spec.centre.y - pad;
    const nodes = Array.from({ length: n * n }, (_, i) => {
      const p = { x: x0 + (i % n) * step, y: y0 + Math.floor(i / n) * step };
      const u = (p.x - spec.junction.x) * tangent.x + (p.y - spec.junction.y) * tangent.y;
      const v = (p.x - spec.junction.x) * spec.normal.x + (p.y - spec.junction.y) * spec.normal.y;
      const limited = Math.max(-size * 1.25, Math.min(size * 1.25, u));
      const curve = c2 * limited * limited + c3 * limited ** 3, prime = 2 * c2 * limited + 3 * c3 * limited * limited;
      const centre = curve + (u - limited) * prime;
      const d = distance(p, spec.centre) / size;
      const t = Math.max(0, Math.min(1, (1.5 - d) / (spec.land !== null && spec.land > .65 ? .45 : .5)));
      const j = Math.max(0, Math.min(1, (1.9 - distance(p, spec.junction) / size) / 1.35));
      const blend = t * t * (3 - 2 * t) * (spec.land !== null && spec.land > .65 ? 1 : j * j * (3 - 2 * j));
      let root = Infinity;
      for (const [aa, bb] of spec.rootEdges) {
        const pin = { x: (aa.x + bb.x) / 2, y: (aa.y + bb.y) / 2 }, end = { x: pin.x * 2 - spec.centre.x, y: pin.y * 2 - spec.centre.y };
        root = Math.min(root, segmentDistance(p, pin, end) - size * .1);
      }
      return { p, u, v, centre, prime, blend, root, old: oldField(p), edge: i % n === 0 || i % n === n - 1 || i < n || i >= n * (n - 1) };
    });
    const draw = (flare: number) => {
      const values = nodes.map(node => {
        if (node.edge)
          return -size;
        const growth = flare * (node.u / size) ** 2;
        const bank = growth * Math.exp(noise(node.u, node.v - node.centre) * spec.rough * 10);
        const half = spec.width / 2 * Math.sqrt(1 + node.prime * node.prime) + bank;
        const channel = (half - Math.abs(node.v - node.centre)) / Math.sqrt(1 + node.prime * node.prime);
        const shaped = smoothMin(channel, node.root, size * .07);
        const f = node.old + (shaped - node.old) * node.blend;
        const floor = (spec.width / 2 * Math.sqrt(1 + node.prime * node.prime) + size * .05 * (node.u / size) ** 2 - Math.abs(node.v - node.centre)) / Math.sqrt(1 + node.prime * node.prime);
        const safe = Math.min(floor, node.root, size * 1.45 - distance(node.p, spec.centre));
        return Math.max(f, safe, spec.width / 2 - distance(node.p, spec.junction));
      });
      // March triangles (rather than ambiguous four-corner squares), orienting
      // each segment with water on the same side before assembling closed rings.
      const key = (p: Point) => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)}`;
      const segments: Array<{
        a: Point;
        b: Point;
        used: boolean;
      }> = [], from = new Map<string, number[]>();
      const triangle = (ids: number[]) => {
        const cut: Point[] = [];
        let positive: Point | undefined;
        for (let k = 0; k < 3; k++) {
          const i = ids[k]!, j = ids[(k + 1) % 3]!, f = values[i]!, g = values[j]!, a = nodes[i]!.p, b = nodes[j]!.p;
          if (f > 0)
            positive = a;
          if ((f > 0) === (g > 0))
            continue;
          const t = f / (f - g);
          cut.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        }
        if (cut.length !== 2 || !positive)
          return;
        let [a, b] = cut as [Point, Point];
        if ((b.x - a.x) * (positive.y - a.y) - (b.y - a.y) * (positive.x - a.x) < 0)
          [a, b] = [b, a];
        if (distance(a, b) < 1e-7)
          return;
        const id = segments.length;
        segments.push({ a, b, used: false });
        const k = key(a), list = from.get(k);
        if (list)
          list.push(id);
        else
          from.set(k, [id]);
      };
      for (let y = 0; y < n - 1; y++)
        for (let x = 0; x < n - 1; x++) {
          const i = y * n + x;
          triangle([i, i + 1, i + n + 1]);
          triangle([i, i + n + 1, i + n]);
        }
      const out: Point[][] = [];
      for (const first of segments) {
        if (first.used)
          continue;
        const ring = [first.a];
        let at = first;
        while (!at.used) {
          at.used = true;
          ring.push(at.b);
          const next = from.get(key(at.b))?.find(i => !segments[i]!.used);
          if (next === undefined)
            break;
          at = segments[next]!;
        }
        if (ring.length > 3) {
          if (distance(ring[0]!, ring.at(-1)!) > 1e-5)
            ring.push(ring[0]!);
          out.push(ring);
        }
      }
      return out;
    };
    let flare = size * .18 + spec.width * .1, result = draw(flare);
    // Fit area on the painted outline, including coastline ink. Flare changes
    // the banks away from the throat without changing its requested width.
    if (spec.land !== null) {
      const page = [{ x: x0, y: y0 }, { x: x0 + pad * 2, y: y0 },
        { x: x0 + pad * 2, y: y0 + pad * 2 }, { x: x0, y: y0 + pad * 2 }];
      const area = 1.5 * Math.sqrt(3) * size * size;
      const share = (rs: Point[][]) => areaCoverage([page, ...rs], { evenOdd: true, stroke: { rings: rs, reach: spec.ink } })(spec.outline, 96) / area;
      let best = Math.abs(share(result) - spec.land), low = 0, high = size * 20;
      for (let k = 0; k < 13 && best > .003; k++) {
        const at = (low + high) / 2, trial = draw(at), shown = share(trial), miss = Math.abs(shown - spec.land);
        if (miss < best) {
          best = miss;
          flare = at;
          result = trial;
        }
        if (shown > spec.land)
          low = at;
        else
          high = at;
      }
    }
    const changed: PathCmd[] = result.flatMap(r => [...r.map((p, k): PathCmd => [k ? 'L' : 'M', p.x, p.y]), ['Z'] as PathCmd]);
    path = localLakeShore(path, changed, [spec.centre], size);
  }
  return path;
}
