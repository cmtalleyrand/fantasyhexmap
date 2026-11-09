import type { Point } from '../../shared/hex.js';
import type { PathCmd } from './prims.js';
import { pathPolylines } from './ice.js';
import { evenOddTest } from './coast.js';
import { areaCoverage } from './footprint.js';
import { localLakeShore } from './lakePassage.js';
import { BoundedMemo, renderCachesEnabled } from './cache.js';
import { hashNumbers128, hashText128 } from './hash.js';
import { profileCount } from './profile.js';
/** Local shoreline controls, in scene coordinates. */
export interface LakeShorePassage {
  centre: Point;
  junction: Point;
  normal: Point;
  mouths: Point[];
  width: number;
  outline: Point[];
  /** The land share wanted in `outline`, 0–1, or null for the natural shape. */
  land: number | null;
  /** True when the field's inside is land (an isthmus's neck); else it is water (a strait's channel). */
  landInside?: boolean;
  ink: number;
  rough: number;
  phase: number[];
}
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const segmentDistance = (p: Point, a: Point, b: Point) => {
  const x = b.x - a.x, y = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * x + (p.y - a.y) * y) / (x * x + y * y || 1)));
  return Math.hypot(p.x - a.x - x * t, p.y - a.y - y * t);
};
/** Blend two rounded headland tips into the existing lake's signed shore field. */
export function lakeShoreFields(original: PathCmd[], passages: LakeShorePassage[], size: number): PathCmd[] {
  let path = original;
  for (const spec of passages) {
    const result = passageContour(path, spec, size);
    const changed: PathCmd[] = result.flatMap(r => [...r.map((p, k): PathCmd => [k ? 'L' : 'M', p.x, p.y]), ['Z'] as PathCmd]);
    path = localLakeShore(path, changed, [spec.centre], size);
  }
  return path;
}

/**
 * The shore round one passage: two rounded headland tips a throat `spec.width` apart, the flanks
 * receding rapidly from them, blended into the signed distance field of `path` (whose inside, by
 * even-odd, is the kind that passes through: a strait's water, an isthmus's land) and fading back to
 * it by half a hex beyond the passage's own. Closed rings round that inside, local to the passage.
 */
export function passageContour(path: PathCmd[], spec: LakeShorePassage, size: number): Point[][] {
  // The contour reads the old shore only near the passage: its distance within `reach` of nodes up
  // to `pad` from the centre, and which side of it each node lies on. Kept by an exact fingerprint of
  // the shore segments that can reach a node, and of the side the centre lies on (within the box the
  // side changes only across those segments), so that an edit elsewhere does not redraw it.
  const rings = pathPolylines(path, 12), water = evenOddTest(rings, size / 8);
  if (!renderCachesEnabled()) return contourOf(rings, water, spec, size);
  const margin = size * (1.9 + .7 + .5), { x: cx, y: cy } = spec.centre, near: number[][] = [];
  for (const ring of rings)
    for (let k = 1; k < ring.length; k++) {
      const a = ring[k - 1]!, b = ring[k]!;
      if (Math.max(a.x, b.x) < cx - margin || Math.min(a.x, b.x) > cx + margin
        || Math.max(a.y, b.y) < cy - margin || Math.min(a.y, b.y) > cy + margin) continue;
      near.push([a.x, a.y, b.x, b.y]);
    }
  near.sort((p, q) => p[0]! - q[0]! || p[1]! - q[1]! || p[2]! - q[2]! || p[3]! - q[3]!);
  const key = `${hashText128(JSON.stringify([spec, size, water(spec.centre)]))}/${hashNumbers128(near.flat())}`;
  const hit = contours.get(key);
  if (hit) { profileCount('passage.contourKept'); return hit; }
  profileCount('passage.contourBuilt');
  const result = contourOf(rings, water, spec, size);
  contours.set(key, result, result.reduce((n, ring) => n + ring.length * 48, 0));
  return result;
}
const contours = new BoundedMemo<Point[][]>(64, 8_000_000);

