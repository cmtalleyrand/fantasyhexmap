import type { Point } from '../../shared/hex.js';
import { drawnLand, type CoastGeometry } from './coast.js';
import { polygonPath, type PathCmd } from './prims.js';

/** Geometry only: colours and ownership are applied afresh by the scene builder. */
export interface CoastPaintGeometry {
  land: PathCmd[];
  water: PathCmd[] | null;
  ground: Array<{ donor: number; points: Point[] }>;
  estimatedBytes: number;
}

/** Retained with the exact coast, inside its existing cache budget. */
export function coastPaintGeometry(geometry: CoastGeometry, width: number, height: number, size: number): CoastPaintGeometry {
  const land = drawnLand(geometry, width, height, size);
  const water: PathCmd[] | null = geometry.component ? [
    ...polygonPath([{ x: -size, y: -size }, { x: width + size, y: -size },
      { x: width + size, y: height + size }, { x: -size, y: height + size }]), ...land,
  ] : null;
  const ground: CoastPaintGeometry['ground'] = [];
  if (geometry.component) for (const chain of geometry.chains) for (const edge of chain.edges) {
    const dx = edge.to.x - edge.from.x, dy = edge.to.y - edge.from.y;
    const length = Math.hypot(dx, dy) || 1;
    const tx = dx / length * size * 2.5, ty = dy / length * size * 2.5;
    ground.push({ donor: edge.land, points: [
      { x: edge.from.x - tx - ty, y: edge.from.y - ty + tx },
      { x: edge.to.x + tx - ty, y: edge.to.y + ty + tx },
      { x: edge.to.x + tx + ty, y: edge.to.y + ty - tx },
      { x: edge.from.x - tx + ty, y: edge.from.y - ty - tx },
    ] });
  }
  return { land, water, ground, estimatedBytes: land.length * 16 + (water?.length ?? 0) * 8 + ground.length * 192 };
}
