import type { Point } from '../../shared/hex.js';
import type { PathCmd, Prim } from './prims.js';

export interface Bounds { left: number; top: number; right: number; bottom: number }
const cache = new WeakMap<Prim, Bounds | null>();
const paths = new WeakMap<readonly PathCmd[], Bounds>();

function pointsBounds(points: readonly Point[], pad = 0): Bounds {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of points) {
    left = Math.min(left, point.x); top = Math.min(top, point.y);
    right = Math.max(right, point.x); bottom = Math.max(bottom, point.y);
  }
  return { left: left - pad, top: top - pad, right: right + pad, bottom: bottom + pad };
}

function pathBounds(path: readonly PathCmd[], pad = 0): Bounds {
  // Bezier curves stay in the convex hull of their endpoints and controls.
  let bounds = paths.get(path);
  if (!bounds) {
    bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    for (const command of path) for (let i = 1; i < command.length; i += 2) {
      const x = command[i] as number, y = command[i + 1] as number;
      bounds.left = Math.min(bounds.left, x); bounds.top = Math.min(bounds.top, y);
      bounds.right = Math.max(bounds.right, x); bounds.bottom = Math.max(bounds.bottom, y);
    }
    paths.set(path, bounds);
  }
  return { left: bounds.left - pad, top: bounds.top - pad, right: bounds.right + pad, bottom: bounds.bottom + pad };
}

/** Conservative bounds only: unknown lettering is drawn rather than guessed. */
export function boundsOf(prim: Prim): Bounds | null {
  if (cache.has(prim)) return cache.get(prim)!;
  let bounds: Bounds | null;
  const stroke = 'stroke' in prim && prim.stroke ? ('strokeWidth' in prim ? prim.strokeWidth ?? 1 : 1) : 0;
  // Include the full default miter limit, not just half the stroke width.
  const pad = stroke * 10;
  if (stroke < 0 || ('stroke' in prim && prim.stroke && stroke === 0)) bounds = null;
  else switch (prim.kind) {
    case 'path': bounds = pathBounds(prim.d, pad); break;
    case 'polygon': case 'polyline': bounds = pointsBounds(prim.points, pad); break;
    case 'circle': bounds = pointsBounds([prim.c], prim.r + pad); break;
    case 'city': bounds = pointsBounds([prim.c], Math.max(prim.r, 1.5) + Math.max(1, prim.r * 0.16) * 10); break;
    case 'texture': bounds = { left: Math.min(prim.x, prim.x + prim.width), top: Math.min(prim.y, prim.y + prim.height),
      right: Math.max(prim.x, prim.x + prim.width), bottom: Math.max(prim.y, prim.y + prim.height) }; break;
    case 'text': bounds = null; break;
    case 'group': {
      bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      for (const child of prim.prims) {
        const box = boundsOf(child);
        if (!box) { bounds = null; break; }
        bounds.left = Math.min(bounds.left, box.left); bounds.top = Math.min(bounds.top, box.top);
        bounds.right = Math.max(bounds.right, box.right); bounds.bottom = Math.max(bounds.bottom, box.bottom);
      }
      if (prim.clip) {
        const clip = pathBounds(prim.clip);
        bounds = bounds ? { left: Math.max(bounds.left, clip.left), top: Math.max(bounds.top, clip.top),
          right: Math.min(bounds.right, clip.right), bottom: Math.min(bounds.bottom, clip.bottom) } : clip;
      }
      if (bounds && prim.translate) bounds = { left: bounds.left + prim.translate.x, top: bounds.top + prim.translate.y,
        right: bounds.right + prim.translate.x, bottom: bounds.bottom + prim.translate.y };
      break;
    }
  }
  cache.set(prim, bounds);
  return bounds;
}

export function intersects(bounds: Bounds | null, viewport: Bounds): boolean {
  return !bounds || bounds.left <= viewport.right && bounds.right >= viewport.left && bounds.top <= viewport.bottom && bounds.bottom >= viewport.top;
}
