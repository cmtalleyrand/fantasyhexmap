/**
 * Hand-editing rivers.
 *
 * A river is stored as edge-addressed segments, but it is far easier to reshape
 * as the list of hexes it passes through. These helpers go segments -> hex path,
 * change the path, and hand it back to `buildRiverFromPath`, so entry and exit
 * edges, the terminus and the uphill check are all recomputed by the same code
 * that builds a generated river - an edit can never leave a river whose edges
 * disagree with its path.
 *
 * Navigability belongs to the hex a segment sits in, so it travels with the hex
 * when the path is reshaped; hexes added by a reshape inherit it from the hex
 * they replace.
 */

import { isWater } from './derive.js';
import { hexDistance, hexIndex, hexLine, inBounds, neighbourOf, type Offset } from './hex.js';
import type { BaseData, ElevationData, River, RiverSegment } from './types.js';
import { buildRiverFromPath } from './validate.js';

export type RiverEditResult = { river: River; warnings: string[] } | { error: string };

interface PathHex extends Offset {
  navigable: boolean;
}

/** The river's hexes in flow order, plus the water hex it empties into if any. */
function pathOf(river: River, base: BaseData, cols: number, rows: number): PathHex[] {
  const path: PathHex[] = river.segments.map((s) => ({ col: s.col, row: s.row, navigable: s.navigable }));
  const last = river.segments[river.segments.length - 1];
  if (last && last.exitEdge !== null) {
    const m = neighbourOf(last.col, last.row, last.exitEdge);
    if (inBounds(cols, rows, m.col, m.row) && isWater(base[hexIndex(cols, m.col, m.row)])) {
      path.push({ ...m, navigable: false });
    }
  }
  return path;
}

/** Cut any loop: if a hex recurs, drop everything between its two visits. */
function withoutLoops(path: PathHex[]): PathHex[] {
  const out: PathHex[] = [];
  for (const hex of path) {
    const seen = out.findIndex((p) => p.col === hex.col && p.row === hex.row);
    if (seen >= 0) out.length = seen + 1;
    else out.push(hex);
  }
  return out;
}

function rebuild(
  river: River,
  path: PathHex[],
  base: BaseData,
  elevation: ElevationData | null,
  cols: number,
  rows: number,
): RiverEditResult {
  if (path.some((p) => !inBounds(cols, rows, p.col, p.row))) {
    return { error: 'That would route the river off the map.' };
  }
  const warnings: string[] = [];
  const rebuilt = buildRiverFromPath(
    { name: river.name, path, navigable: path.map((p) => p.navigable) },
    river.id,
    base,
    elevation,
    cols,
    rows,
    warnings,
  );
  if (!rebuilt) return { error: 'That would leave the river with no land to run through.' };
  return { river: rebuilt, warnings };
}

/** Hexes strictly after `from` up to and including `to` along a straight line. */
function leg(from: Offset, to: Offset, navigable: boolean): PathHex[] {
  return hexLine(from, to).slice(1).map((h) => ({ ...h, navigable }));
}

/**
 * Move the river's segment `index` to `target`. The river is re-joined to its
 * neighbours with straight runs of hexes, so dragging a hex far away stretches
 * the river rather than breaking it.
 */
export function moveRiverSegment(
  river: River,
  index: number,
  target: Offset,
  base: BaseData,
  elevation: ElevationData | null,
  cols: number,
  rows: number,
): RiverEditResult {
  const seg = river.segments[index];
  if (!seg) return { error: 'That hex is not part of the river.' };
  if (!inBounds(cols, rows, target.col, target.row)) return { error: 'That is off the map.' };
  if (seg.col === target.col && seg.row === target.row) return { error: 'The river is already there.' };
  if (isWater(base[hexIndex(cols, target.col, target.row)])) {
    return { error: 'A river segment cannot be moved into water; the river ends on its own where it meets water.' };
  }
  const path = pathOf(river, base, cols, rows);
  const prev = path[index - 1];
  const next = path[index + 1];
  const moved: PathHex = { ...target, navigable: seg.navigable };
  const joined: PathHex[] = [
    ...path.slice(0, index),
    ...(prev ? leg(prev, target, seg.navigable) : [moved]),
    ...(next ? leg(target, next, seg.navigable).slice(0, -1) : []),
    ...path.slice(index + 1),
  ];
  return rebuild(river, withoutLoops(joined), base, elevation, cols, rows);
}

/**
 * Remove segment `index`, closing the gap with a straight run. Returns null when
 * that would delete the river's only land hex - the caller removes the river.
 */
