/**
 * Map state reducer.
 *
 * Two rules govern everything here:
 *  - Every committed change (a manual edit batch or an AI regeneration) pushes a
 *    snapshot onto that layer's own undo stack and bumps that layer's version.
 *    Versions are what staleness is computed from, so a change to an upstream
 *    layer marks downstream layers stale without touching their data.
 *  - Derived facts are recomputed, never edited. When base geography or rivers
 *    change, city coastlines and river flags are re-derived and polity claims on
 *    hexes that are no longer land are dropped. That is bookkeeping, not an edit:
 *    it does not create an undo entry and does not bump a version, because the
 *    layer is already flagged stale by the upstream change.
 */

import { recomputeCityFacts, canHoldSettlement } from '../../shared/derive.js';
import { hasLandShare, isIslandType, isShapedType, islandSpecFor, type HexShape, type IslandSpec, type Irregularity } from '../../shared/types.js';
import { migrateLegacyIslands } from '../../shared/islandMigration.js';
import { GEO_KIND_LABEL, geoEligibility, geoNamesOf, withMigratedGeoNames } from '../../shared/geoNames.js';
import { withValidParents } from '../../shared/polityTree.js';
import { applyAutoShade } from '../../shared/polityShade.js';
import { clampShare, pruneShares, withoutShares } from '../../shared/polityShares.js';
import {
  baseTransitions,
  clearedAt,
  inferNewLand,
  riversWithoutHexes,
} from '../../shared/landChange.js';
import { isLayerEnabled } from '../../shared/layers.js';
import { detachOrphanBranches, setRiverNavigability } from '../../shared/riverEdit.js';
import { cosmeticallyEqual, currentDepVersions, identicalData, trimHistory } from '../../shared/layers.js';
import { LAYER_META, normaliseSelection } from '../../shared/layers.js';
import { MAX_DIM, type PolitiesData } from '../../shared/types.js';
import type {
  City,
  Decision,
  JournalEntry,
  JournalKind,
  LayerDataMap,
  LayerId,
  BaseGeo,
  LayerSnapshot,
  LayerState,
  MapState,
  HexDimensions,
  MountainRange,
  GeoName,
  GeoNameKind,
  Polity,
  River,
  TokenUsage,
} from '../../shared/types.js';

/** A change to island hexes' specs: counts, coastal groups, and the side (null: automatic). */
export type IslandSpecChange = Partial<Omit<IslandSpec, 'side' | 'coastal'>> & { coastal?: IslandSpec['coastal']; side?: number | null };

/** A change to shaped hexes' land share and irregularity; null on a field puts that one back to the type's default. */
export interface HexShapeChange {
  land?: number | null;
  irregular?: Irregularity | null;
}

/** Hexes whose surface is open water: seas, lakes and straits, and the sea round islands. */
export function isWaterSurface(v: BaseGeo | null | undefined): boolean {
  return v === 'Sea' || v === 'Sea Ice' || v === 'Lake' || v === 'Strait' || v === 'Islands';
}

export type Action =
  | { type: 'load'; map: MapState }
  | { type: 'setMeta'; name?: string; description?: string }
  | { type: 'setHexDimensions'; hexDimensions: HexDimensions }
  | { type: 'setPlan'; layers: LayerId[] }
  | { type: 'setAllowUnderwater'; allow: boolean }
  /** Set the irregularity of every shaped hex that has none of its own; null goes back to each type's default. */
  | { type: 'setDefaultIrregularity'; irregular: Irregularity | null }
  /** Set the irregularity of lake shores whose land has none of its own; null goes back to the usual (Ragged). */
  | { type: 'setDefaultLakeIrregularity'; irregular: Irregularity | null }
  | { type: 'growMap'; amounts: GrowAmounts }
  | {
      type: 'applyGeneration';
      layer: LayerId;
      data: LayerDataMap[LayerId];
      warnings: string[];
      notes: string | null;
      decisions?: Decision[];
      model?: string | null;
      instruction?: string | null;
      /**
       * True when the layer was produced outside this app and pasted in. The
       * record has to say so: it must never imply the in-app model made a
       * choice that was actually made elsewhere.
       */
      imported?: boolean;
      /** Omit the journal entry for changes that are not a generation (a hand-built river). */
      journal?: false;
      usage?: TokenUsage | null;
      elapsedMs?: number;
    }
  | { type: 'setHexValues'; layer: 'base' | 'elevation' | 'climate' | 'vegetation' | 'population'; indices: number[]; value: unknown }
  | { type: 'setPolityOwner'; indices: number[]; polityId: string | null }
  /** Split hexes between two polities: `second` holds the fraction `share` of each, `first` the rest. */
  | { type: 'shareHexes'; indices: number[]; first: string; second: string; share: number }
  | { type: 'upsertPolity'; polity: Polity }
  /** `autoShade` also marks every part so it follows its realm from now on. */
  | { type: 'setPolityColours'; colours: Record<string, string>; autoShade?: boolean }
  | { type: 'setPolityAutoShade'; ids: string[]; on: boolean }
  | { type: 'removePolity'; id: string }
  | { type: 'upsertCity'; city: City }
  | { type: 'removeCity'; id: string }
  | { type: 'addRiver'; river: River }
  | { type: 'updateRiver'; river: River }
  | { type: 'removeRiver'; id: string }
  /** Replace several rivers by one built from them (see `mergeRivers`): one undo entry. */
  | { type: 'mergeRivers'; river: River; absorbed: string[] }
  | { type: 'setRiverNavigability'; indices: number[]; navigable: boolean; downstream: boolean }
  /** Put Mountains hexes in the range `id`, creating it if it does not exist. */
  | { type: 'nameMountainRange'; id: string; name: string; indices: number[] }
  | { type: 'renameMountainRange'; id: string; name: string }
  | { type: 'removeMountainRange'; id: string }
  /**
   * Put hexes in the geographical name `id`, creating it as a `kind` if it does
   * not exist. Hexes the kind cannot hold are ignored (see `geoEligibility`).
   */
  | { type: 'nameGeo'; id: string; kind: GeoNameKind; name: string; indices: number[] }
  /** Take hexes out of a name; a name left with none is removed. */
  | { type: 'unnameGeoHexes'; id: string; indices: number[] }
  | { type: 'renameGeo'; id: string; name: string }
  | { type: 'removeGeo'; id: string }
  /**
   * Change how the islands of island hexes are drawn: their counts, which
   * groups lie against the coast, and the side they lie against (null: the
   * side facing land). A null change restores each hex's default.
   */
  | {
      type: 'setIslandSpec';
      indices: number[];
      change: IslandSpecChange | null;
    }
  /**
   * Set the land share and irregularity of shaped hexes (coastal land, islands,
   * isthmus, strait, ice). A null change restores each hex's defaults.
   */
  | { type: 'setHexShape'; indices: number[]; change: HexShapeChange | null }
  | { type: 'clearLayer'; layer: LayerId }
  | { type: 'startLayer'; layer: LayerId }
  | { type: 'undo'; layer: LayerId }
  | { type: 'redo'; layer: LayerId };

