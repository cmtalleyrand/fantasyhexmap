import type { PathCmd, Prim } from './prims.js';

// Retained after a 4.9% paired paint saving with no visible change (DECISIONS §84).
type BandPath = Extract<Prim, { kind: 'path' }>;
// Keep paint-only metadata off the serialized scene. Mark primitives, since a
// shared command array may also belong to a clip or a different kind of stroke.
const registered = new WeakMap<BandPath, number>();
const cached = new WeakMap<PathCmd[], { tolerance: number; d: PathCmd[] }>();

export function markBandLine<T extends BandPath>(prim: T, size: number): T {
  registered.set(prim, size * .006);
  return prim;
}

/** Douglas–Peucker on the band's linear runs; endpoints, curves and closures stay. */
export function paintBandLine(prim: BandPath): PathCmd[] {
  const d = prim.d, tolerance = registered.get(prim);
  if (tolerance === undefined) return d;
  const hit = cached.get(d);
  if (hit?.tolerance === tolerance) return hit.d;
  const out: PathCmd[] = [];
  let line: Array<Extract<PathCmd, ['M' | 'L', number, number]>> = [];
  const flush = () => {
    if (!line.length) return;
    const kept = new Uint8Array(line.length);
    kept[0] = kept[line.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, line.length - 1]];
    while (stack.length) {
      const [first, last] = stack.pop()!, a = line[first]!, b = line[last]!;
      const dx = b[1] - a[1], dy = b[2] - a[2], length2 = dx * dx + dy * dy;
      let farthest = -1, distance = tolerance * tolerance;
      for (let j = first + 1; j < last; j++) {
        const p = line[j]!;
        const t = length2 ? Math.max(0, Math.min(1, ((p[1] - a[1]) * dx + (p[2] - a[2]) * dy) / length2)) : 0;
        const x = p[1] - (a[1] + t * dx), y = p[2] - (a[2] + t * dy), d2 = x * x + y * y;
        if (d2 > distance) { distance = d2; farthest = j; }
      }
      if (farthest >= 0) {
        kept[farthest] = 1;
        stack.push([first, farthest], [farthest, last]);
      }
    }
    for (let j = 0; j < line.length; j++) if (kept[j]) out.push(line[j]!);
    line = [];
  };
  for (const command of d) {
    if (command[0] === 'M') { flush(); line.push(command); }
    else if (command[0] === 'L' && line.length) line.push(command);
    else { flush(); out.push(command); }
  }
  flush();
  cached.set(d, { tolerance, d: out });
  return out;
}
