/**
 * Refitting only the coast near an edit (performance plan R2; DECISIONS §94). The previous
 * build's fit is kept, as it was drawn, wherever the coast it was fitted on is unchanged; only
 * a window round each changed stretch is cut out, as an open stretch with fixed ends, and
 * refitted (`fitCoastAreas` with `windows`). The result depends on the edits that led to it,
 * which §91 allows for the coast, provided the difference from a fresh build is not visible and
 * the shares hold.
 */
import { hexCenter, type Point } from '../../shared/hex.js';
import { detailKey } from './componentCoast.js';
import { nearestHex } from './footprint.js';
import { profileCount } from './profile.js';

/** What one fit took and gave, for the next edit's windows. */
export interface CoastFitRecord {
  /** Each ring the fit was given, as a polyline. */
  inputs: Point[][];
  /** The same rings as the fit left them. */
  outputs: Point[][];
  closed: boolean[];
  targets: ReadonlyMap<number, { share: number; width?: number }>;
  /** Each hex's shape settings (see `cachedCoastFit`): an edit to them alone changes no target. */
  shapes?: ReadonlyMap<number, string>;
  /** The held-back detail of the output's points (see `Roughness.deferDetail`). */
  detail?: ReadonlyMap<string, number>;
  /** The arc to each point of each input ring, built when first needed. */
  arcs?: Map<number, Float64Array>;
  /** Each input ring by its length, first and middle points, built when first needed. */
  signatures?: Map<string, number>;
  /** Grids of the inputs' points and the outputs' segments, built when first needed. */
  index?: { cell: number; inputs: Map<number, number[]>; outputs: Map<number, number[]> };
}

export interface CoastWindowPlan {
  /** The coast each ring starts from: the previous fit outside its windows, the new coast in them. */
  rings: Map<number, Point[]>;
  /** The stretches to refit, as index ranges (ends included) into `rings`. A ring without any is kept. */
  windows: Map<number, Array<[number, number]>>;
  /** Rings changed over most of their length, refitted whole from the new trace. */
  whole: Set<number>;
  /** Held-back detail for the starting rings' points, with the given detail of other rings. */
  detail?: Map<string, number>;
}

/** A point of the new coast with no point of the old within this (in hex sizes) is new coast. */
const NEW = 1;
/** How near the new trace must run to the old fit for a window to end there, in hex sizes. */
const NEAR = 0.12;
/** How far from the old fit a window's end may be found, in hex sizes. */
const SNAP = 1.5;
/** How much coast either side of a change is refitted with it, in hex widths. */
const WINDOW_HEXES = 2.5;
/** A ring refitted over more than this share of its points is fitted whole instead. */
const MOST = 0.6;

/** Detail found in each of `layers` in turn, without copying them: only `get` and `has` answer. */
class LayeredDetail extends Map<string, number> {
  constructor(private readonly layers: Array<ReadonlyMap<string, number> | undefined>) { super(); }
  override get(key: string): number | undefined {
    for (const layer of this.layers) { const offset = layer?.get(key); if (offset !== undefined) return offset; }
    return undefined;
  }
  override has(key: string): boolean { return this.get(key) !== undefined; }
}

/** Why a ring could not be spliced (and was refitted whole), counted in the render profile. */
const fail = (reason: string): null => { profileCount(`coast.windowSpliceFailed.${reason}`); return null; };
/** Where a point of the new trace meets the old fit: the old ring, segment, place along it, point and distance. */
type Fit = { r: number; seg: number; t: number; q: Point; d: number };
const cellKey = (x: number, y: number) => (x + 1048576) * 2097152 + (y + 1048576);
const core = (ring: Point[], closed: boolean) =>
  closed && ring.length > 1 && ring[0]!.x === ring.at(-1)!.x && ring[0]!.y === ring.at(-1)!.y ? ring.slice(0, -1) : ring;

