import type { Point } from '../../shared/hex.js';
import type { PathCmd } from './prims.js';
import { pathPolylines } from './ice.js';
import { evenOddTest } from './coast.js';
import { untangle } from './coastArea.js';
/** Splice a passage into its lake without projecting across neighbouring bays. */
export function localLakeShore(original: PathCmd[], reshaped: PathCmd[], passages: Point[], size: number): PathCmd[] {
  type Arc = {
    points: Point[];
    closed: boolean;
  };
  const radius = size * 1.55;
  const inside = (p: Point) => passages.some(c => Math.hypot(p.x - c.x, p.y - c.y) < radius);
  const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const arcs: Arc[] = [];
  const cut = (path: PathCmd[], keepInside: boolean) => {
    for (const ring of pathPolylines(path, 12)) {
      const pieces: Point[][] = [];
      let current: Point[] = [];
      for (let k = 1; k < ring.length; k++) {
        const a = ring[k - 1]!, b = ring[k]!, dx = b.x - a.x, dy = b.y - a.y, aa = dx * dx + dy * dy;
        const ts = [0, 1];
        if (aa > 1e-12)
          for (const c of passages) {
            const x = a.x - c.x, y = a.y - c.y, bb = 2 * (x * dx + y * dy), cc = x * x + y * y - radius * radius, d = bb * bb - 4 * aa * cc;
            if (d <= 0)
              continue;
            for (const t of [(-bb - Math.sqrt(d)) / (2 * aa), (-bb + Math.sqrt(d)) / (2 * aa)])
              if (t > 1e-8 && t < 1 - 1e-8)
                ts.push(t);
          }
        ts.sort((a, b) => a - b);
        for (let j = 1; j < ts.length; j++) {
          const lo = ts[j - 1]!, hi = ts[j]!, mid = (lo + hi) / 2;
          if (inside({ x: a.x + dx * mid, y: a.y + dy * mid }) === keepInside) {
            if (!current.length)
              current.push({ x: a.x + dx * lo, y: a.y + dy * lo });
            current.push({ x: a.x + dx * hi, y: a.y + dy * hi });
          }
          else if (current.length) {
            pieces.push(current);
            current = [];
          }
        }
      }
      if (current.length)
        pieces.push(current);
      if (pieces.length > 1 && dist(pieces[0]![0]!, pieces[pieces.length - 1]!.at(-1)!) < 1e-5) {
        const last = pieces.pop()!;
        pieces[0] = [...last, ...pieces[0]!.slice(1)];
      }
      for (const points of pieces)
        arcs.push({ points, closed: dist(points[0]!, points.at(-1)!) < 1e-5 });
    }
  };
  cut(original, false);
  cut(reshaped, true);
  // The two contours can cross the edit boundary a different number of
  // times. Close their disagreement along that boundary; nearest-point
  // pairing alone can connect the wrong bay across the passage.
  const oldWater = evenOddTest(pathPolylines(original, 12), size / 8);
  const newWater = evenOddTest(pathPolylines(reshaped, 12), size / 8);
  for (const c of passages) {
    const ends = arcs.filter(a => !a.closed).flatMap(a => [a.points[0]!, a.points.at(-1)!])
      .filter(p => Math.abs(dist(p, c) - radius) < 1e-5)
      .map(p => ({ p, angle: Math.atan2(p.y - c.y, p.x - c.x) })).sort((a, b) => a.angle - b.angle);
    // Overlapping passage edits share boundary vertices where their circles
    // meet; the circle arcs inside the other edit are omitted below.
    for (const other of passages) {
      const d = dist(c, other);
      if (d < 1e-8 || d >= radius * 2)
        continue;
      const mx = (c.x + other.x) / 2, my = (c.y + other.y) / 2;
      const reach = Math.sqrt(radius * radius - d * d / 4);
      for (const sign of [-1, 1]) {
        const p = { x: mx - (other.y - c.y) / d * reach * sign, y: my + (other.x - c.x) / d * reach * sign };
        ends.push({ p, angle: Math.atan2(p.y - c.y, p.x - c.x) });
      }
    }
    ends.sort((a, b) => a.angle - b.angle);
    if (!ends.length)
      ends.push({ p: { x: c.x + radius, y: c.y }, angle: 0 });
    for (let i = 0; i < ends.length; i++) {
      const a = ends[i]!, b = ends[(i + 1) % ends.length]!;
      const sweep = (b.angle - a.angle + Math.PI * 2) % (Math.PI * 2) || (ends.length === 1 ? Math.PI * 2 : 0);
      if (sweep < 1e-8)
        continue;
      const angle = a.angle + sweep / 2, point = { x: c.x + radius * Math.cos(angle), y: c.y + radius * Math.sin(angle) };
      if (passages.some(other => other !== c && dist(point, other) < radius))
        continue;
      const old = oldWater(point), fresh = newWater(point);
      if (old === fresh)
        continue;
      const count = Math.max(1, Math.ceil(sweep * radius / (size / 30)));
      const points = Array.from({ length: count + 1 }, (_, k) => ({ x: c.x + radius * Math.cos(a.angle + sweep * k / count), y: c.y + radius * Math.sin(a.angle + sweep * k / count) }));
      points[0] = a.p;
      points[count] = b.p;
      if (old)
        points.reverse();
      arcs.push({ points, closed: ends.length === 1 });
    }
  }
  const result: PathCmd[] = [];
  while (arcs.length) {
    const arc = arcs.shift()!, points = [...arc.points];
    if (!arc.closed) {
      while (dist(points[0]!, points.at(-1)!) > 1e-5) {
        const end = points.at(-1)!;
        const next = arcs.findIndex(a => !a.closed && dist(end, a.points[0]!) < 1e-5);
        if (next < 0)
          break;
        points.push(...arcs.splice(next, 1)[0]!.points.slice(1));
      }
    }
    const clean = untangle(dist(points[0]!, points.at(-1)!) < 1e-5 ? points : [...points, points[0]!], true).ring;
    // Ease only the join to the existing lake. Keep the passage and the
    // shore beyond the edit boundary fixed.
    let sampled: Point[] = [];
    for (let k = 1; k < clean.length; k++) {
      const a = clean[k - 1]!, b = clean[k]!;
      const near = [a, b, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }].some(p => {
        const d = Math.min(...passages.map(c => dist(p, c))) / size;
        return d > 1 && d < 1.8;
      });
      const count = near ? Math.max(1, Math.ceil(dist(a, b) / (size / 60))) : 1;
      for (let j = 0; j < count; j++)
        sampled.push({ x: a.x + (b.x - a.x) * j / count, y: a.y + (b.y - a.y) * j / count });
    }
    for (let pass = 0; pass < 160; pass++)
      sampled = sampled.map((p, k) => {
        const d = Math.min(...passages.map(c => dist(p, c))) / size;
        const weight = d <= 1.05 || d >= 1.75 ? 0 : Math.min(1, (d - 1.05) / 0.2, (1.75 - d) / 0.2) * 0.4;
        const a = sampled[(k + sampled.length - 1) % sampled.length]!, b = sampled[(k + 1) % sampled.length]!;
        return { x: p.x + (a.x + b.x - 2 * p.x) * weight, y: p.y + (a.y + b.y - 2 * p.y) * weight };
      });
    result.push(...sampled.map((p, k): PathCmd => [k ? 'L' : 'M', p.x, p.y]), ['Z']);
  }
  return result;
}