function snapshotOf<K extends LayerId>(layer: LayerState<K>): LayerSnapshot<K> {
  return {
    data: layer.data,
    warnings: layer.warnings,
    notes: layer.notes,
    generatedAt: layer.generatedAt,
    depVersions: layer.depVersions,
  };
}

/**
 * The version a layer moves to when its data goes from `before` to `after`.
 * Only a change of substance bumps it: a rename or recolour leaves it alone, so
 * nothing downstream is marked stale by one (see `cosmeticallyEqual`).
 */
function nextVersion(version: number, before: unknown, after: unknown): number {
  return cosmeticallyEqual(before, after) ? version : version + 1;
}

/** Commit a change to one layer: snapshot the old value, bump the version if the change has substance. */
function commit<K extends LayerId>(
  layer: LayerState<K>,
  next: Partial<LayerSnapshot<K>>,
): LayerState<K> {
  return {
    ...layer,
    ...next,
    version: 'data' in next ? nextVersion(layer.version, layer.data, next.data) : layer.version + 1,
    past: trimHistory([...layer.past, snapshotOf(layer)]),
    future: [],
  };
}

function withLayer(map: MapState, id: LayerId, layer: LayerState): MapState {
  return {
    ...map,
    updatedAt: Date.now(),
    layers: { ...map.layers, [id]: layer },
  };
}

const MAX_JOURNAL = 400;

type GrowEdge = 'top' | 'bottom' | 'left' | 'right';

/** How many lines (0-2) to add on each side of the map. */
export interface GrowAmounts {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

/**
 * Insert one boundary line into a flat row-major grid. New cells take the mode
 * of the old cells touching that position (the mean for numeric population).
 * Thus the work is linear in the number of stored hexes, while each inferred
 * value examines at most three donors.
 */
function expandGrid<T>(
  data: T[],
  cols: number,
  rows: number,
  edge: GrowEdge,
  numeric = false,
): T[] {
  const nextCols = cols + (edge === 'left' || edge === 'right' ? 1 : 0);
  const nextRows = rows + (edge === 'top' || edge === 'bottom' ? 1 : 0);
  const colShift = edge === 'left' ? 1 : 0;
  const rowShift = edge === 'top' ? 1 : 0;
  const out = new Array<T>(nextCols * nextRows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      out[(row + rowShift) * nextCols + col + colShift] = data[row * cols + col]!;
    }
  }

  const newCells: Array<{ col: number; row: number }> = [];
  if (edge === 'top' || edge === 'bottom') {
    const row = edge === 'top' ? 0 : nextRows - 1;
    for (let col = 0; col < nextCols; col++) newCells.push({ col, row });
  } else {
    const col = edge === 'left' ? 0 : nextCols - 1;
    for (let row = 0; row < nextRows; row++) newCells.push({ col, row });
  }
  for (const cell of newCells) {
    const sourceCol = Math.min(cols - 1, Math.max(0, cell.col - colShift));
    const sourceRow = Math.min(rows - 1, Math.max(0, cell.row - rowShift));
    const donors: T[] = [];
    if (edge === 'top' || edge === 'bottom') {
      for (let dc = -1; dc <= 1; dc++) {
        const col = sourceCol + dc;
        if (col >= 0 && col < cols) donors.push(data[sourceRow * cols + col]!);
      }
    } else {
      for (let dr = -1; dr <= 1; dr++) {
        const row = sourceRow + dr;
        if (row >= 0 && row < rows) donors.push(data[row * cols + sourceCol]!);
      }
    }
    if (numeric) {
      const values = donors.filter((value): value is T & number => typeof value === 'number');
      out[cell.row * nextCols + cell.col] = (values.length
        ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
        : null) as T;
    } else {
      const counts = new Map<T, number>();
      for (const value of donors) counts.set(value, (counts.get(value) ?? 0) + 1);
      out[cell.row * nextCols + cell.col] = [...counts].reduce((best, item) => item[1] > best[1] ? item : best)[0];
    }
  }
  return out;
}

/**
 * Where each hex of a grid goes when the map is re-laid out, and how a flat
 * per-hex array is rebuilt for the new size.
 */
interface Relayout {
  nextCols: number;
  nextRows: number;
  place: (col: number, row: number) => { col: number; row: number };
  grid: <T>(data: T[], numeric: boolean) => T[];
}

/**
 * Grow the map by `amounts` lines per side.
 *
 * The grid is odd-r: odd rows sit half a hex east. A line added at the left,
 * right or bottom leaves every old hex where it was relative to its neighbours.
 * One row at the top turns every old even row odd, which would slide the map
 * half a hex and change which hexes touch (breaking rivers, coasts, island
 * sides), so it is done as a half-hex shift of the whole map and costs one extra
 * column. Two rows at the top keep every row's parity and need nothing extra.
 */
/** The amounts as whole numbers 0-2, and the size the map would reach (one row at the top adds a column). */
export function growPlan(map: Pick<MapState, 'cols' | 'rows'>, amounts: GrowAmounts) {
  const n = (v: number | undefined) => Math.max(0, Math.min(2, Math.floor(v ?? 0)));
  const top = n(amounts.top);
  const bottom = n(amounts.bottom);
  const left = n(amounts.left);
  const right = n(amounts.right);
  const sheared = top === 1 ? 1 : 0;
  const cols = map.cols + left + right + sheared;
  const rows = map.rows + top + bottom;
  return { top, bottom, left, right, sheared, cols, rows, fits: cols <= MAX_DIM && rows <= MAX_DIM };
}

