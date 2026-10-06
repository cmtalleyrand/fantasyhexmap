/** Keep swept polygons as points while fitting; render commands are needed only for the chosen coast. */
import type { Point } from '../../shared/hex.js';
import type { Sliver } from './coast.js';
import type { PathCmd } from './prims.js';

const polygons = new WeakMap<Sliver, Point[]>();

export function polygonSliver(points: Point[], donor: number): Sliver {
  let path: PathCmd[] | undefined;
  const sliver: Sliver = {
    get d() {
      return path ??= [...points.map((p, i) => [i ? 'L' : 'M', p.x, p.y] as PathCmd), ['Z']];
    },
    donor,
  };
  polygons.set(sliver, points);
  return sliver;
}

export function sliverPolygon(sliver: Sliver): Point[] | undefined {
  return polygons.get(sliver);
}