function contourOf(rings: Point[][], water: (p: Point) => boolean, spec: LakeShorePassage, size: number): Point[][] {
  {
    const cell = size / 4, reach = size * .7;
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
    // Shore detail is a distance displacement, independent of headland depth.
    // Multiplying the headland profile made detail either disappear at the
    // tips or grow into large spikes on the outer flanks.
    const shoreDetail = (u: number, v: number) => {
      const off = v > 0 ? 0 : 3, x = (u + v * .35) / size;
      const phase = spec.phase;
      if (spec.rough <= .04) return Math.sin(x * 7 + phase[off]!);
      const wave = (f: number, k: number) => {
        const value = Math.sin(x * f + phase[off + k]!);
        return spec.rough >= .12 ? Math.asin(value) * 2 / Math.PI : value;
      };
      return .6 * wave(11, 0) + .3 * wave(23, 1) + .1 * wave(41, 2);
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
      const t = Math.max(0, Math.min(1, (1.5 - d) / .5));
      const blend = t * t * (3 - 2 * t);
      return { p, u, v, centre, prime, blend, old: oldField(p), edge: i % n === 0 || i % n === n - 1 || i < n || i >= n * (n - 1) };
    });
    // Narrower throats take sharper tips (as a share of the hex radius): blunt ones would hold a thin
    // gap parallel for half a hex.
    const tip = Math.min(.48, .3 + .35 * spec.width / size);
    const offCentre = Math.min(1, distance(spec.junction, spec.centre) / size / .6);
    const fadeFrom = .5 + 1.5 * (1 - offCentre);
    const draw = (depth: number) => {
      const values = nodes.map(node => {
        if (node.edge)
          return -size;
        // Rounded headland tips: a short curved nose, then rapidly receding
        // flanks. Noise varies each flank without serrating the tip itself.
        const radius = size * (tip + .045 * Math.sin(spec.phase[node.v > node.centre ? 0 : 3]!));
        // A sharper tip curves away sooner than a blunt one (radius 0.48), its flanks receding at
        // the same rate. Where the throat is moved towards one side of the hex, the banks on the
        // other side are rooted far from it and must not be cut back off their roots: there the
        // flanks return to the blunt tip's from half a hex out (fully so once the throat is 0.6
        // radii off centre).
        const blunt = depth * (Math.sqrt(1 + (node.u / (radius + size * (.48 - tip))) ** 2) - 1);
        const sharp = depth * (Math.sqrt(1 + (node.u / radius) ** 2) - 1) * radius / (size * .48);
        const near = Math.max(0, Math.min(1, (fadeFrom - Math.abs(node.u) / size) / .5 + 1));
        const growth = blunt + (sharp - blunt) * near * near * (3 - 2 * near);
        // Detail fades in over the flank beyond the tip, a span in proportion to the tip.
        const tipFade = Math.max(0, Math.min(1, (Math.abs(node.u) / size - .2 * tip) / (.45 * tip)));
        const half = spec.width / 2 * Math.sqrt(1 + node.prime * node.prime) + growth;
        // Never more than half the passage's half-width, so that detail cannot pinch it shut.
        const detail = Math.max(-half / 2, Math.min(half / 2, shoreDetail(node.u, node.v - node.centre) * spec.rough * size * 1.7
          * tipFade * tipFade * (3 - 2 * tipFade)));
        const channel = (half - Math.abs(node.v - node.centre)) / Math.sqrt(1 + node.prime * node.prime) + detail;
        const f = node.old + (channel - node.old) * node.blend;
        const floor = (spec.width / 2 * Math.sqrt(1 + node.prime * node.prime) + size * .05 * (node.u / size) ** 2 - Math.abs(node.v - node.centre)) / Math.sqrt(1 + node.prime * node.prime);
        const safe = Math.min(floor, size * 1.45 - distance(node.p, spec.centre));
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
    let depth = size * .75, result = draw(depth);
    // Fit the area requested by varying headland depth. The lower bound keeps
    // the constriction short (the banks part by a quarter hex within 0.4 radii
    // of the tips): a share beyond it is left short, and reported, rather than
    // flattening both tips into a canal. That bound is what limits the share a
    // passage of each width can take while still looking like one.
    if (spec.land !== null) {
      const page = [{ x: x0, y: y0 }, { x: x0 + pad * 2, y: y0 },
        { x: x0 + pad * 2, y: y0 + pad * 2 }, { x: x0, y: y0 + pad * 2 }];
      const area = 1.5 * Math.sqrt(3) * size * size;
      // Coastline ink counts as land on either side of the shore.
      const share = (rs: Point[][]) => areaCoverage(spec.landInside ? rs : [page, ...rs],
        { evenOdd: true, stroke: { rings: rs, reach: spec.ink } })(spec.outline, 96) / area;
      // The least depth at which each bank recedes by an eighth of a hex 0.4 radii from its tip (the
      // throat opening by a quarter hex), with a third to spare for the shore detail.
      const shallowest = size * .125 * 1.3 * .48 / (tip - .045) / (Math.sqrt(1 + (.4 / (tip - .045)) ** 2) - 1);
      let best = Math.abs(share(result) - spec.land), low = shallowest, high = size * 4;
      for (let k = 0; k < 13 && best > .003; k++) {
        const at = (low + high) / 2, trial = draw(at), shown = share(trial), miss = Math.abs(shown - spec.land);
        if (miss < best) {
          best = miss;
          depth = at;
          result = trial;
        }
        // Deeper tips give the inside more room: more land round an isthmus, less round a strait.
        if ((shown > spec.land) !== !!spec.landInside)
          low = at;
        else
          high = at;
      }
    }
    return result;
  }
}
