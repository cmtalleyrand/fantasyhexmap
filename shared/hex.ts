/**
 * Hex geometry for a pointy-top, odd-r offset rectangular grid.
 * See shared/types.ts for the coordinate/edge contract this implements.
 */

export const SQRT3 = Math.sqrt(3);

export interface Point {
  x: number;
  y: number;
}

/** Edge / direction order: 0 E, 1 SE, 2 SW, 3 W, 4 NW, 5 NE. */
export const DIRECTION_NAMES = ['E', 'SE', 'SW', 'W', 'NW', 'NE'] as const;
export type DirectionName = (typeof DIRECTION_NAMES)[number];

/** Axial (q, r) deltas in the same order as DIRECTION_NAMES. */
const AXIAL_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],   // E
  [0, 1],   // SE
  [-1, 1],  // SW
  [-1, 0],  // W
  [0, -1],  // NW
  [1, -1],  // NE
];

export interface Axial {
  q: number;
  r: number;
}

export interface Offset {
  col: number;
  row: number;
}

export function hexIndex(cols: number, col: number, row: number): number {
  return row * cols + col;
}

export function indexToOffset(cols: number, index: number): Offset {
  return { col: index % cols, row: Math.floor(index / cols) };
}

export function offsetToAxial(col: number, row: number): Axial {
  return { q: col - (row - (row & 1)) / 2, r: row };
}

export function axialToOffset(q: number, r: number): Offset {
  return { col: q + (r - (r & 1)) / 2, row: r };
}

/** Neighbour across edge `edge`; may fall outside the grid (caller must bounds-check). */
export function neighbourOf(col: number, row: number, edge: number): Offset {
  const { q, r } = offsetToAxial(col, row);
  const [dq, dr] = AXIAL_DIRS[((edge % 6) + 6) % 6]!;
  return axialToOffset(q + dq, r + dr);
}

export function inBounds(cols: number, rows: number, col: number, row: number): boolean {
  return col >= 0 && row >= 0 && col < cols && row < rows;
}

/** All six neighbours, `null` where the neighbour is off the map. Index = edge index. */
export function neighbours(
  cols: number,
  rows: number,
  col: number,
  row: number,
): (Offset | null)[] {
  const out: (Offset | null)[] = [];
  for (let e = 0; e < 6; e++) {
    const n = neighbourOf(col, row, e);
    out.push(inBounds(cols, rows, n.col, n.row) ? n : null);
  }
  return out;
}

/** Edge index from `a` towards `b` if they are adjacent, else -1. */
export function edgeBetween(a: Offset, b: Offset): number {
  for (let e = 0; e < 6; e++) {
    const n = neighbourOf(a.col, a.row, e);
    if (n.col === b.col && n.row === b.row) return e;
  }
  return -1;
}

export function oppositeEdge(edge: number): number {
  return (edge + 3) % 6;
}

/**
 * A stable id for the edge shared by two hexes, independent of which side you
 * name it from: "col,row:edge" using whichever hex sorts first.
 */
export function canonicalEdgeId(col: number, row: number, edge: number): string {
  const n = neighbourOf(col, row, edge);
  const aFirst = row < n.row || (row === n.row && col <= n.col);
  return aFirst
    ? `${col},${row}:${edge}`
    : `${n.col},${n.row}:${oppositeEdge(edge)}`;
}

/** Pixel centre of a hex. `size` is the circumradius (centre -> corner). */
export function hexCenter(col: number, row: number, size: number): Point {
  return {
    x: size * SQRT3 * (col + 0.5 * (row & 1)) + (size * SQRT3) / 2,
    y: size * 1.5 * row + size,
  };
}

/** Overall pixel size of a cols x rows grid drawn at `size`. */
export function gridPixelSize(cols: number, rows: number, size: number) {
  return {
    width: size * SQRT3 * (cols + (rows > 1 ? 0.5 : 0)),
    height: size * (1.5 * rows + 0.5),
  };
}

/** Corners 0..5; corner k sits at angle 60k - 30 degrees. Edge k spans corner k -> k+1. */
export function hexCorners(col: number, row: number, size: number): Point[] {
  const c = hexCenter(col, row, size);
  const pts: Point[] = [];
  for (let k = 0; k < 6; k++) {
    const angle = (Math.PI / 180) * (60 * k - 30);
    pts.push({ x: c.x + size * Math.cos(angle), y: c.y + size * Math.sin(angle) });
  }
  return pts;
}

export function hexEdgePoints(
  col: number,
  row: number,
  edge: number,
  size: number,
): [Point, Point] {
  const corners = hexCorners(col, row, size);
  return [corners[edge % 6]!, corners[(edge + 1) % 6]!];
}

export function hexEdgeMidpoint(
  col: number,
  row: number,
  edge: number,
  size: number,
): Point {
  const [a, b] = hexEdgePoints(col, row, edge, size);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Inverse of hexCenter: which hex contains this pixel? */
export function pixelToOffset(x: number, y: number, size: number): Offset {
  const px = x - (size * SQRT3) / 2;
  const py = y - size;
  const r = py / (1.5 * size);
  const q = px / (SQRT3 * size) - r / 2;
  const { q: rq, r: rr } = axialRound(q, r);
  return axialToOffset(rq, rr);
}

export function axialRound(q: number, r: number): Axial {
  const s = -q - r;
  let rq = Math.round(q);
  let rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q);
  const dr = Math.abs(rr - r);
  const ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}

/** Straight-line hex distance between two offset coordinates. */
export function hexDistance(a: Offset, b: Offset): number {
  const aa = offsetToAxial(a.col, a.row);
  const bb = offsetToAxial(b.col, b.row);
  return (
    (Math.abs(aa.q - bb.q) +
      Math.abs(aa.q + aa.r - bb.q - bb.r) +
      Math.abs(aa.r - bb.r)) /
    2
  );
}