function indexOf(record: CoastFitRecord, size: number): NonNullable<CoastFitRecord['index']> {
  if (record.index) return record.index;
  const cell = size * 0.5, inputs = new Map<number, number[]>(), outputs = new Map<number, number[]>();
  const add = (grid: Map<number, number[]>, key: number, r: number, j: number) => {
    const list = grid.get(key);
    if (list) list.push(r, j); else grid.set(key, [r, j]);
  };
  record.inputs.forEach((ring, r) => ring.forEach((p, j) => add(inputs, cellKey(Math.floor(p.x / cell), Math.floor(p.y / cell)), r, j)));
  record.outputs.forEach((ring, r) => {
    for (let j = 0; j + 1 < ring.length; j++) {
      const a = ring[j]!, b = ring[j + 1]!;
      for (let x = Math.floor(Math.min(a.x, b.x) / cell); x <= Math.floor(Math.max(a.x, b.x) / cell); x++)
        for (let y = Math.floor(Math.min(a.y, b.y) / cell); y <= Math.floor(Math.max(a.y, b.y) / cell); y++) add(outputs, cellKey(x, y), r, j);
    }
  });
  record.index = { cell, inputs, outputs };
  return record.index;
}

/** The old input ring that is exactly `ring` (as a polyline, without a closing point), or -1. */
function identical(record: CoastFitRecord, ring: Point[]): number {
  const sign = (r: Point[]) => r.length ? `${r.length}:${r[0]!.x},${r[0]!.y}:${r[r.length >> 1]!.x},${r[r.length >> 1]!.y}` : '';
  record.signatures ??= new Map(record.inputs.map((input, r) => [sign(core(input, record.closed[r]!)), r]));
  const r = record.signatures.get(sign(ring));
  if (r === undefined) return -1;
  const old = core(record.inputs[r]!, record.closed[r]!);
  return old.every((p, j) => p.x === ring[j]!.x && p.y === ring[j]!.y) ? r : -1;
}

/** The ring of the previous input nearest `p`, within `limit`, or -1. */
function nearestInput(record: CoastFitRecord, size: number, p: Point, limit: number): number {
  const at = nearestInputPoint(record, size, p, limit);
  return at < 0 ? -1 : Math.floor(at / POINTS);
}

/** The previous input point nearest `p`, within `limit`, as ring × POINTS + index, or -1. */
const POINTS = 1 << 20;
function nearestInputPoint(record: CoastFitRecord, size: number, p: Point, limit: number): number {
  const { cell, inputs } = indexOf(record, size);
  const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell), reach = Math.ceil(limit / cell);
  let best = limit * limit, at = -1;
  for (let x = cx - reach; x <= cx + reach; x++) for (let y = cy - reach; y <= cy + reach; y++) {
    const list = inputs.get(cellKey(x, y));
    if (list) for (let n = 0; n < list.length; n += 2) {
      const q = record.inputs[list[n]!]![list[n + 1]!]!, d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d <= best) { best = d; at = list[n]! * POINTS + list[n + 1]!; }
    }
  }
  return at;
}

/** The arc along old input ring `r` to each of its points, kept with the record. */
function inputArcs(record: CoastFitRecord, r: number): Float64Array {
  record.arcs ??= new Map();
  let arcs = record.arcs.get(r);
  if (!arcs) {
    const ring = record.inputs[r]!;
    arcs = new Float64Array(ring.length);
    for (let j = 1; j < ring.length; j++) arcs[j] = arcs[j - 1]! + Math.hypot(ring[j]!.x - ring[j - 1]!.x, ring[j]!.y - ring[j - 1]!.y);
    record.arcs.set(r, arcs);
  }
  return arcs;
}

/** The point of output ring `r` nearest `p`, within `limit`: its segment, place along it and position. */
function nearestOutput(record: CoastFitRecord, size: number, r: number, p: Point, limit: number): { seg: number; t: number; q: Point } | null {
  const { cell, outputs } = indexOf(record, size);
  const reach = Math.ceil(limit / cell), cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
  const ring = record.outputs[r]!;
  let best = limit * limit, hit: { seg: number; t: number; q: Point } | null = null;
  for (let x = cx - reach; x <= cx + reach; x++) for (let y = cy - reach; y <= cy + reach; y++) {
    const list = outputs.get(cellKey(x, y));
    if (list) for (let n = 0; n < list.length; n += 2) {
      if (list[n] !== r) continue;
      const j = list[n + 1]!, a = ring[j]!, b = ring[j + 1]!;
      const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
      const q = { x: a.x + dx * t, y: a.y + dy * t }, d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d < best) { best = d; hit = { seg: j, t, q }; }
    }
  }
  return hit;
}

