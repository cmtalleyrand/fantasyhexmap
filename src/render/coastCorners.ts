import type { Point } from '../../shared/hex.js';

/** Round only the joins introduced by deleting a fold-back loop. Original
 * coastline detail remains intact. Call after tangential skew, before fitting area,
 * so the skew cannot sharpen this repair again.
 */
export function roundLoopJoins(input: Point[], closed: boolean, joins: Point[], radius: number,
  allowed: (p: Point) => boolean, otherRings: Point[][] = []): Point[] {
  if (!joins.length || radius <= 0) return input;
  const cross = (a: Point, b: Point, c: Point) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  const intersects = (a: Point, b: Point, c: Point, d: Point) =>
    cross(a,b,c)*cross(a,b,d)<-1e-8 && cross(c,d,a)*cross(c,d,b)<-1e-8;
  let points = closed ? input.slice(0, -1) : input.slice();
  for (const join of joins) {
    let at = points.findIndex(p => Math.hypot(p.x - join.x, p.y - join.y) < 1e-7);
    if (at < 0 || !allowed(join)) continue;
    if (closed) {
      const start = (at + Math.floor(points.length / 2)) % points.length;
      points = [...points.slice(start), ...points.slice(0, start)];
      at = (at - start + points.length) % points.length;
    }
    if (at === 0 || at === points.length - 1) continue;
    const trim = (direction: number) => {
      let index = at, remaining = radius;
      while (index + direction >= 0 && index + direction < points.length) {
        const a = points[index]!, b = points[index + direction]!;
        const length = Math.hypot(b.x - a.x, b.y - a.y);
        if (length >= remaining && length > 0) return { index, point: {
          x: a.x + (b.x - a.x) * remaining / length,
          y: a.y + (b.y - a.y) * remaining / length,
        } };
        remaining -= length; index += direction;
      }
      return { index, point: points[index]! };
    };
    const left = trim(-1), right = trim(1);
    if (left.index === at || right.index === at) continue;
    const curve: Point[] = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8, u = 1 - t;
      curve.push({ x: u*u*left.point.x + 2*u*t*join.x + t*t*right.point.x,
        y: u*u*left.point.y + 2*u*t*join.y + t*t*right.point.y });
    }
    // A fillet must not enter a protected passage or cross retained coastline.
    if (curve.some((p,i) => !allowed(p) || (i>0 && !allowed({x:(p.x+curve[i-1]!.x)/2,y:(p.y+curve[i-1]!.y)/2})))) continue;
    let crossing = false;
    for (let k=0;k+1<curve.length&&!crossing;k++) {
      const a=curve[k]!,b=curve[k+1]!;
      for(let j=0;j<(closed?points.length:points.length-1);j++) {
        if(j>=left.index-1 && j<=right.index)continue;
        if(intersects(a,b,points[j]!,points[(j+1)%points.length]!)){crossing=true;break;}
      }
      for(const ring of otherRings)for(let j=0;j+1<ring.length&&!crossing;j++)
        if(intersects(a,b,ring[j]!,ring[j+1]!))crossing=true;
    }
    if (!crossing) points = [...points.slice(0, left.index), ...curve, ...points.slice(right.index + 1)];
  }
  return closed ? [...points, points[0]!] : points;
}