export function removeRiverSegment(
  river: River,
  index: number,
  base: BaseData,
  elevation: ElevationData | null,
  cols: number,
  rows: number,
): RiverEditResult | null {
  if (!river.segments[index]) return { error: 'That hex is not part of the river.' };
  if (river.segments.length <= 1) return null;
  const path = pathOf(river, base, cols, rows);
  const prev = path[index - 1];
  const next = path[index + 1];
  const bridge = prev && next ? leg(prev, next, river.segments[index]!.navigable).slice(0, -1) : [];
  const gone = river.segments[index]!;
  if (bridge.some((h) => h.col === gone.col && h.row === gone.row)) {
    return { error: 'That hex is needed to connect its neighbours. Move it instead.' };
  }
  const joined = [...path.slice(0, index), ...bridge, ...path.slice(index + 1)];
  return rebuild(river, withoutLoops(joined), base, elevation, cols, rows);
}

/**
 * Add hexes to a river: the end of the river nearer to `target` is extended to
 * it along a straight run, so one click adds as many segments as it takes. A
 * land target at the mouth end replaces the old mouth (the terminus is
 * recomputed); a water target at the mouth end becomes the new mouth.
 */
export function extendRiver(
  river: River,
  target: Offset,
  base: BaseData,
  elevation: ElevationData | null,
  cols: number,
  rows: number,
): RiverEditResult {
  if (!inBounds(cols, rows, target.col, target.row)) return { error: 'That is off the map.' };
  if (river.segments.some((s) => s.col === target.col && s.row === target.row)) {
    return { error: 'The river already runs through that hex.' };
  }
  const first = river.segments[0];
  const last = river.segments[river.segments.length - 1];
  if (!first || !last) return { error: 'That river has no hexes to extend.' };
  const targetIsWater = isWater(base[hexIndex(cols, target.col, target.row)]);
  const toSource = hexDistance(first, target);
  const toMouth = hexDistance(last, target);
  const land = pathOf(river, base, cols, rows).filter((p) => !isWater(base[hexIndex(cols, p.col, p.row)]));
  const inherit = (from: RiverSegment) => from.navigable;

  if (!targetIsWater && toSource < toMouth) {
    const run = leg(first, target, inherit(first)).reverse();
    return rebuild(river, withoutLoops([...run, ...land]), base, elevation, cols, rows);
  }
  const run = leg(last, target, inherit(last));
  return rebuild(river, withoutLoops([...land, ...run]), base, elevation, cols, rows);
}

/**
 * A distributary: a new river that leaves `river` at its hex `fork` and runs
 * along `path` (which starts at the fork hex). Navigability starts out as the
 * parent's at the fork.
 */
export function buildBranch(
  parent: River,
  fork: Offset,
  path: Offset[],
  id: string,
  base: BaseData,
  elevation: ElevationData | null,
  cols: number,
  rows: number,
): RiverEditResult {
  const forkSeg = parent.segments.find((s) => s.col === fork.col && s.row === fork.row);
  if (!forkSeg) return { error: 'A branch has to leave from one of the river\'s own hexes.' };
  const first = path[0];
  if (!first || first.col !== fork.col || first.row !== fork.row || path.length < 2) {
    return { error: 'A branch needs at least one hex beyond the fork.' };
  }
  const warnings: string[] = [];
  const river = buildRiverFromPath(
    { name: `${parent.name} (branch)`, path, navigable: path.map(() => forkSeg.navigable) },
    id,
    base,
    elevation,
    cols,
    rows,
    warnings,
  );
  if (!river) return { error: 'That branch would have no land to run through.' };
  return { river: { ...river, branchOf: parent.id }, warnings };
}

/**
 * Branches whose fork hex is no longer on their parent (the parent moved, was
 * trimmed or was removed) stop being branches and become ordinary rivers.
 * Returns the same array when nothing needed detaching.
 */
export function detachOrphanBranches(rivers: River[]): River[] {
  let changed = false;
  const out = rivers.map((r) => {
    if (r.branchOf === undefined) return r;
    const parent = rivers.find((p) => p.id === r.branchOf);
    const fork = r.segments[0];
    if (parent && fork && parent.segments.some((s) => s.col === fork.col && s.row === fork.row)) return r;
    changed = true;
    const { branchOf: _gone, ...rest } = r;
    return rest;
  });
  return changed ? out : rivers;
}

/**
 * Set navigability on every river segment sitting in one of `hexes`. With
 * `downstream`, each touched segment also carries the value to the river's
 * mouth - "navigable from the head of navigation to the sea" in one click.
 * Returns the same array when nothing changed.
 */
export function setRiverNavigability(
  rivers: River[],
  hexes: Set<number>,
  navigable: boolean,
  downstream: boolean,
  cols: number,
): River[] {
  let changed = false;
  const out = rivers.map((river) => {
    const first = river.segments.findIndex((s) => hexes.has(hexIndex(cols, s.col, s.row)));
    if (first < 0) return river;
    const segments = river.segments.map((s, i) => {
      const hit = hexes.has(hexIndex(cols, s.col, s.row)) || (downstream && i > first);
      if (!hit || s.navigable === navigable) return s;
      changed = true;
      return { ...s, navigable };
    });
    return segments.some((s, i) => s !== river.segments[i]) ? { ...river, segments } : river;
  });
  return changed ? out : rivers;
}
