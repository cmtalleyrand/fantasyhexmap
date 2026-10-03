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

/**
 * The river's hexes in flow order, plus the lake it flows out of and the water
 * hex it empties into, if any.
 */
function pathOf(river: River, base: BaseData, cols: number, rows: number): PathHex[] {
  const path: PathHex[] = river.segments.map((s) => ({ col: s.col, row: s.row, navigable: s.navigable }));
  const first = river.segments[0];
  if (river.fromLake && first && first.entryEdge !== null) {
    const l = neighbourOf(first.col, first.row, first.entryEdge);
    if (inBounds(cols, rows, l.col, l.row) && base[hexIndex(cols, l.col, l.row)] === 'Lake') {
      path.unshift({ ...l, navigable: false });
    }
  }
  const last = river.segments[river.segments.length - 1];
  if (last && last.exitEdge !== null) {
    const m = neighbourOf(last.col, last.row, last.exitEdge);
    if (inBounds(cols, rows, m.col, m.row) && isWater(base[hexIndex(cols, m.col, m.row)])) {
      path.push({ ...m, navigable: false });
    }
  }
  return path;
}

/** 1 when `path` (from `pathOf`) opens with the lake the river flows out of, else 0. */
function sourceOffset(river: River, path: PathHex[]): number {
  const first = river.segments[0];
  return first && path[0] && (path[0].col !== first.col || path[0].row !== first.row) ? 1 : 0;
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
  others: River[],
  keepBranch = true,
): RiverEditResult {
  if (path.some((p) => !inBounds(cols, rows, p.col, p.row))) {
    return { error: 'That would route the river off the map.' };
  }
  const warnings: string[] = [];
  const rebuilt = buildRiverFromPath(
    { name: river.name, path, navigable: path.map((p) => p.navigable), joins: river.joins },
    river.id,
    base,
    elevation,
    cols,
    rows,
    warnings,
    others,
  );
  if (!rebuilt) return { error: 'That would leave the river with no land to run through.' };
  // A branch stays one while it still leaves from its parent (detachOrphanBranches checks).
  return { river: keepBranch && river.branchOf ? { ...rebuilt, branchOf: river.branchOf } : rebuilt, warnings };
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
  others: River[] = [],
): RiverEditResult {
  const seg = river.segments[index];
  if (!seg) return { error: 'That hex is not part of the river.' };
  if (!inBounds(cols, rows, target.col, target.row)) return { error: 'That is off the map.' };
  if (seg.col === target.col && seg.row === target.row) return { error: 'The river is already there.' };
  const targetValue = base[hexIndex(cols, target.col, target.row)];
  const path = pathOf(river, base, cols, rows);
  if (isWater(targetValue)) {
    const first = index === 0;
    const last = index === river.segments.length - 1;
    // The source dragged onto a lake: the river now flows out of that lake.
    // The mouth dragged onto water: the river now empties there.
    if (first && targetValue === 'Lake') {
      const rest = path.slice(sourceOffset(river, path) + 1);
      const next = rest[0];
      const run = next ? leg(target, next, seg.navigable).slice(0, -1) : [];
      return rebuild(river, withoutLoops([{ ...target, navigable: false }, ...run, ...rest]), base, elevation, cols, rows, others);
    }
    if (last && river.segments.length > 1) {
      const head = path.slice(0, sourceOffset(river, path) + index);
      const prev = head[head.length - 1]!;
      return rebuild(river, withoutLoops([...head, ...leg(prev, target, seg.navigable)]), base, elevation, cols, rows, others);
    }
    return {
      error: first
        ? 'A river can rise in a lake, but not in the sea: drag its source onto a Lake hex.'
        : 'Only a river\'s source can be moved into a lake (it then flows out of it), or its mouth into water.',
    };
  }
  // The path may open with the lake the river flows out of.
  const at = index + sourceOffset(river, path);
  const prev = path[at - 1];
  const next = path[at + 1];
  const moved: PathHex = { ...target, navigable: seg.navigable };
  const joined: PathHex[] = [
    ...path.slice(0, at),
    ...(prev ? leg(prev, target, seg.navigable) : [moved]),
    ...(next ? leg(target, next, seg.navigable).slice(0, -1) : []),
    ...path.slice(at + 1),
  ];
  return rebuild(river, withoutLoops(joined), base, elevation, cols, rows, others);
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
  others: River[] = [],
): RiverEditResult | null {
  if (!river.segments[index]) return { error: 'That hex is not part of the river.' };
  if (river.segments.length <= 1) return null;
  const path = pathOf(river, base, cols, rows);
  const at = index + sourceOffset(river, path);
  const prev = path[at - 1];
  const next = path[at + 1];
  const bridge = prev && next ? leg(prev, next, river.segments[index]!.navigable).slice(0, -1) : [];
  const gone = river.segments[index]!;
  if (bridge.some((h) => h.col === gone.col && h.row === gone.row)) {
    return { error: 'That hex is needed to connect its neighbours. Move it instead.' };
  }
  const joined = [...path.slice(0, at), ...bridge, ...path.slice(at + 1)];
  return rebuild(river, withoutLoops(joined), base, elevation, cols, rows, others);
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
  others: River[] = [],
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
  const full = pathOf(river, base, cols, rows);
  const land = full.filter((p) => !isWater(base[hexIndex(cols, p.col, p.row)]));
  // The lake the river flows out of stays its source unless the source end is extended.
  const lakeHead = full.slice(0, sourceOffset(river, full));
  const inherit = (from: RiverSegment) => from.navigable;
  const targetIsLake = base[hexIndex(cols, target.col, target.row)] === 'Lake';

  // Upstream to land, or up into a lake, which the river then flows out of.
  if ((!targetIsWater || targetIsLake) && toSource < toMouth) {
    const run = leg(first, target, inherit(first)).reverse();
    return rebuild(river, withoutLoops([...run, ...land]), base, elevation, cols, rows, others);
  }
  const run = leg(last, target, inherit(last));
  return rebuild(river, withoutLoops([...lakeHead, ...land, ...run]), base, elevation, cols, rows, others);
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
  others: River[] = [],
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
    others,
  );
  if (!river) return { error: 'That branch would have no land to run through.' };
  return { river: { ...river, branchOf: parent.id }, warnings };
}