function growMap(map: MapState, amounts: GrowAmounts): MapState {
  const { top, bottom, left, right, sheared, fits } = growPlan(map, amounts);
  if (top + bottom + left + right === 0 || !fits) return map;
  let next = map;
  const plain = (edge: GrowEdge) => {
    next = relayout(next, {
      nextCols: next.cols + (edge === 'left' || edge === 'right' ? 1 : 0),
      nextRows: next.rows + (edge === 'top' || edge === 'bottom' ? 1 : 0),
      place: (col, row) => ({ col: col + (edge === 'left' ? 1 : 0), row: row + (edge === 'top' ? 1 : 0) }),
      grid: (data, numeric) => expandGrid(data, next.cols, next.rows, edge, numeric),
    });
  };
  for (let i = 0; i < top; i++) plain('top');
  if (sheared) {
    // Every old row moves down one; the rows that become even move east a column
    // (their old neighbours keep their relative positions), the rest stay. The
    // gaps this leaves at the ends of rows copy the cell beside them.
    const cols = next.cols;
    next = relayout(next, {
      nextCols: cols + 1,
      nextRows: next.rows,
      place: (col, row) => ({ col: col + (row % 2 === 0 ? 1 : 0), row }),
      grid: (data) => {
        const out: typeof data = [];
        for (let row = 0; row < next.rows; row++) {
          const line = data.slice(row * cols, (row + 1) * cols);
          if (row % 2 === 0) out.push(line[0]!, ...line);
          else out.push(...line, line[cols - 1]!);
        }
        return out;
      },
    });
  }
  for (let i = 0; i < bottom; i++) plain('bottom');
  for (let i = 0; i < left; i++) plain('left');
  for (let i = 0; i < right; i++) plain('right');

  const parts: string[] = [];
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
  if (top) parts.push(`${plural(top, 'row')} at the top`);
  if (bottom) parts.push(`${plural(bottom, 'row')} at the bottom`);
  if (left) parts.push(`${plural(left, 'column')} on the left`);
  if (right) parts.push(`${plural(right, 'column')} on the right`);
  const note = sheared ? ' One row at the top shifts the grid half a hex, so a column was added too.' : '';
  return journal(
    reconcile(next),
    manualEntry('base', `Added ${parts.join(', ')} using neighbouring hexes.${note}`),
  );
}

/** The polities data with its share table replaced (dropped when empty). */
function withShares(data: PolitiesData, shares: PolitiesData['shares']): PolitiesData {
  const { shares: _old, ...rest } = data;
  return shares && Object.keys(shares).length > 0 ? pruneShares({ ...rest, shares }) : rest;
}

function relayout(map: MapState, to: Relayout): MapState {
  const { cols } = map;
  const { nextCols, nextRows, place } = to;
  const layers = { ...map.layers };
  for (const id of Object.keys(layers) as LayerId[]) {
    (layers as Record<LayerId, LayerState>)[id] = { ...layers[id], past: [], future: [] };
  }
  for (const id of ['base', 'elevation', 'climate', 'vegetation', 'population'] as const) {
    const layer = map.layers[id];
    if (!layer.data) continue;
    layers[id] = {
      ...layer,
      data: to.grid(layer.data as unknown[], id === 'population') as never,
      version: layer.version + 1,
      past: [],
      future: [],
    };
  }
  const expandedBase = layers.base.data;
  if (expandedBase) {
    for (const id of ['elevation', 'climate', 'vegetation', 'population'] as const) {
      const layer = layers[id];
      if (!layer.data) continue;
      layer.data = layer.data.map((value, index) => !isWaterSurface(expandedBase[index]) ? value : null) as never;
    }
  }
  const polities = map.layers.polities;
  if (polities.data) {
    layers.polities = {
      ...polities,
      data: {
        ...polities.data,
        owner: to.grid(polities.data.owner, false),
        ...(polities.data.shares
          ? {
              shares: Object.fromEntries(
                Object.entries(polities.data.shares).map(([index, share]) => {
                  const at = place(Number(index) % cols, Math.floor(Number(index) / cols));
                  return [String(at.row * nextCols + at.col), share];
                }),
              ),
            }
          : {}),
      },
      version: polities.version + 1,
      past: [],
      future: [],
    };
  }
  const cities = map.layers.cities;
  if (cities.data) {
    layers.cities = {
      ...cities,
      data: { cities: cities.data.cities.map((city) => ({ ...city, ...place(city.col, city.row) })) },
      version: cities.version + 1,
      past: [],
      future: [],
    };
  }
  const rivers = map.layers.rivers;
  if (rivers.data) {
    layers.rivers = {
      ...rivers,
      data: { rivers: rivers.data.rivers.map((river) => ({
        ...river,
        segments: river.segments.map((segment) => ({ ...segment, ...place(segment.col, segment.row) })),
      })) },
      version: rivers.version + 1,
      past: [],
      future: [],
    };
  }
  const remapIndex = (index: number) => {
    const at = place(index % cols, Math.floor(index / cols));
    return at.row * nextCols + at.col;
  };
  return {
    ...map,
    cols: nextCols,
    rows: nextRows,
    layers,
    mountainRanges: map.mountainRanges?.map((range) => ({ ...range, hexes: range.hexes.map(remapIndex) })),
    geoNames: geoNamesOf(map).map((name) => ({ ...name, hexes: name.hexes.map(remapIndex) })),
    waterNames: undefined,
    islandSpecs: map.islandSpecs
      ? Object.fromEntries(Object.entries(map.islandSpecs).map(([index, spec]) => [String(remapIndex(Number(index))), spec]))
      : map.islandSpecs,
    hexShapes: map.hexShapes
      ? Object.fromEntries(Object.entries(map.hexShapes).map(([index, shape]) => [String(remapIndex(Number(index))), shape]))
      : map.hexShapes,
    updatedAt: Date.now(),
  };
}

/**
 * Append to the record of how the map came to be. Human actions are logged
 * alongside the model's so the account never credits the AI with a choice a
 * person made - which is the whole point of keeping it.
 */
