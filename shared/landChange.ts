/**
 * What a hand edit of base geography does to the layers that sit on it.
 *
 * Land-only layers (elevation, climate, vegetation, population) and rivers have
 * no meaning on open water, so turning land into Sea or Lake clears them there
 * at once rather than leaving stale values for a later regeneration to trip on.
 * The reverse - water becoming land - fills the new hexes in from the land
 * around them, so a newly raised hex is not a blank in an otherwise complete map.
 *
 * Everything here is a pure function of arrays; the reducer decides when to
 * commit the results.
 */

import { isLandLike, isWater } from './derive.js';
import { hexIndex, inBounds, indexToOffset, neighbourOf } from './hex.js';
import { buildRiverFromPath } from './validate.js';
import { ELEVATION_VALUES, isIslandType, type BaseData, type Elevation, type River } from './types.js';

export interface BaseTransitions {
  /** Hexes that were land and are now Sea or Lake. */
  toWater: number[];
  /** Hexes that were Sea or Lake and are now land. */
  toLand: number[];
}

export function baseTransitions(before: BaseData, after: BaseData, indices: number[]): BaseTransitions {
  const toWater: number[] = [];
  const toLand: number[] = [];
  for (const i of new Set(indices)) {
    if (isLandLike(before[i]) && isWater(after[i])) toWater.push(i);
    else if (isWater(before[i]) && isLandLike(after[i])) toLand.push(i);
  }
  return { toWater, toLand };
}

/** A copy of a per-hex array with the given hexes emptied, or null if nothing was set there. */
export function clearedAt<T>(data: (T | null)[], indices: number[]): (T | null)[] | null {
  let out: (T | null)[] | null = null;
  for (const i of indices) {
    if (data[i] === null || data[i] === undefined) continue;
    out ??= data.slice();
    out[i] = null;
  }
  return out;
}

/**
 * Remove river segments from hexes that are now water.
 *
 * A river that loses its lower reaches simply ends at the new water, which is
 * what a flooded valley is. One that loses a stretch in the middle splits in
 * two - the upper part empties into the new water and the lower part rises
 * from it - rather than leaving a gap no edge connects. Each piece is rebuilt
 * from its hex path by the same code that builds a generated river, so edges
 * and terminus can never disagree with the map.
 */
export function riversWithoutHexes(
  rivers: River[],
  flooded: Set<number>,
  base: BaseData,
  cols: number,
  rows: number,
): River[] {
  const out: River[] = [];
  for (const river of rivers) {
    const wet = river.segments.map((s) => flooded.has(hexIndex(cols, s.col, s.row)));
    if (!wet.some(Boolean)) {
      out.push(river);
      continue;
    }
    const runs: number[][] = [];
    for (let i = 0; i < river.segments.length; i++) {
      if (wet[i]) continue;
      if (i > 0 && !wet[i - 1]) runs[runs.length - 1]!.push(i);
      else runs.push([i]);
    }
    runs.forEach((run, n) => {
      const path = run.map((i) => ({ col: river.segments[i]!.col, row: river.segments[i]!.row }));
      const navigable = run.map((i) => river.segments[i]!.navigable);
      const lastIndex = run[run.length - 1]!;
      // Where the piece used to go next: the removed hex it now empties into, or
      // the original mouth when it is still the river's tail.
      const next = river.segments[lastIndex + 1] ?? null;
      if (next) {
        path.push({ col: next.col, row: next.row });
      } else {
        const tail = river.segments[lastIndex]!;
        if (tail.exitEdge !== null) {
          const m = neighbourOf(tail.col, tail.row, tail.exitEdge);
          if (inBounds(cols, rows, m.col, m.row) && isWater(base[hexIndex(cols, m.col, m.row)])) path.push(m);
        }
      }
      // Where the piece used to come from: a hex now flooded into a lake (the
      // piece flows out of it), or the lake the whole river rose in.
      const firstSeg = river.segments[run[0]!]!;
      if (firstSeg.entryEdge !== null && (run[0]! > 0 || river.fromLake)) {
        const p = neighbourOf(firstSeg.col, firstSeg.row, firstSeg.entryEdge);
        if (inBounds(cols, rows, p.col, p.row) && base[hexIndex(cols, p.col, p.row)] === 'Lake') {
          path.unshift(p);
          navigable.unshift(false);
        }
      }
      let piece = buildRiverFromPath(
        {
          name: n === 0 || !river.name ? river.name : `${river.name} (lower course${n > 1 ? ` ${n}` : ''})`,
          path,
          navigable,
          allowBlankName: !river.name,
        },
        n === 0 ? river.id : `${river.id}_${n + 1}`,
        base,
        null,
        cols,
        rows,
        [],
      );
      if (!piece) return;
      // The tail still flows into the river it joined.
      if (!next && river.joins !== undefined && piece.segments.at(-1)?.exitEdge === null) {
        piece = { ...piece, joins: river.joins, terminus: 'River' };
      }
      out.push(n === 0 && river.branchOf !== undefined ? { ...piece, branchOf: river.branchOf } : piece);
    });
  }
  return out;
}

