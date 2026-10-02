/**
 * The drawing primitives every renderer understands. The scene builder emits
 * these; the canvas and SVG back ends each know how to draw them and nothing
 * else, which is what keeps the screen, the PNG and the SVG the same picture.
 */

import type { Point } from '../../shared/hex.js';
import type { GrainTile } from './texture.js';

/** One path command, in absolute coordinates. */
export type PathCmd =
  | ['M', number, number]
  | ['L', number, number]
  | ['Q', number, number, number, number]
  | ['C', number, number, number, number, number, number]
  | ['Z'];

export type CitySymbol = 'village' | 'town' | 'city' | 'metropolis';

export type Prim =
  | {
      kind: 'polygon';
      points: Point[];
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
    }
  | {
      kind: 'polyline';
      points: Point[];
      stroke: string;
      strokeWidth: number;
      dash?: number[];
      round?: boolean;
      smooth?: boolean;
    }
  | {
      kind: 'path';
      d: PathCmd[];
      fill?: string;
      /** Defaults to nonzero. */
      fillRule?: 'nonzero' | 'evenodd';
      stroke?: string;
      strokeWidth?: number;
      dash?: number[];
      round?: boolean;
    }
  | {
      kind: 'circle';
      c: Point;
      r: number;
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
    }
  | {
      kind: 'text';
      at: Point;
      text: string;
      size: number;
      fill: string;
      halo?: string;
      weight?: number;
      anchor?: 'start' | 'middle' | 'end';
      maxWidth?: number;
      fantasy?: boolean;
      italic?: boolean;
      rotation?: number;
    }
  | {
      kind: 'city';
      c: Point;
      r: number;
      onRiver: boolean;
      symbol: CitySymbol;
      /** Marker colours; the classic palette when omitted. */
      fill?: string;
      ring?: string;
      riverDot?: string;
    }
  | {
      /** Children drawn as one unit, optionally clipped to a region (nonzero rule). */
      kind: 'group';
      clip?: PathCmd[];
      prims: Prim[];
    }
  | {
      /** A rectangle tiled with a repeating texture, such as paper grain. */
      kind: 'texture';
      x: number;
      y: number;
      width: number;
      height: number;
      tile: GrainTile;
    };

/** Path commands for a closed polygon through `points`. */
export function polygonPath(points: Point[]): PathCmd[] {
  const d: PathCmd[] = [];
  points.forEach((p, i) => d.push([i === 0 ? 'M' : 'L', p.x, p.y]));
  d.push(['Z']);
  return d;
}