function journal(
  map: MapState,
  entry: Omit<JournalEntry, 'id' | 'at'> & Partial<Pick<JournalEntry, 'at'>>,
): MapState {
  const at = entry.at ?? Date.now();
  const next: JournalEntry = {
    ...entry,
    at,
    id: `j_${at.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
  };
  const all = [...(map.journal ?? []), next];
  return {
    ...map,
    journal: all.length > MAX_JOURNAL ? all.slice(all.length - MAX_JOURNAL) : all,
  };
}

const manualEntry = (layer: LayerId, summary: string) => ({
  layer,
  kind: 'manual' as JournalKind,
  instruction: null,
  summary,
  decisions: [],
  model: null,
  warnings: 0,
});

/**
 * Re-derive facts that are functions of other layers. Runs after any change to
 * base geography or rivers.
 */
function reconcile(map: MapState): MapState {
  const base = map.layers.base.data;
  if (!base) return map;
  const rivers = map.layers.rivers.data?.rivers ?? null;
  const allow = map.allowUnderwater === true;
  let layers = map.layers;

  const cities = layers.cities.data;
  if (cities) {
    const next = cities.cities
      .filter((c) => canHoldSettlement(base[c.row * map.cols + c.col], allow))
      .map((c) => recomputeCityFacts(c, base, map.cols, map.rows, rivers));
    const changed =
      next.length !== cities.cities.length ||
      next.some((c, i) => {
        const old = cities.cities[i]!;
        return (
          c.coastal !== old.coastal ||
          c.onRiver !== old.onRiver ||
          c.riverId !== old.riverId ||
          c.coastalEdges.join() !== old.coastalEdges.join()
        );
      });
    if (changed) {
      layers = { ...layers, cities: { ...layers.cities, data: { cities: next } } };
    }
  }

  const polities = layers.polities.data;
  if (polities) {
    let dirty = false;
    const owner = polities.owner.map((id, i) => {
      if (id && !canHoldSettlement(base[i], allow)) {
        dirty = true;
        return null;
      }
      return id;
    });
    if (dirty) {
      layers = { ...layers, polities: { ...layers.polities, data: pruneShares({ ...polities, owner }) } };
    }
  }

  return layers === map.layers ? map : { ...map, layers };
}

/**
 * Turning underwater settlement off removes what it permitted. Unlike routine
 * reconciliation this is a deliberate change to the cities and polities layers,
 * so it is committed and can be undone from each of them.
 */
function dropUnderwater(map: MapState): MapState {
  const base = map.layers.base.data;
  if (!base) return map;
  let next = map;
  const cities = map.layers.cities.data;
  if (cities) {
    const kept = cities.cities.filter((c) => canHoldSettlement(base[c.row * map.cols + c.col], false));
    if (kept.length !== cities.cities.length) {
      next = journal(
        withLayer(next, 'cities', commit(next.layers.cities, { data: { cities: kept } })),
        manualEntry('cities', `Removed ${cities.cities.length - kept.length} underwater cities.`),
      );
    }
  }
  const polities = map.layers.polities.data;
  if (polities) {
    let cleared = 0;
    const owner = polities.owner.map((id, i) => {
      if (id && !canHoldSettlement(base[i], false)) {
        cleared++;
        return null;
      }
      return id;
    });
    if (cleared > 0) {
      next = journal(
        withLayer(next, 'polities', commit(next.layers.polities, { data: pruneShares({ ...polities, owner }) })),
        manualEntry('polities', `Cleared polity claims from ${cleared} underwater hexes.`),
      );
    }
  }
  return next;
}

/**
 * Carry a base-geography edit through to the layers that sit on it.
 *
 * Hexes that went from land to Sea or Lake lose their elevation, climate,
 * vegetation and population, and any river running through them. Hexes that
 * went from Sea or Lake to land are filled in from the surrounding land for
 * every layer that is both planned and generated. These are real edits to those
 * layers, so each is committed and individually undoable.
 */
function propagateBaseEdit(
  map: MapState,
  before: BaseGeo[],
  after: BaseGeo[],
  indices: number[],
): MapState {
  const { toWater, toLand } = baseTransitions(before, after, indices);
  if (toWater.length === 0 && toLand.length === 0) return map;
  const { cols, rows } = map;
  let next = map;
  const notes: string[] = [];
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

  if (toWater.length > 0) {
    for (const id of ['elevation', 'climate', 'vegetation', 'population'] as const) {
      const layer = next.layers[id];
      if (!layer.data) continue;
      const cleared = clearedAt(layer.data as unknown[], toWater);
      if (!cleared) continue;
      next = withLayer(next, id, commit(layer as LayerState, { data: cleared as LayerDataMap[LayerId] }));
      notes.push(`cleared ${LAYER_META[id].label.toLowerCase()}`);
    }
    const rivers = next.layers.rivers.data;
    if (rivers) {
      const kept = detachOrphanBranches(riversWithoutHexes(rivers.rivers, new Set(toWater), after, cols, rows));
      const changed =
        kept.length !== rivers.rivers.length ||
        kept.some((r, i) => r !== rivers.rivers[i]);
      if (changed) {
        next = withLayer(next, 'rivers', commit(next.layers.rivers, { data: { rivers: kept } }));
        notes.push('trimmed rivers');
      }
    }
  }

  if (toLand.length > 0) {
    const active = (id: LayerId) => isLayerEnabled(next, id) && next.layers[id].data !== null;
    const fill = inferNewLand(
      {
        base: after,
        elevation: active('elevation') ? next.layers.elevation.data : null,
        climate: active('climate') ? next.layers.climate.data : null,
        vegetation: active('vegetation') ? next.layers.vegetation.data : null,
        population: active('population') ? next.layers.population.data : null,
        owner: active('polities') ? next.layers.polities.data!.owner : null,
      },
      toLand,
      cols,
      rows,
    );
    for (const id of ['elevation', 'climate', 'vegetation', 'population'] as const) {
      const values = fill[id] as Map<number, unknown> | undefined;
      if (!values || values.size === 0) continue;
      const layer = next.layers[id];
      const data = (layer.data as unknown[]).slice();
      for (const [i, v] of values) data[i] = v;
      next = withLayer(next, id, commit(layer as LayerState, { data: data as LayerDataMap[LayerId] }));
      notes.push(`filled ${LAYER_META[id].label.toLowerCase()}`);
    }
    if (fill.owner && fill.owner.size > 0) {
      const layer = next.layers.polities;
      const owner = layer.data!.owner.slice();
      for (const [i, v] of fill.owner) owner[i] = v;
      next = withLayer(next, 'polities', commit(layer, { data: { ...layer.data!, owner } }));
      notes.push('extended polity borders');
    }
  }

  if (notes.length === 0) return next;
  const parts: string[] = [];
  if (toWater.length > 0) parts.push(`${plural(toWater.length, 'hex')} became water`);
  if (toLand.length > 0) parts.push(`${plural(toLand.length, 'hex')} became land`);
  return journal(next, manualEntry('base', `${parts.join(' and ')}: ${notes.join(', ')}.`));
}

/**
 * The app's state: no map until one is loaded or created, then the map. Every
 * load, the first included, goes through the reducer so older saves are
 * migrated (see `migrateLegacyIslands`).
 */
export function appReducer(state: MapState | null, action: Action | { type: 'reset' }): MapState | null {
  if (action.type === 'reset') return null;
  if (action.type === 'load') return reducer(action.map, action);
  if (state === null) return null;
  return reducer(state, action);
}

export function reducer(map: MapState, action: Action): MapState {
  switch (action.type) {
    case 'load':
      return migrateLegacyIslands(action.map);

    case 'setMeta':
      return {
        ...map,
        name: action.name ?? map.name,
        description: action.description ?? map.description,
        updatedAt: Date.now(),
      };

    case 'setHexDimensions':
      return {
        ...map,
        hexDimensions: { ...action.hexDimensions },
        updatedAt: Date.now(),
      };

    case 'setPlan': {
      const next = normaliseSelection(action.layers);
      const before = new Set(map.enabledLayers ?? []);
      const after = new Set(next);
      const added = next.filter((id) => !before.has(id));
      const removed = [...before].filter((id) => !after.has(id));
      if (added.length === 0 && removed.length === 0) return map;
      const parts: string[] = [];
      if (added.length > 0) parts.push(`added ${added.map((id) => LAYER_META[id].label).join(', ')}`);
      if (removed.length > 0) {
        parts.push(`removed ${removed.map((id) => LAYER_META[id].label).join(', ')}`);
      }
      return journal({ ...map, enabledLayers: next, updatedAt: Date.now() }, {
        layer: added[0] ?? removed[0] ?? 'base',
        kind: 'manual',
        instruction: null,
        summary: `Changed the layer plan: ${parts.join('; ')}.`,
        decisions: [],
        model: null,
        warnings: 0,
      });
    }

    case 'setDefaultLakeIrregularity': {
      if ((map.defaultLakeIrregularity ?? null) === action.irregular) return map;
      const { defaultLakeIrregularity: _old, ...rest } = map;
      return journal(
        { ...rest, ...(action.irregular ? { defaultLakeIrregularity: action.irregular } : {}), updatedAt: Date.now() },
        manualEntry(
          'base',
          action.irregular
            ? `Set the default lake shore irregularity to ${action.irregular}.`
            : 'Put the default lake shore irregularity back to Ragged.',
        ),
      );
    }

    case 'setDefaultIrregularity': {
      if ((map.defaultIrregularity ?? null) === action.irregular) return map;
      const { defaultIrregularity: _old, ...rest } = map;
      return journal(
        { ...rest, ...(action.irregular ? { defaultIrregularity: action.irregular } : {}), updatedAt: Date.now() },
        manualEntry(
          'base',
          action.irregular
            ? `Set the default irregularity to ${action.irregular}.`
            : 'Put the default irregularity back to each type\'s own.',
        ),
      );
    }

    case 'setAllowUnderwater': {
      if ((map.allowUnderwater === true) === action.allow) return map;
      const next = journal(
        { ...map, allowUnderwater: action.allow, updatedAt: Date.now() },
        manualEntry(
          'base',
          action.allow
            ? 'Allowed cities and polities on Sea and Lake hexes.'
            : 'Disallowed cities and polities on Sea and Lake hexes.',
        ),
      );
      return action.allow ? next : dropUnderwater(next);
    }

    case 'growMap':
      return growMap(map, action.amounts);

    case 'applyGeneration': {
      const layer = map.layers[action.layer];
      let next = withLayer(
        map,
        action.layer,
        commit(layer, {
          data: action.data,
          warnings: action.warnings,
          notes: action.notes,
          generatedAt: Date.now(),
          depVersions: currentDepVersions(map, action.layer),
        }),
      );
      if (action.journal !== false) {
        next = journal(next, {
          layer: action.layer,
          kind: action.imported ? 'import' : action.instruction ? 'instruct' : 'generate',
          instruction: action.instruction ?? null,
          summary:
            action.notes ??
            `${LAYER_META[action.layer].label} ${action.imported ? 'imported.' : 'generated.'}`,
          decisions: action.decisions ?? [],
          model: action.model ?? null,
          warnings: action.warnings.length,
          ...(action.usage ? { usage: action.usage } : {}),
          ...(action.elapsedMs !== undefined ? { elapsedMs: action.elapsedMs } : {}),
        });
      }
      return action.layer === 'base' || action.layer === 'rivers' ? reconcile(next) : next;
    }

    case 'setHexValues': {
      const layer = map.layers[action.layer];
      if (!layer.data) return map;
      // Every layer this action targets stores a flat per-hex array.
      const data = (layer.data as unknown[]).slice();
      for (const i of action.indices) {
        if (i >= 0 && i < data.length) data[i] = action.value;
      }
      // A stroke over hexes that already hold the value changes nothing; do not record it.
      if (identicalData(layer.data, data)) return map;
      const value = action.value === null ? 'no value' : String(action.value);
      const next = journal(
        withLayer(
          map,
          action.layer,
          commit(layer as LayerState, { data: data as LayerDataMap[LayerId] }),
        ),
        manualEntry(
          action.layer,
          `Set ${action.indices.length} hex${action.indices.length === 1 ? '' : 'es'} to ${value} by hand.`,
        ),
      );
      if (action.layer !== 'base') return next;
      return reconcile(
        propagateBaseEdit(next, layer.data as BaseGeo[], data as BaseGeo[], action.indices),
      );
    }

    case 'setPolityOwner': {
      const layer = map.layers.polities;
      if (!layer.data) return map;
      const owner = layer.data.owner.slice();
      const base = map.layers.base.data;
      for (const i of action.indices) {
        if (i < 0 || i >= owner.length) continue;
        // Unless the map allows underwater polities the partition covers land only.
        if (action.polityId && base && !canHoldSettlement(base[i], map.allowUnderwater)) continue;
        owner[i] = action.polityId;
      }
      // Assigning a hex whole ends any sharing of it.
      const shares = withoutShares(layer.data.shares, action.indices);
      if (identicalData(layer.data.owner, owner) && identicalData(layer.data.shares, shares)) return map;
      const target = action.polityId
        ? layer.data.polities.find((p) => p.id === action.polityId)?.name ?? 'a polity'
        : 'unclaimed';
      return journal(
        withLayer(map, 'polities', commit(layer, { data: withShares({ ...layer.data, owner }, shares) })),
        manualEntry(
          'polities',
          `Assigned ${action.indices.length} hex${action.indices.length === 1 ? '' : 'es'} to ${target} by hand.`,
        ),
      );
    }

    case 'shareHexes': {
      const layer = map.layers.polities;
      if (!layer.data) return map;
      const { first, second } = action;
      const known = new Set(layer.data.polities.map((p) => p.id));
      if (first === second || !known.has(first) || !known.has(second)) return map;
      const share = clampShare(action.share);
      const base = map.layers.base.data;
      const owner = layer.data.owner.slice();
      const shares = { ...(layer.data.shares ?? {}) };
      let count = 0;
      for (const i of action.indices) {
        if (i < 0 || i >= owner.length) continue;
        if (base && !canHoldSettlement(base[i], map.allowUnderwater)) continue;
        // The larger holder is the hex's owner; an even split keeps the order given.
        const secondLarger = share > 0.5;
        owner[i] = secondLarger ? second : first;
        shares[String(i)] = secondLarger
          ? { polityId: first, share: 1 - share }
          : { polityId: second, share };
        count++;
      }
      if (count === 0) return map;
      const next = withShares({ ...layer.data, owner }, shares);
      if (identicalData(layer.data, next)) return map;
      const name = (id: string) => layer.data!.polities.find((p) => p.id === id)?.name ?? 'a polity';
      return journal(
        withLayer(map, 'polities', commit(layer, { data: next })),
        manualEntry(
          'polities',
          `Shared ${count} hex${count === 1 ? '' : 'es'} between ${name(first)} (${Math.round((1 - share) * 100)}%) and ${name(second)} (${Math.round(share * 100)}%) by hand.`,
        ),
      );
    }

    case 'upsertPolity': {
      const layer = map.layers.polities;
      const current = layer.data ?? { polities: [], owner: new Array(map.cols * map.rows).fill(null) };
      const exists = current.polities.some((p) => p.id === action.polity.id);
      // A parent link that would close a loop, or names nothing, is dropped.
      const polities = withValidParents(
        exists
          ? current.polities.map((p) => (p.id === action.polity.id ? action.polity : p))
          : [...current.polities, action.polity],
      ).polities;
      // A realm's colour change carries down to every part that follows it.
      const shaded = applyAutoShade(polities);
      if (exists && identicalData(current.polities, shaded)) return map;
      return journal(
        withLayer(map, 'polities', commit(layer, { data: { ...current, polities: shaded } })),
        manualEntry('polities', `${exists ? 'Edited' : 'Added'} the polity "${action.polity.name}" by hand.`),
      );
    }

    case 'removePolity': {
      const layer = map.layers.polities;
      if (!layer.data) return map;
      const removed = layer.data.polities.find((p) => p.id === action.id)?.name ?? 'a polity';
      // A hex shared with the removed polity passes whole to its other holder.
      const owner = layer.data.owner.map((id, i) => {
        if (id !== action.id) return id;
        const other = layer.data!.shares?.[String(i)]?.polityId;
        return other && other !== action.id ? other : null;
      });
      const shares = Object.fromEntries(
        Object.entries(layer.data.shares ?? {}).filter(([i, share]) => share.polityId !== action.id && layer.data!.owner[Number(i)] !== action.id),
      );
      return journal(
        withLayer(
          map,
          'polities',
          commit(layer, {
            data: {
              // Its parts become independent rather than pointing at nothing.
              polities: applyAutoShade(
                withValidParents(layer.data.polities.filter((p) => p.id !== action.id)).polities,
              ),
              owner,
              ...(Object.keys(shares).length > 0 ? { shares } : {}),
            },
          }),
        ),
        manualEntry('polities', `Removed the polity "${removed}" by hand.`),
      );
    }

    case 'setPolityColours': {
      const layer = map.layers.polities;
      if (!layer.data) return map;
      const polities = applyAutoShade(
        layer.data.polities.map((p) => ({
          ...p,
          colour: action.colours[p.id] ?? p.colour,
          ...(action.autoShade && p.parentId ? { autoShade: true } : {}),
        })),
      );
      if (identicalData(layer.data.polities, polities)) return map;
      return journal(
        withLayer(map, 'polities', commit(layer, { data: { ...layer.data, polities } })),
        manualEntry('polities', 'Assigned a contrasting colour set to polities.'),
      );
    }

    case 'setPolityAutoShade': {
      const layer = map.layers.polities;
      if (!layer.data) return map;
      const ids = new Set(action.ids);
      const polities = applyAutoShade(
        layer.data.polities.map((p) => {
          if (!ids.has(p.id)) return p;
          if (!action.on) {
            const { autoShade: _off, ...rest } = p;
            return rest;
          }
          return p.parentId ? { ...p, autoShade: true } : p;
        }),
      );
      if (identicalData(layer.data.polities, polities)) return map;
      return journal(
        withLayer(map, 'polities', commit(layer, { data: { ...layer.data, polities } })),
        manualEntry(
          'polities',
          action.on ? 'Set polities to take shades of their realm\'s colour.' : 'Stopped shading polities from their realm.',
        ),
      );
    }

    case 'upsertCity': {
      const layer = map.layers.cities;
      const current = layer.data ?? { cities: [] };
      const base = map.layers.base.data;
      // A city cannot be placed (or moved) onto water unless the map allows it.
      if (base && !canHoldSettlement(base[action.city.row * map.cols + action.city.col], map.allowUnderwater)) {
        return map;
      }
      const city = base
        ? recomputeCityFacts(action.city, base, map.cols, map.rows, map.layers.rivers.data?.rivers ?? null)
        : action.city;
      const exists = current.cities.some((c) => c.id === city.id);
      const cities = exists
        ? current.cities.map((c) => (c.id === city.id ? city : c))
        : [...current.cities, city];
      if (exists && identicalData(current.cities, cities)) return map;
      return journal(
        withLayer(map, 'cities', commit(layer, { data: { cities } })),
        manualEntry('cities', `${exists ? 'Edited' : 'Added'} the city "${city.name}" by hand.`),
      );
    }

    case 'removeCity': {
      const layer = map.layers.cities;
      if (!layer.data) return map;
      const gone = layer.data.cities.find((c) => c.id === action.id)?.name ?? 'a city';
      return journal(
        withLayer(
          map,
          'cities',
          commit(layer, { data: { cities: layer.data.cities.filter((c) => c.id !== action.id) } }),
        ),
        manualEntry('cities', `Removed the city "${gone}" by hand.`),
      );
    }

    case 'addRiver': {
      const layer = map.layers.rivers;
      const current = layer.data ?? { rivers: [] };
      const next = journal(
        withLayer(
          map,
          'rivers',
          commit(layer, { data: { rivers: [...current.rivers, action.river] } }),
        ),
        manualEntry('rivers', `Drew the river "${action.river.name}" by hand.`),
      );
      return reconcile(next);
    }

    case 'updateRiver': {
      const layer = map.layers.rivers;
      if (!layer.data) return map;
      const rivers = detachOrphanBranches(
        layer.data.rivers.map((r) => (r.id === action.river.id ? action.river : r)),
      );
      if (identicalData(layer.data.rivers, rivers)) return map;
      const next = journal(
        withLayer(map, 'rivers', commit(layer, { data: { rivers } })),
        manualEntry('rivers', `Edited the river "${action.river.name}" by hand.`),
      );
      return reconcile(next);
    }

    case 'mergeRivers': {
      const layer = map.layers.rivers;
      if (!layer.data) return map;
      const absorbed = new Set(action.absorbed);
      const names = layer.data.rivers.filter((r) => absorbed.has(r.id)).map((r) => `"${r.name}"`);
      const rivers = detachOrphanBranches(
        layer.data.rivers
          .filter((r) => !absorbed.has(r.id))
          .map((r) => (r.id === action.river.id ? action.river : r))
          // Branches of a river that was folded in now leave the joined one.
          .map((r) => (r.branchOf && absorbed.has(r.branchOf) ? { ...r, branchOf: action.river.id } : r)),
      );
      const next = journal(
        withLayer(map, 'rivers', commit(layer, { data: { rivers } })),
        manualEntry('rivers', `Joined ${names.join(', ')} into the river "${action.river.name}" by hand.`),
      );
      return reconcile(next);
    }

    case 'setRiverNavigability': {
      const layer = map.layers.rivers;
      if (!layer.data) return map;
      const rivers = setRiverNavigability(
        layer.data.rivers,
        new Set(action.indices),
        action.navigable,
        action.downstream,
        map.cols,
      );
      if (rivers === layer.data.rivers) return map;
      const touched = rivers.filter((r, i) => r !== layer.data!.rivers[i]).map((r) => `"${r.name}"`);
      return reconcile(
        journal(
          withLayer(map, 'rivers', commit(layer, { data: { rivers } })),
          manualEntry(
            'rivers',
            `Marked part of ${touched.join(', ')} ${action.navigable ? 'navigable' : 'not navigable'} by hand.`,
          ),
        ),
      );
    }

    case 'removeRiver': {
      const layer = map.layers.rivers;
      if (!layer.data) return map;
      const dropped = layer.data.rivers.find((r) => r.id === action.id)?.name ?? 'a river';
      const next = journal(
        withLayer(
          map,
          'rivers',
          commit(layer, {
            data: { rivers: detachOrphanBranches(layer.data.rivers.filter((r) => r.id !== action.id)) },
          }),
        ),
        manualEntry('rivers', `Removed the river "${dropped}" by hand.`),
      );
      return reconcile(next);
    }

    case 'nameMountainRange': {
      const name = action.name.trim();
      const elevation = map.layers.elevation.data;
      if (!name || !elevation) return map;
      const picked = new Set(action.indices.filter((i) => elevation[i] === 'Mountains'));
      if (picked.size === 0) return map;
      const ranges = map.mountainRanges ?? [];
      const existing = ranges.find((r) => r.id === action.id);
      // A hex belongs to one range, so claiming it takes it from any other.
      const others = ranges
        .filter((r) => r.id !== action.id)
        .map((r) => ({ ...r, hexes: r.hexes.filter((i) => !picked.has(i)) }))
        .filter((r) => r.hexes.length > 0);
      const range: MountainRange = {
        id: action.id,
        name,
        hexes: [...new Set([...(existing?.hexes ?? []), ...picked])].sort((a, b) => a - b),
      };
      return journal(
        { ...map, mountainRanges: [...others, range], updatedAt: Date.now() },
        manualEntry(
          'elevation',
          `${existing ? 'Extended' : 'Named'} the mountain range "${name}" (${range.hexes.length} hexes) by hand.`,
        ),
      );
    }

    case 'renameMountainRange': {
      const name = action.name.trim();
      const ranges = map.mountainRanges ?? [];
      const old = ranges.find((r) => r.id === action.id);
      if (!old || !name || old.name === name) return map;
      return journal(
        {
          ...map,
          mountainRanges: ranges.map((r) => (r.id === action.id ? { ...r, name } : r)),
          updatedAt: Date.now(),
        },
        manualEntry('elevation', `Renamed the mountain range "${old.name}" to "${name}".`),
      );
    }

    case 'removeMountainRange': {
      const ranges = map.mountainRanges ?? [];
      const old = ranges.find((r) => r.id === action.id);
      if (!old) return map;
      return journal(
        { ...map, mountainRanges: ranges.filter((r) => r.id !== action.id), updatedAt: Date.now() },
        manualEntry('elevation', `Removed the mountain range "${old.name}".`),
      );
    }

    case 'nameGeo': {
      const name = action.name.trim();
      const base = map.layers.base.data;
      if (!name || !base) return map;
      const eligible = geoEligibility(action.kind, base, map.cols, map.rows);
      const picked = new Set(action.indices.filter(eligible));
      if (picked.size === 0) return map;
      const names = geoNamesOf(map);
      const existing = names.find((n) => n.id === action.id);
      if (existing && existing.kind !== action.kind) return map;
      // Within a kind a hex carries one name, so claiming it takes it from any other.
      const others = names
        .filter((n) => n.id !== action.id)
        .map((n) => (n.kind === action.kind ? { ...n, hexes: n.hexes.filter((i) => !picked.has(i)) } : n))
        .filter((n) => n.hexes.length > 0);
      const entry: GeoName = {
        id: action.id,
        name: existing?.name ?? name,
        kind: action.kind,
        hexes: [...new Set([...(existing?.hexes ?? []), ...picked])].sort((a, b) => a - b),
      };
      const what = GEO_KIND_LABEL[action.kind].singular.toLowerCase();
      return journal(
        { ...withMigratedGeoNames(map), geoNames: [...others, entry], updatedAt: Date.now() },
        manualEntry('base', `${existing ? 'Extended' : 'Named'} the ${what} "${entry.name}" (${entry.hexes.length} hexes) by hand.`),
      );
    }

    case 'unnameGeoHexes': {
      const names = geoNamesOf(map);
      const old = names.find((n) => n.id === action.id);
      if (!old) return map;
      const drop = new Set(action.indices);
      const hexes = old.hexes.filter((i) => !drop.has(i));
      if (hexes.length === old.hexes.length) return map;
      const next = hexes.length > 0 ? names.map((n) => (n.id === old.id ? { ...n, hexes } : n)) : names.filter((n) => n.id !== old.id);
      return journal(
        { ...withMigratedGeoNames(map), geoNames: next, updatedAt: Date.now() },
        manualEntry(
          'base',
          hexes.length > 0
            ? `Took ${old.hexes.length - hexes.length} hexes out of "${old.name}".`
            : `Removed the name "${old.name}": no hexes were left.`,
        ),
      );
    }

    case 'renameGeo': {
      const name = action.name.trim();
      const names = geoNamesOf(map);
      const old = names.find((n) => n.id === action.id);
      if (!old || !name || old.name === name) return map;
      return journal(
        {
          ...withMigratedGeoNames(map),
          geoNames: names.map((n) => (n.id === action.id ? { ...n, name } : n)),
          updatedAt: Date.now(),
        },
        manualEntry('base', `Renamed "${old.name}" to "${name}".`),
      );
    }

    case 'removeGeo': {
      const names = geoNamesOf(map);
      const old = names.find((n) => n.id === action.id);
      if (!old) return map;
      return journal(
        { ...withMigratedGeoNames(map), geoNames: names.filter((n) => n.id !== action.id), updatedAt: Date.now() },
        manualEntry('base', `Removed the name "${old.name}".`),
      );
    }

    case 'setIslandSpec': {
      const base = map.layers.base.data;
      if (!base) return map;
      const specs = { ...(map.islandSpecs ?? {}) };
      let changed = 0;
      for (const i of action.indices) {
        if (!isIslandType(base[i])) continue;
        const key = String(i);
        const before = JSON.stringify(specs[key] ?? null);
        if (action.change === null) delete specs[key];
        else {
          const current = islandSpecFor(base[i], specs[key]);
          const { side, coastal, ...counts } = action.change;
          const next: IslandSpec = { ...current, ...counts, coastal: { ...current.coastal, ...coastal } };
          if (side === null) delete next.side;
          else if (side !== undefined) next.side = side;
          specs[key] = islandSpecFor(base[i], next);
        }
        if (JSON.stringify(specs[key] ?? null) !== before) changed++;
      }
      if (changed === 0) return map;
      return journal(
        { ...map, islandSpecs: specs, updatedAt: Date.now() },
        manualEntry('base', `Changed the islands of ${changed} hex${changed === 1 ? '' : 'es'} by hand.`),
      );
    }

    case 'setHexShape': {
      const base = map.layers.base.data;
      if (!base) return map;
      const shapes = { ...(map.hexShapes ?? {}) };
      let changed = 0;
      for (const i of action.indices) {
        const value = base[i];
        if (!isShapedType(value) && !hasLandShare(value)) continue;
        const key = String(i);
        const before = JSON.stringify(shapes[key] ?? null);
        const kept = shapes[key]?.type === value ? shapes[key]! : undefined;
        let next: HexShape | undefined = { type: value!, ...(kept?.land !== undefined ? { land: kept.land } : {}), ...(kept?.irregular ? { irregular: kept.irregular } : {}) };
        const change = action.change;
        if (change === null) next = undefined;
        else {
          if (change.land === null) delete next.land;
          else if (change.land !== undefined && hasLandShare(value)) next.land = Math.max(0, Math.min(100, Math.round(change.land)));
          if (change.irregular === null) delete next.irregular;
          else if (change.irregular !== undefined && isShapedType(value)) next.irregular = change.irregular;
          if (next.land === undefined && next.irregular === undefined) next = undefined;
        }
        if (next) shapes[key] = next;
        else delete shapes[key];
        if (JSON.stringify(shapes[key] ?? null) !== before) changed++;
      }
      if (changed === 0) return map;
      return journal(
        { ...map, hexShapes: shapes, updatedAt: Date.now() },
        manualEntry('base', `Changed the land share or irregularity of ${changed} hex${changed === 1 ? '' : 'es'} by hand.`),
      );
    }

    case 'startLayer': {
      // Begins an empty layer by hand: nothing assigned yet, ready to be painted.
      const layer = map.layers[action.layer];
      if (layer.data) return map;
      const n = map.cols * map.rows;
      const empty: LayerDataMap[LayerId] =
        action.layer === 'base'
          ? (new Array(n).fill('Sea') as BaseGeo[])
          : action.layer === 'polities'
            ? { polities: [], owner: new Array(n).fill(null) }
            : action.layer === 'cities'
              ? { cities: [] }
              : action.layer === 'rivers'
                ? { rivers: [] }
                : (new Array(n).fill(null) as LayerDataMap[LayerId]);
      const next = journal(
        withLayer(
          map,
          action.layer,
          commit(layer as LayerState, {
            data: empty,
            warnings: [],
            notes: null,
            generatedAt: Date.now(),
            depVersions: currentDepVersions(map, action.layer),
          }),
        ),
        manualEntry(action.layer, `Started the ${LAYER_META[action.layer].label} layer by hand.`),
      );
      return action.layer === 'base' || action.layer === 'rivers' ? reconcile(next) : next;
    }

    case 'clearLayer': {
      const layer = map.layers[action.layer];
      if (!layer.data) return map;
      const next = journal(
        withLayer(
          map,
          action.layer,
          commit(layer, { data: null, warnings: [], notes: null, generatedAt: null, depVersions: {} }),
        ),
        manualEntry(action.layer, `Cleared the ${LAYER_META[action.layer].label} layer.`),
      );
      return action.layer === 'base' || action.layer === 'rivers' ? reconcile(next) : next;
    }

    case 'undo': {
      const layer = map.layers[action.layer];
      const previous = layer.past[layer.past.length - 1];
      if (!previous) return map;
      const next = journal(
        withLayer(map, action.layer, {
          ...layer,
          ...previous,
          version: nextVersion(layer.version, layer.data, previous.data),
          past: layer.past.slice(0, -1),
          future: trimHistory([...layer.future, snapshotOf(layer)]),
        }),
        {
          ...manualEntry(action.layer, `Undid the last change to ${LAYER_META[action.layer].label}.`),
          kind: 'undo' as JournalKind,
        },
      );
      return action.layer === 'base' || action.layer === 'rivers' ? reconcile(next) : next;
    }

    case 'redo': {
      const layer = map.layers[action.layer];
      const ahead = layer.future[layer.future.length - 1];
      if (!ahead) return map;
      const next = journal(
        withLayer(map, action.layer, {
          ...layer,
          ...ahead,
          version: nextVersion(layer.version, layer.data, ahead.data),
          past: trimHistory([...layer.past, snapshotOf(layer)]),
          future: layer.future.slice(0, -1),
        }),
        {
          ...manualEntry(action.layer, `Redid a change to ${LAYER_META[action.layer].label}.`),
          kind: 'redo' as JournalKind,
        },
      );
      return action.layer === 'base' || action.layer === 'rivers' ? reconcile(next) : next;
    }

    default:
      return map;
  }
}