function mode<T>(values: T[], prefer?: (a: T, b: T) => number): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = 0;
  for (const [v, n] of counts) {
    if (n > bestCount || (n === bestCount && best !== undefined && prefer && prefer(v, best) < 0)) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}

/** The nearest existing land to a hex: all land hexes at the smallest distance that has any. */
function nearestLand(
  start: number,
  base: BaseData,
  excluded: Set<number>,
  cols: number,
  rows: number,
  maxDistance = 10,
): { hexes: number[]; distance: number } {
  const seen = new Set<number>([start]);
  let frontier = [start];
  for (let distance = 1; distance <= maxDistance && frontier.length > 0; distance++) {
    const next: number[] = [];
    const found: number[] = [];
    for (const i of frontier) {
      const { col, row } = indexToOffset(cols, i);
      for (let e = 0; e < 6; e++) {
        const n = neighbourOf(col, row, e);
        if (!inBounds(cols, rows, n.col, n.row)) continue;
        const j = hexIndex(cols, n.col, n.row);
        if (seen.has(j)) continue;
        seen.add(j);
        next.push(j);
        if (isLandLike(base[j]) && !excluded.has(j)) found.push(j);
      }
    }
    if (found.length > 0) return { hexes: found, distance };
    frontier = next;
  }
  return { hexes: [], distance: 0 };
}

const ELEVATION_RANK = new Map<Elevation, number>(ELEVATION_VALUES.map((v, i) => [v, i]));

export interface LandInputs {
  base: BaseData;
  elevation: (Elevation | null)[] | null;
  climate: (string | null)[] | null;
  vegetation: (string | null)[] | null;
  population: (number | null)[] | null;
  owner: (string | null)[] | null;
}

export interface LandFill {
  elevation?: Map<number, Elevation>;
  climate?: Map<number, string>;
  vegetation?: Map<number, string>;
  population?: Map<number, number>;
  owner?: Map<number, string | null>;
}

/**
 * Choose values for hexes that have just become land, for whichever layers the
 * caller passes. Each new hex borrows from the nearest existing land, so a
 * peninsula extends its neighbour's climate and cover and an island far out
 * takes after the closest shore.
 *
 *  - Elevation is the nearest land's commonest height, stepped down one when it
 *    is Highland or Mountains (new coast is lowland, not a cliff); an Island
 *    hex is Lowland, as a generated one would be.
 *  - Climate and vegetation are the nearest land's commonest values.
 *  - Population is 0: nobody lives on land that was just raised.
 *  - Polity ownership follows the neighbours only when most of the surrounding
 *    land is already claimed; otherwise the hex is left unclaimed.
 *
 * Only hexes that are currently empty in a layer are filled, so values already
 * there are never overwritten.
 */
export function inferNewLand(
  inputs: LandInputs,
  newLand: number[],
  cols: number,
  rows: number,
): LandFill {
  const fill: LandFill = {};
  const excluded = new Set(newLand);
  for (const i of newLand) {
    const { hexes, distance } = nearestLand(i, inputs.base, excluded, cols, rows);
    const donors = hexes;

    if (inputs.elevation && inputs.elevation[i] == null) {
      let value: Elevation = 'Lowland';
      if (!isIslandType(inputs.base[i])) {
        const picked = mode(
          donors.map((j) => inputs.elevation![j]).filter((v): v is Elevation => v != null),
          (a, b) => ELEVATION_RANK.get(a)! - ELEVATION_RANK.get(b)!,
        );
        if (picked) {
          value = picked === 'Highland' ? 'Hills' : picked === 'Mountains' ? 'Highland' : picked;
        }
      }
      (fill.elevation ??= new Map()).set(i, value);
    }

    if (inputs.climate && inputs.climate[i] == null) {
      const picked = mode(donors.map((j) => inputs.climate![j]).filter((v): v is string => v != null));
      if (picked) (fill.climate ??= new Map()).set(i, picked);
    }

    if (inputs.vegetation && inputs.vegetation[i] == null) {
      const picked = mode(donors.map((j) => inputs.vegetation![j]).filter((v): v is string => v != null));
      if (picked) (fill.vegetation ??= new Map()).set(i, picked);
    }

    if (inputs.population && inputs.population[i] == null) {
      (fill.population ??= new Map()).set(i, 0);
    }

    if (inputs.owner && distance === 1) {
      // Count unclaimed neighbours too: a hex beside one stray claim on an
      // otherwise empty coast should not grow a realm.
      const owners = donors.map((j) => inputs.owner![j] ?? null);
      const picked = mode(owners, (a, b) => (a === null ? 1 : b === null ? -1 : 0));
      if (picked && inputs.owner[i] == null) (fill.owner ??= new Map()).set(i, picked);
    }
  }
  return fill;
}
