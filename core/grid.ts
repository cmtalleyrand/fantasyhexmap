/**
 * How a per-hex grid is carried between this app and the model.
 *
 * Two forms, for two different reasons.
 *
 * Out of the model, over the API, a grid is a keyed object - `{"r0": {"c0":
 * "L", "c1": "~", ...}, ...}` - in which every row and every cell is a required
 * property. That is the only shape in which constrained decoding can guarantee
 * the grid's size: the API cannot enforce a string's length or an array's item
 * count, but it does enforce that every required key is present. A row string
 * such as "LLLL~~~CC" cannot be counted reliably by a model at all, because the
 * model does not see characters: it sees tokens, and a run like "LLLL" or
 * "~~~~~~" is one token of a length it has to infer. That is why rows came back
 * one or two cells short in bands wherever the terrain had long uniform runs.
 * Naming every cell also tells the model which column it is writing, so a
 * feature cannot drift sideways as it would when a count slips.
 *
 * Into the model, as context, a grid stays a picture - one line per row - but
 * with every row labelled and a column anchor every five cells, so reading
 * "what is at column 23 of row 12" is a lookup rather than a count.
 *
 * The webchat path keeps plain row strings for its replies: a chat model has
 * no constrained decoding either way, and the keyed form would only make a
 * pasted reply longer.
 */

import * as z from 'zod/v4';

/** How a layer's cells are written as row text for the decoders. */
export type CellKind = 'char' | 'token';

export const rowKey = (row: number) => `r${row}`;
export const colKey = (col: number) => `c${col}`;

/**
 * A grid of `rows` x `cols` required cells. The row object is built once and
 * reused for every row, so the JSON Schema carries it as one `$ref` definition
 * rather than `rows` copies - the schema stays small whatever the grid size.
 */
export function keyedGrid(cols: number, rows: number, cell: z.ZodType, what: string) {
  const rowShape: Record<string, z.ZodType> = {};
  for (let c = 0; c < cols; c++) rowShape[colKey(c)] = cell;
  const row = z
    .object(rowShape)
    .describe(`One grid row: keys c0 to c${cols - 1}, west to east, one ${what} per hex.`);

  const gridShape: Record<string, z.ZodType> = {};
  for (let r = 0; r < rows; r++) gridShape[rowKey(r)] = row;
  return z
    .object(gridShape)
    .describe(
      `The whole grid: keys r0 (north edge) to r${rows - 1} (south edge), each holding cells c0 (west edge) to c${cols - 1} (east edge).`,
    );
}

/**
 * Flatten a keyed grid back into the row strings the decoders read.
 *
 * A missing cell cannot occur when the grammar enforced the shape, but the
 * fallback costs nothing: it is written as "?" so the decoder counts it as an
 * unrecognised value in place instead of shifting the rest of the row west.
 */
export function keyedToRows(
  grid: unknown,
  cols: number,
  rows: number,
  kind: CellKind,
): string[] {
  const g = (grid ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const row = g[rowKey(r)] ?? {};
    const cells: string[] = [];
    for (let c = 0; c < cols; c++) {
      const raw = row[colKey(c)];
      const text = raw === undefined || raw === null ? '' : String(raw).trim();
      if (kind === 'char') cells.push(text.charAt(0) || '?');
      else cells.push(text.replace(/\s+/g, '') || '?');
    }
    out.push(kind === 'char' ? cells.join('') : cells.join(' '));
  }
  return out;
}

/** Split an encoded row into its cells, whichever kind it is. */
function cellsOf(line: string, kind: CellKind): string[] {
  return kind === 'char' ? Array.from(line) : line.trim().split(/\s+/).filter(Boolean);
}

/**
 * A context grid as the model reads it: a row label, then the cells in groups
 * of five, each group introduced by the column it starts at.
 *
 *   r12: [0] ~~~~~ [5] ~~CLL [10] LLLLL [15] ...
 *
 * The anchors are what make position readable: the model locates column 23 by
 * finding "[20]" and stepping three cells, instead of counting 23 characters it
 * cannot see individually.
 */
export function gridView(lines: string[], kind: CellKind): string[] {
  const out = [
    `(Each row is labelled r0, r1, ...; "[n]" marks column n, and every group holds the five cells from that column on.)`,
  ];
  lines.forEach((line, r) => {
    const cells = cellsOf(line, kind);
    const groups: string[] = [];
    for (let c = 0; c < cells.length; c += 5) {
      const group = cells.slice(c, c + 5);
      groups.push(`[${c}] ${kind === 'char' ? group.join('') : group.join(' ')}`);
    }
    out.push(`${rowKey(r)}: ${groups.join(' ')}`);
  });
  return out;
}

/** How many hexes hold each value, for the measured totals shown with a grid. */
export function tally<T extends string>(values: (T | null | undefined)[]): Map<T, number> {
  const counts = new Map<T, number>();
  for (const v of values) {
    if (v === null || v === undefined) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}