/** Every point of output ring `r` within `limit` of `p` that is nearest on its own stretch of
 * the ring (segments more than a few apart), nearest first. */
function outputsNear(record: CoastFitRecord, size: number, r: number, p: Point, limit: number): Array<{ seg: number; t: number; q: Point; d: number }> {
  const { cell, outputs } = indexOf(record, size);
  const reach = Math.ceil(limit / cell), cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
  const ring = record.outputs[r]!, all: Array<{ seg: number; t: number; q: Point; d: number }> = [], seen = new Set<number>();
  for (let x = cx - reach; x <= cx + reach; x++) for (let y = cy - reach; y <= cy + reach; y++) {
    const list = outputs.get(cellKey(x, y));
    if (list) for (let n = 0; n < list.length; n += 2) {
      if (list[n] !== r || seen.has(list[n + 1]!)) continue;
      const j = list[n + 1]!, a = ring[j]!, b = ring[j + 1]!;
      seen.add(j);
      const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
      const q = { x: a.x + dx * t, y: a.y + dy * t }, d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d <= limit) all.push({ seg: j, t, q, d });
    }
  }
  all.sort((u, v) => u.d - v.d);
  const out: typeof all = [];
  for (const c of all) if (out.every(o => Math.abs(o.seg - c.seg) > 8)) out.push(c);
  return out;
}

/** Of `records`, the one whose inputs best match `inputs` (most of a sample of points within reach), if most match. */
export function matchingRecord(records: CoastFitRecord[], inputs: Point[][], size: number): CoastFitRecord | undefined {
  const sample = inputs.flatMap(ring => ring.filter((_, j) => j % 97 === 0));
  if (!sample.length) return undefined;
  let best: CoastFitRecord | undefined, score = 0.5;
  for (const record of records) {
    const matched = sample.filter(p => nearestInput(record, size, p, size * NEAR) >= 0).length / sample.length;
    if (matched > score) { score = matched; best = record; }
  }
  return best;
}

/**
 * Where to refit `members` (rings of one coast group, as `inputs`) after an edit, from the
 * previous fit `record`; null where the coast changed too oddly to splice, and the group should
 * be fitted whole. `changed` holds the hexes whose share or width changed.
 *
 * A point of the new coast is changed if it lies in such a hex or has no point of the old
 * coast within `fresh` of it. Everything else keeps the old fit as drawn, even though the new
 * trace there may differ by up to about half a hex: the roughening places each feature at a
 * fraction of its whole ring, so any change to a ring's length slides its features (§94). The
 * window round each changed stretch ends where the new trace runs close to the old fit, and
 * starts as the new trace, bent smoothly to meet the old fit at those ends.
 */
