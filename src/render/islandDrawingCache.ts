import type { Point } from '../../shared/hex.js';
import type { PathCmd } from './prims.js';
import { BoundedMemo } from './cache.js';

export interface DrawnIsle {
  c: Point;
  rx: number;
  ry: number;
  axis: number;
  large: boolean;
  weight?: number;
}

interface IslandDrawing { isles: DrawnIsle[]; path: PathCmd[] }

/** Exact island results, sharing one budget for scale searches and final drawings.
 * Revision IDs are assigned from all land/layout inputs by the scene builder.
 * The budget includes keys and estimated payload, not a measured heap bound.
 */
export class IslandDrawingCache {
  private memo = new BoundedMemo<number | IslandDrawing>(10000, 4_000_000);

  scale(key: string): number | undefined {
    const value = this.memo.get(`scale/${key}`);
    return typeof value === 'number' ? value : undefined;
  }
  setScale(key: string, value: number): void { this.memo.set(`scale/${key}`, value, 8); }

  drawing(revision: number, hex: number): IslandDrawing | undefined {
    const value = this.memo.get(`drawing/${revision}/${hex}`);
    return typeof value === 'object' ? value : undefined;
  }
  setDrawing(revision: number, hex: number, value: IslandDrawing): void {
    this.memo.set(`drawing/${revision}/${hex}`, value, value.path.length * 64 + value.isles.length * 128);
  }
  clear(): void { this.memo.clear(); }
}
