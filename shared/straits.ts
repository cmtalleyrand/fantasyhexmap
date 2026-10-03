/**
 * Straits and who they belong to. A strait is a channel with a bank on each
 * side it faces land. A strait hex a polity owns outright belongs to it alone;
 * one left unowned is shared by the realms owning the land it faces, and a
 * city can stand on either bank.
 */

import { hexIndex, neighbourOf, inBounds } from './hex.js';
import { isLandLike } from './derive.js';
import type { BaseData } from './types.js';

/** Edges of (col,row) whose neighbour is land: the strait's banks. */
export function landEdgesOf(base: BaseData, cols: number, rows: number, col: number, row: number): number[] {
  const out: number[] = [];
  for (let e = 0; e < 6; e++) {
    const n = neighbourOf(col, row, e);
    if (inBounds(cols, rows, n.col, n.row) && isLandLike(base[hexIndex(cols, n.col, n.row)])) out.push(e);
  }
  return out;
}

/**
 * The realms sharing an unowned strait hex, each with the fraction of the
 * strait's banks that face its land. Empty for any other hex, for an owned
 * strait, or when no bank faces an owned hex.
 */
export function straitSharers(
  base: BaseData,
  owner: (string | null)[],
  cols: number,
  rows: number,
  index: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (base[index] !== 'Strait' || owner[index]) return out;
  const col = index % cols;
  const row = Math.floor(index / cols);
  const facing: string[] = [];
  for (const e of landEdgesOf(base, cols, rows, col, row)) {
    const n = neighbourOf(col, row, e);
    const id = owner[hexIndex(cols, n.col, n.row)];
    if (id) facing.push(id);
  }
  for (const id of facing) out.set(id, (out.get(id) ?? 0) + 1 / facing.length);
  return out;
}