export function planCoastWindows(record: CoastFitRecord, inputs: Point[][], closed: boolean[], members: number[],
  changed: ReadonlySet<number>, cols: number, rows: number, size: number, detail?: ReadonlyMap<string, number>,
  /** How far (in hex sizes) a point must be from the old coast to count as new: a hex for a fit
   * of a fresh trace, whose features slide; next to nothing for a fit whose input is the
   * output of an earlier windowed fit, which is unchanged outside that fit's windows. */
  fresh = NEW): CoastWindowPlan | null {
  const centres = Array.from({ length: cols * rows }, (_, h) => hexCenter(h % cols, Math.floor(h / cols), size));
  // Each point's old ring (-1 if it is new coast) and hex, found once.
  const found = new Map<number, { owner: number[]; hexes: number[]; jump: boolean[]; fits: Map<number, Fit | null> }>();
  const pointsOf = (k: number, P: Point[]) => {
    let hit = found.get(k);
    if (!hit) {
      // A ring given exactly as before (a component the trace took from its cache) is its old
      // ring throughout; otherwise nearly every point has an old point close by: look there first.
      const same = identical(record, P);
      const close = Math.min(fresh, 0.25) * size;
      const at = same >= 0 ? P.map((_, j) => same * POINTS + j) : P.map(p => {
        const near = nearestInputPoint(record, size, p, close);
        return near >= 0 || close >= fresh * size ? near : nearestInputPoint(record, size, p, size * fresh);
      });
      const owner = at.map(a => a < 0 ? -1 : Math.floor(a / POINTS));
      // A point is new coast, too, where the new coast stops following the old in order: where
      // consecutive points meet old points far apart along the old coast (or on different old
      // rings), as where an edit cuts a neck and the new coast passes close to the old across it.
      const jump = new Array<boolean>(P.length).fill(false);
      const n = P.length;
      for (let j = 0; j < (closed[k] ? n : n - 1); j++) {
        const i = (j + 1) % n, a = at[j]!, b = at[i]!;
        if (a < 0 || b < 0) continue;
        const r = owner[j]!;
        let apart = Infinity;
        if (owner[i] === r) {
          const arcs = inputArcs(record, r), u = arcs[a % POINTS]!, v = arcs[b % POINTS]!, total = arcs[arcs.length - 1]!;
          apart = Math.abs(u - v);
          if (record.closed[r]) apart = Math.min(apart, total - apart);
        }
        if (apart > Math.hypot(P[i]!.x - P[j]!.x, P[i]!.y - P[j]!.y) + size * 0.75) jump[j] = jump[i] = true;
      }
      hit = { owner, jump, hexes: P.map(p => nearestHex(p, cols, rows, size, centres)), fits: new Map() };
      found.set(k, hit);
    }
    return hit;
  };

  const attempt = (changed: ReadonlySet<number>): (CoastWindowPlan & { hot: Set<number>; movedOf: Map<number, boolean[]> }) | null => {
    const rings = new Map<number, Point[]>(), windows = new Map<number, Array<[number, number]>>(), whole = new Set<number>();
    // Detail for the replaced stretches' points, which take their new trace points' detail; the
    // rest of the starting coast is old fit or new trace as it was, whose detail is found in the
    // old fit's or the given (see the end).
    const added = new Map<string, number>();
    const keep = (p: Point, key: string) => {
      const offset = detail?.get(key);
      if (offset !== undefined) added.set(detailKey(p), offset);
    };
    const reach = size * Math.sqrt(3) * WINDOW_HEXES, near = size * NEAR, snap = size * SNAP;
    const hot = new Set<number>(), movedOf = new Map<number, boolean[]>();
    const refitWhole = (k: number, given: Point[], hexes: number[]) => {
      profileCount('coast.windowWholeRings');
      profileCount('coast.windowWholePoints', given.length);
      rings.set(k, given);
      whole.add(k);
      for (const h of hexes) hot.add(h);
    };
    next: for (const k of members) {
      const loop = closed[k]!, given = inputs[k]!, P = core(given, loop), n = P.length;
      if (given.length < 4) { rings.set(k, given); continue; } // never fitted; kept as given
      const { owner, jump, hexes } = pointsOf(k, P);
      const moved = P.map((_, j) => owner[j]! < 0 || jump[j]! || changed.has(hexes[j]!));
      movedOf.set(k, moved);
      const step = (j: number, by: number) => loop ? ((j + by) % n + n) % n : j + by;
      const gap = (j: number) => j + 1 < n || loop ? Math.hypot(P[(j + 1) % n]!.x - P[j]!.x, P[(j + 1) % n]!.y - P[j]!.y) : 0;
      if (!moved.some(Boolean)) {
        // Unchanged throughout: the previous fit, as it was.
        const votes = new Map<number, number>();
        for (const o of owner) votes.set(o, (votes.get(o) ?? 0) + 1);
        const [main = -1, count = 0] = [...votes].sort((x, y) => y[1] - x[1])[0] ?? [];
        // Unless it is not one old ring, or not all of it: then fitted whole.
        const before = count >= n * 0.95 && record.closed[main] === loop ? core(record.inputs[main]!, loop).length : -Infinity;
        if (Math.abs(before - n) > Math.max(4, n * 0.05)) { fail('oddRing'); refitWhole(k, given, hexes); continue; }
        rings.set(k, record.outputs[main]!);
        continue;
      }
      if (moved.every(Boolean)) { refitWhole(k, given, hexes); continue; }
      // Where each unchanged point of the new trace meets the old fit, found as needed.
      const fits = pointsOf(k, P).fits;
      const fitOf = (j: number) => {
        if (moved[j]) return null;
        if (!fits.has(j)) {
          const r = owner[j]!, hit = r < 0 ? null : nearestOutput(record, size, r, P[j]!, snap);
          fits.set(j, hit && { r, ...hit, d: Math.hypot(hit.q.x - P[j]!.x, hit.q.y - P[j]!.y) });
        }
        return fits.get(j)!;
      };
      // The changed stretches, in order round the ring from an unchanged point.
      const first = loop ? moved.indexOf(false) : 0;
      const runs: Array<{ from: number; to: number }> = [];
      for (let s = 0; s < n; s++) {
        const j = (first + s) % n;
        if (!moved[j]) continue;
        if (s && moved[step(j, -1)] && runs.length) runs.at(-1)!.to = j;
        else runs.push({ from: j, to: j });
      }
      // Each is replaced from the unchanged point before it to the one after, moved out (by up to
      // two hexes of coast) to where the new trace runs close to the old fit, so the new trace
      // bends little to meet it. An open coast's end, which never moves, serves as its own.
      const limit = size * Math.sqrt(3) * 2;
      const anchor = (j: number, by: 1 | -1): number | null => {
        if (!loop && (j < 0 || j >= n)) return null; // the page rim
        let best = -1, bestD = Infinity, arc = 0;
        for (let at = j, s = 0; s < n && arc <= limit; s++) {
          if (moved[at]) break;
          const d = fitOf(at)?.d ?? Infinity;
          if (d < bestD) { best = at; bestD = d; }
          if (bestD <= near) break;
          const next = step(at, by);
          if (!loop && (next < 0 || next >= n)) break;
          arc += gap(by > 0 ? at : next);
          at = next;
        }
        return best < 0 ? -1 : best;
      };
      const stretches: Array<{ from: number | null; to: number | null }> = [];
      for (const run of runs) {
        const from = anchor(step(run.from, -1), -1), to = anchor(step(run.to, 1), 1);
        if (from === -1 || to === -1) { fail('noAnchor'); refitWhole(k, given, hexes); continue next; }
        const last = stretches.at(-1);
        // Stretches whose anchors meet or cross are one.
        if (last && last.to !== null && from !== null && arcBetween(last.to, from) >= arcBetween(last.to, run.from)) { last.to = to; continue; }
        stretches.push({ from, to });
      }
      if (loop && stretches.length > 1) {
        const a = stretches.at(-1)!, b = stretches[0]!;
        if (arcBetween(a.to!, b.from!) >= arcBetween(a.to!, runs[0]!.from)) { b.from = a.from; stretches.pop(); }
      }
      function arcBetween(from: number, to: number) {
        let arc = 0;
        for (let j = from; j !== to; j = step(j, 1)) { arc += gap(j); if (!loop && j >= n - 1) return Infinity; }
        return arc;
      }
      // A stretch is the new trace from anchor to anchor, offset by an amount eased by arc from
      // where its first point meets the old fit to where its last does.
      const pieces = stretches.map(({ from, to }) => {
        const start = from ?? 0, end = to ?? n - 1, idx: number[] = [];
        for (let j = start; ; j = step(j, 1)) { idx.push(j); if (j === end || idx.length > n) break; }
        const arcs = [0];
        for (let i = 1; i < idx.length; i++) arcs.push(arcs[i - 1]! + gap(idx[i - 1]!));
        const offset = (j: number | null) => {
          const hit = j === null ? null : fitOf(j);
          return hit ? { dx: hit.q.x - P[j!]!.x, dy: hit.q.y - P[j!]!.y } : { dx: 0, dy: 0 };
        };
        const a = offset(from), b = offset(to), total = arcs.at(-1)! || 1;
        return { idx, points: idx.map((j, i) => {
          const t = arcs[i]! / total;
          return { x: P[j]!.x + a.dx + (b.dx - a.dx) * t, y: P[j]!.y + a.dy + (b.dy - a.dy) * t };
        }) };
      });
      const replaced = pieces.reduce((sum, piece) => sum + piece.idx.length, 0);
      if (replaced > n * MOST) { refitWhole(k, given, hexes); continue; }
      // Between stretches, the old fit's own points, from where one stretch meets it to where
      // the next does.
      // Where the old fit ran close to itself (both sides of a neck the edit cut), an anchor can
      // meet the wrong side: the place whose kept coast is as long as the new one it stands for wins.
      const between = (from: number | null, to: number | null): Point[] | null => {
        const first = keptPart(from, to);
        if (first !== 'length') return first;
        for (const [end, j] of [['to', to], ['from', from]] as const) {
          if (j === null) continue;
          const own = fitOf(j)!;
          for (const other of outputsNear(record, size, own.r, P[j]!, own.d + near)) {
            if (other.seg === own.seg) continue;
            const part = keptPart(from, to, end === 'to' ? undefined : { r: own.r, ...other }, end === 'to' ? { r: own.r, ...other } : undefined);
            if (Array.isArray(part)) { fits.set(j, { r: own.r, ...other }); return part; }
          }
        }
        return fail('keptLength');
      };
      /** The kept part, or why not: null if it cannot be kept, 'length' if these anchors do not fit it. */
      const keptPart = (from: number | null, to: number | null, atFrom?: Fit, atTo?: Fit): Point[] | null | 'length' => {
        // An open coast's kept end runs from its own end on the page rim, from where that meets
        // the old fit (the old ring may have started elsewhere, if the edit split it).
        const head = from === null ? fitOf(0) : null, tail = to === null ? fitOf(n - 1) : null;
        if ((from === null && (!head || head.d > near)) || (to === null && (!tail || tail.d > near))) return fail('openEnds');
        const a = atFrom ?? (from === null ? head : fitOf(from)), b = atTo ?? (to === null ? tail : fitOf(to));
        if (!a || !b) return fail('noAnchor');
        if (a.r !== b.r) return fail('twoOldRings');
        const r = a.r;
        const F = core(record.outputs[r]!, record.closed[r]!), m = F.length, wrap = record.closed[r]!;
        // The old ring's own order is followed, whether or not it was closed as the new one is (a
        // coast that met the page rim may now close, or the other way round).
        const start = a.seg + 1, end = b.seg + (b.t > 0 ? 0 : -1);
        let count = wrap ? (end - start + m) % m + 1 : end - start + 1;
        if (a.seg === b.seg && a.t <= b.t) count = 0;
        if (count < 0) return 'length';
        // From one place round a closed ring to a place just ahead of it is nothing or the whole
        // way round: the new coast it stands for says which.
        let now = 0;
        for (let j = from ?? 0, s = 0; j !== (to ?? n - 1) && s < n; j = step(j, 1), s++) now += gap(j);
        if (wrap && count < m / 2) {
          let perimeter = 0;
          for (let s = 0; s < m; s++) perimeter += Math.hypot(F[(s + 1) % m]!.x - F[s]!.x, F[(s + 1) % m]!.y - F[s]!.y);
          if (now > perimeter / 2) count += m;
        }
        const out: Point[] = [];
        if (from === null) out.push(P[0]!);
        for (let s = 0; s < count; s++) out.push(F[(start + s) % m]!);
        if (to === null) out.push(P[n - 1]!);
        // The kept coast is about as long as the new coast it stands for.
        let kept = 0;
        const ends = [a.q, ...out, b.q];
        for (let s = 1; s < ends.length; s++) kept += Math.hypot(ends[s]!.x - ends[s - 1]!.x, ends[s]!.y - ends[s - 1]!.y);
        if (Math.abs(kept - now) > now * 0.15 + size) return 'length';
        return out;
      };
      const ring: Point[] = [], refit: boolean[] = [];
      const push = (p: Point, fresh: boolean) => {
        const last = ring.at(-1);
        if (last && last.x === p.x && last.y === p.y) return false;
        ring.push(p);
        refit.push(fresh);
        return true;
      };
      const place = (w: number) => {
        pieces[w]!.points.forEach((p, i) => { if (push(p, true)) keep(p, detailKey(P[pieces[w]!.idx[i]!]!)); });
        for (const j of pieces[w]!.idx) if (moved[j]) hot.add(hexes[j]!);
      };
      const kept = (from: number | null, to: number | null) => {
        if (from !== null && to !== null && from === to) return true;
        const part = between(from, to);
        if (!part) return false;
        for (const p of part) push(p, false);
        return true;
      };
      const ends = (w: number) => stretches[w]!;
      if (loop) {
        for (let w = 0; w < stretches.length; w++) {
          place(w);
          if (!kept(ends(w).to, ends((w + 1) % stretches.length).from)) { refitWhole(k, given, hexes); continue next; }
        }
      } else {
        if (ends(0).from !== null && !kept(null, ends(0).from)) { refitWhole(k, given, hexes); continue next; }
        for (let w = 0; w < stretches.length; w++) {
          place(w);
          const next = w + 1 < stretches.length ? ends(w + 1).from : null;
          if (ends(w).to !== null && !kept(ends(w).to, next)) { refitWhole(k, given, hexes); continue next; }
        }
      }
      // The windows: each stretch with `reach` of coast either side, a closed ring's start moved
      // outside them so none wraps.
      const m = ring.length;
      const length = (j: number) => j + 1 < m || loop ? Math.hypot(ring[(j + 1) % m]!.x - ring[j]!.x, ring[(j + 1) % m]!.y - ring[j]!.y) : 0;
      const away = new Float64Array(m).fill(Infinity);
      for (let pass = 0, d = Infinity; pass < (loop ? 2 : 1); pass++) for (let j = 0; j < m; j++) {
        if (refit[j]) d = 0;
        away[j] = Math.min(away[j]!, d);
        d += length(j);
      }
      for (let pass = 0, d = Infinity; pass < (loop ? 2 : 1); pass++) for (let j = m - 1; j >= 0; j--) {
        if (refit[j]) d = 0;
        away[j] = Math.min(away[j]!, d);
        d += length((j - 1 + m) % m);
      }
      const inside = Array.from(away, d => d <= reach);
      if (inside.filter(Boolean).length > m * MOST || (loop && inside.every(Boolean))) { refitWhole(k, given, hexes); continue; }
      let out = ring, mask = inside;
      if (loop) {
        const start = inside.indexOf(false);
        out = [...ring.slice(start), ...ring.slice(0, start)];
        mask = [...inside.slice(start), ...inside.slice(0, start)];
        out.push(out[0]!);
        mask.push(false);
      }
      const list: Array<[number, number]> = [];
      mask.forEach((v, j) => {
        if (!v) return;
        if (j && mask[j - 1]) list.at(-1)![1] = j;
        else list.push([j, j]);
      });
      rings.set(k, out);
      windows.set(k, list.filter(([a, b]) => b - a >= 2));
    }
    const merged = detail || record.detail || added.size ? new LayeredDetail([added, record.detail, detail]) : undefined;
    return { rings, windows, whole, detail: merged, hot, movedOf };
  };
  // A change reaches every coast through the hexes it touches: a kept coast sharing a hex with
  // refitted coast is refitted there too, or that hex's share could be out of every fit's reach.
  let hot = new Set(changed);
  for (let pass = 0; ; pass++) {
    const plan = attempt(hot);
    if (!plan) return null;
    const added = [...plan.hot].filter(h => !hot.has(h));
    // Done when no coast kept so far runs through a hex the change newly reached.
    const reached = new Set(added);
    if (!added.length || pass === 3 || ![...found].some(([k, { hexes }]) => {
      const moved = plan.movedOf.get(k);
      return !plan.whole.has(k) && hexes.some((h, j) => reached.has(h) && !moved?.[j]);
    }))
      return { rings: plan.rings, windows: plan.windows, whole: plan.whole, detail: plan.detail };
    for (const h of added) hot.add(h);
  }

}