/**
 * Branches whose fork hex is no longer on their parent (the parent moved, was
 * trimmed or was removed) stop being branches and become ordinary rivers, and
 * tributaries whose river no longer reaches their confluence hex lose it.
 * Returns the same array when nothing needed detaching.
 */
export function detachOrphanBranches(rivers: River[]): River[] {
  let changed = false;
  const on = (id: string, hex: RiverSegment | undefined) => {
    const other = rivers.find((p) => p.id === id);
    return Boolean(other && hex && other.segments.some((s) => s.col === hex.col && s.row === hex.row));
  };
  const out = rivers.map((river) => {
    let r = river;
    if (r.branchOf !== undefined && !on(r.branchOf, r.segments[0])) {
      changed = true;
      const { branchOf: _gone, ...rest } = r;
      r = rest;
    }
    // Likewise a tributary whose river no longer runs through its last hex
    // ends inland until it is reconnected.
    if (r.joins !== undefined && !on(r.joins, r.segments.at(-1))) {
      changed = true;
      const { joins: _gone, ...rest } = r;
      r = { ...rest, terminus: 'Unresolved' };
    }
    return r;
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

/** The river's land hexes, upstream first, with their navigability. */
function landPath(river: River): PathHex[] {
  return river.segments.map((s) => ({ col: s.col, row: s.row, navigable: s.navigable }));
}

/**
 * Reverse a river's direction of flow: the mouth becomes the source. Its new
 * last hex finds its own way out - to adjacent water, or over the map edge -
 * exactly as a drawn river's does. Navigability stays with each hex.
 */
export function reverseRiver(
  river: River,
  base: BaseData,
  elevation: ElevationData | null,
  cols: number,
  rows: number,
  others: River[] = [],
): RiverEditResult {
  if (river.segments.length < 2) return { error: 'A one-hex river has no direction to reverse.' };
  // The lake a river flowed out of becomes the lake it flows into, and the
  // water it emptied into is dropped (a river cannot rise in the sea).
  const path = pathOf(river, base, cols, rows).reverse();
  while (path.length > 1 && isWater(base[hexIndex(cols, path[0]!.col, path[0]!.row)]) && base[hexIndex(cols, path[0]!.col, path[0]!.row)] !== 'Lake') {
    path.shift();
  }
  const { joins: _joins, ...unjoined } = river;
  return rebuild(unjoined, path, base, elevation, cols, rows, others, false);
}

export type RiverMergeResult =
  | {
      river: River;
      /** Rivers folded into `river`, to be removed. */
      absorbed: string[];
      /** Hexes added to bridge gaps between the pieces. */
      bridged: number;
      warnings: string[];
    }
  | { error: string };

/** Join `up` to `down`: up's hexes, a straight run across any gap, then down's hexes and mouth. */
function joinTwo(
  up: River,
  down: River,
  base: BaseData,
  cols: number,
  rows: number,
): { path: PathHex[]; bridged: number } | { error: string } {
  const upPath = landPath(up);
  const downPath = pathOf(down, base, cols, rows);
  const from = upPath[upPath.length - 1]!;
  const to = downPath[0]!;
  const navigable = from.navigable && to.navigable;
  // leg() includes `to`; drop it, as down's own first hex follows.
  const bridge = from.col === to.col && from.row === to.row ? [] : leg(from, to, navigable).slice(0, -1);
  if (bridge.some((h) => isWater(base[hexIndex(cols, h.col, h.row)]))) {
    return {
      error:
        `The gap between ${up.name} and ${down.name} crosses water. ` +
        'Move or extend one of them so their ends meet over land, then join them.',
    };
  }
  const startsAtEnd = from.col === to.col && from.row === to.row;
  return {
    path: [...upPath, ...bridge, ...(startsAtEnd ? downPath.slice(1) : downPath)],
    bridged: bridge.length,
  };
}

/**
 * Consolidate several rivers into one.
 *
 * The pieces are chained end to source, nearest pair first: a piece whose last
 * hex is closest to another's first hex flows into it. Ends that do not touch
 * are joined by a straight run of land hexes, as when drawing. No piece is
 * reversed - if one was drawn the wrong way round, reverse it first. The result
 * keeps `keepId`'s id and name, so cities on it and branches off any piece stay
 * attached.
 */
export function mergeRivers(
  pieces: River[],
  keepId: string,
  base: BaseData,
  elevation: ElevationData | null,
  cols: number,
  rows: number,
  others: River[] = [],
): RiverMergeResult {
  if (pieces.length < 2) return { error: 'Pick at least two rivers to join.' };
  const keep = pieces.find((r) => r.id === keepId);
  if (!keep) return { error: 'The river whose name is kept must be one of those being joined.' };
  if (pieces.some((r) => r.segments.length === 0)) return { error: 'One of those rivers has no hexes.' };

  // Chains of pieces, each in flow order; merged greedily by the shortest gap.
  let chains: River[][] = pieces.map((r) => [r]);
  while (chains.length > 1) {
    let best: { up: number; down: number; gap: number } | null = null;
    for (let i = 0; i < chains.length; i++) {
      for (let j = 0; j < chains.length; j++) {
        if (i === j) continue;
        const upLast = chains[i]!.at(-1)!.segments.at(-1)!;
        const downFirst = chains[j]![0]!.segments[0]!;
        const gap = hexDistance(upLast, downFirst);
        // On a tie, prefer ending at a river that reaches water.
        const better =
          !best ||
          gap < best.gap ||
          (gap === best.gap && chains[j]!.at(-1)!.terminus !== 'Unresolved' && chains[best.down]!.at(-1)!.terminus === 'Unresolved');
        if (better) best = { up: i, down: j, gap };
      }
    }
    const { up, down } = best!;
    const joined = [...chains[up]!, ...chains[down]!];
    chains = chains.filter((_, k) => k !== up && k !== down);
    chains.push(joined);
  }

  const order = chains[0]!;
  let path = landPath(order[0]!);
  let bridged = 0;
  for (let k = 1; k < order.length; k++) {
    const upSoFar: River = { ...order[k - 1]!, segments: path.map((p) => ({ ...p, entryEdge: null, exitEdge: null })) };
    const result = joinTwo(upSoFar, order[k]!, base, cols, rows);
    if ('error' in result) return result;
    // Keep only land hexes until the last piece; its mouth (if any) ends the river.
    path = k === order.length - 1 ? result.path : result.path.filter((h) => !isWater(base[hexIndex(cols, h.col, h.row)]));
    bridged += result.bridged;
  }

  const looped = withoutLoops(path);
  const rebuilt = rebuild(keep, looped, base, elevation, cols, rows, others);
  if ('error' in rebuilt) return rebuilt;
  const absorbedIds = new Set(pieces.filter((r) => r.id !== keepId).map((r) => r.id));
  // The joined river is a branch only if its upstream piece was one, of a river not being joined.
  const upstreamParent = order[0]!.branchOf;
  const river: River = { ...rebuilt.river };
  delete river.branchOf;
  if (upstreamParent && upstreamParent !== keepId && !absorbedIds.has(upstreamParent)) {
    river.branchOf = upstreamParent;
  }
  const warnings = [...rebuilt.warnings];
  if (looped.length < path.length) warnings.push('The joined course crossed itself; the loop was cut out.');
  return { river, absorbed: [...absorbedIds], bridged, warnings };
}
