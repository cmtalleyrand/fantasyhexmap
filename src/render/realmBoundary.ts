import { hexEdgePoints, neighbourOf, type Point } from '../../shared/hex.js';
import { chainEdges, type CoastEdge } from './coast.js';
import type { PathCmd } from './prims.js';

/** Trace the region from the same oriented edge points used by its ink border. */
export function realmBoundary(
  hexes: number[], cols: number, size: number,
  edgePoints: (hex: number, edge: number, a: Point, b: Point) => Point[],
): PathCmd[] {
  const inside = new Set(hexes);
  const edges: CoastEdge[] = [];
  for (const i of hexes) for (let e = 0; e < 6; e++) {
    const col = i % cols, row = Math.floor(i / cols), n = neighbourOf(col, row, e);
    if (n.col >= 0 && n.col < cols && n.row >= 0 && inside.has(n.row * cols + n.col)) continue;
    const [a, b] = hexEdgePoints(col, row, e, size);
    const line = edgePoints(i, e, a, b);
    for (let j = 1; j < line.length; j++) {
      const from = line[j - 1]!, to = line[j]!;
      if (Math.hypot(to.x - from.x, to.y - from.y) > 1e-8) edges.push({ from, to, land: i, water: -1 });
    }
  }
  return chainEdges(edges).flatMap(chain => [
    ...chain.points.map((p, k) => [k === 0 ? 'M' : 'L', p.x, p.y] as PathCmd),
    ...(chain.closed ? [['Z'] as PathCmd] : []),
  ]);
}
