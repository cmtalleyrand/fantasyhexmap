/**
 * The rim of the map.
 *
 * A hex grid cut to a rectangle leaves half-hex notches along the left and
 * right edges and a row of small triangles along the top and bottom, where no
 * hex reaches the page's edge. Left bare they show the page colour whatever
 * the map has there (a pale band of pack ice ends in teal teeth). Each notch
 * is instead given to the border hex beside it: the hex's edge facing off the
 * map is extruded straight out to the rim, so a coast, an ice edge or a
 * realm's land simply runs on to the edge of the page.
 */

import { hexEdgePoints, inBounds, neighbourOf, type Point } from '../../shared/hex.js';
import type { PathCmd } from './prims.js';
import { pathPolylines } from './ice.js';

export interface RimBounds {
  width: number;
  height: number;
}

export interface RimPiece {
  /** The hex edge (0-5) the piece is an extension of. */
  edge: number;
  points: Point[];
}

/** The side of the page nearest a point: 0 top, 1 right, 2 bottom, 3 left. */
function nearestSide(p: Point, { width, height }: RimBounds): number {
  const gaps = [p.y, width - p.x, height - p.y, p.x];
  return gaps.indexOf(Math.min(...gaps));
}

/** Where a point lands on the rim when pushed straight to the nearest side of the page. */
export function projectToRim(p: Point, bounds: RimBounds): Point {
  const side = nearestSide(p, bounds);
  if (side === 0) return { x: p.x, y: 0 };
  if (side === 1) return { x: bounds.width, y: p.y };
  if (side === 2) return { x: p.x, y: bounds.height };
  return { x: 0, y: p.y };
}

/** The page corner between two adjacent sides. */
function cornerBetween(a: number, b: number, { width, height }: RimBounds): Point {
  const sides = new Set([a, b]);
  const right = sides.has(1);
  const bottom = sides.has(2);
  return { x: right ? width : 0, y: bottom ? height : 0 };
}

/**
 * The pieces of rim a border hex owns: for each of its edges that faces off
 * the map, the strip between that edge and the page's edge. Empty for a hex
 * with no edge off the map.
 */
export function rimPieces(cols: number, rows: number, size: number, col: number, row: number, bounds: RimBounds): RimPiece[] {
  const out: RimPiece[] = [];
  for (let e = 0; e < 6; e++) {
    const n = neighbourOf(col, row, e);
    if (inBounds(cols, rows, n.col, n.row)) continue;
    const [a, b] = hexEdgePoints(col, row, e, size);
    const pa = projectToRim(a, bounds);
    const pb = projectToRim(b, bounds);
    const points: Point[] = [a, b, pb];
    const sa = nearestSide(a, bounds);
    const sb = nearestSide(b, bounds);
    if (sa !== sb) points.push(cornerBetween(sa, sb, bounds));
    points.push(pa);
    // A strip of no area (an edge already on the rim) is nothing to draw.
    const area = points.reduce((sum, p, k) => {
      const q = points[(k + 1) % points.length]!;
      return sum + (p.x * q.y - q.x * p.y);
    }, 0);
    if (Math.abs(area) < 1e-6) continue;
    out.push({ edge: e, points });
  }
  return out;
}

/**
 * A coast or ice edge that runs off the map ends on a hex corner of the
 * map's outline; this carries it on to the page's edge, the way the rim pieces
 * beside it are cut. An end that is not on that outline (a junction inside the
 * map) is left alone, as are closed paths. No corner of the outline lies
 * further than a hex's half-width from the page's edge, and no other does.
 */
export function extendToRim(path: PathCmd[], closed: boolean, bounds: RimBounds, size: number): PathCmd[] {
  if (closed || path.length < 2) return path;
  const first = path[0]!;
  const last = path[path.length - 1]!;
  if (first[0] !== 'M' || last[0] === 'Z') return path;
  const onOutline = (p: Point) => Math.min(p.y, bounds.width - p.x, bounds.height - p.y, p.x) <= size * 0.9;
  const head: Point = { x: first[1], y: first[2] };
  const tail: Point = { x: last.at(-2) as number, y: last.at(-1) as number };
  const out = onOutline(head) ? ([['M', ...rimXY(head, bounds)], ['L', head.x, head.y], ...path.slice(1)] as PathCmd[]) : [...path];
  if (onOutline(tail)) out.push(['L', ...rimXY(tail, bounds)]);
  return out;
}

function rimXY(p: Point, bounds: RimBounds): [number, number] {
  const q = projectToRim(p, bounds);
  return [q.x, q.y];
}

/** Continue a component coast with its endpoint tangent, rather than a square
 * turn into the straight page projection. The page endpoint stays fixed so
 * neighbouring coasts keep their boundary ordering. This path is installed in
 * the geometry before fitting; land queries and painted ink share it.
 */
export function extendCoastToRim(path: PathCmd[], closed: boolean, bounds: RimBounds, size: number, otherPaths: PathCmd[][] = []): PathCmd[] {
  if (closed || path.length < 3 || path.some(c => c[0] !== 'M' && c[0] !== 'L')) return extendToRim(path, closed, bounds, size);
  const points = path.map(c => ({ x: c[1] as number, y: c[2] as number }));
  const obstacles = [path, ...otherPaths].flatMap(d => pathPolylines(d,8));
  const cross = (a: Point,b: Point,c: Point)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  const safe = (p: Point,control: Point,rim: Point) => {
    let a=p;
    for(let k=1;k<=8;k++) {
      const t=k/8,u=1-t,b={x:u*u*p.x+2*u*t*control.x+t*t*rim.x,y:u*u*p.y+2*u*t*control.y+t*t*rim.y};
      for(const ring of obstacles)for(let j=0;j+1<ring.length;j++) {
        const c=ring[j]!,d=ring[j+1]!;
        if(cross(a,b,c)*cross(a,b,d)<-1e-8&&cross(c,d,a)*cross(c,d,b)<-1e-8)return false;
      }
      a=b;
    }
    return true;
  };
  const curve = (p: Point, near: Point): { rim: Point; control: Point } | null => {
    const rim = projectToRim(p, bounds), gap = Math.hypot(rim.x-p.x, rim.y-p.y);
    if (gap < 1e-7 || gap > size*.9) return null;
    const dx = p.x-near.x, dy = p.y-near.y, length = Math.hypot(dx,dy);
    if (!length || dx*(rim.x-p.x)+dy*(rim.y-p.y) <= 0) return { rim, control: {x:(p.x+rim.x)/2,y:(p.y+rim.y)/2} };
    const outward = Math.abs(rim.x-p.x) > Math.abs(rim.y-p.y) ? Math.abs(dx/length) : Math.abs(dy/length);
    const handle = Math.min(gap/(2*Math.max(.35,outward)),size*.6);
    const control={x:p.x+dx/length*handle,y:p.y+dy/length*handle};
    return {rim,control:safe(p,control,rim)?control:{x:(p.x+rim.x)/2,y:(p.y+rim.y)/2}};
  };
  const head=points[0]!,tail=points.at(-1)!;
  const first=curve(head,points[1]!),last=curve(tail,points.at(-2)!);
  const out: PathCmd[]=first ? [['M',first.rim.x,first.rim.y],['Q',first.control.x,first.control.y,head.x,head.y],...path.slice(1)] : [...path];
  if(last)out.push(['Q',last.control.x,last.control.y,last.rim.x,last.rim.y]);
  return out;
}
