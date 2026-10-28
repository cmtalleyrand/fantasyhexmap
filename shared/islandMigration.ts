/**
 * Maps saved before islands were described by counts used four island types.
 * Each becomes an Islands hex with the spec that draws it the same way:
 *
 * - Island (one small islet) becomes Islands with one small island.
 * - Coastal Island (an islet against the shore) becomes Islands with one large
 *   island lying against the side it lay against.
 * - Large Island becomes Islands with one large island.
 * - Small Islands (a scatter) becomes Islands with three small islands.
 *
 * Maps saved when ice was a type of its own hold Ice hexes, which carry no land
 * values: they become Sea Ice (a Glacier is land and would need elevation).
 *
 * Maps saved when the shore was a type of its own hold Coastal Land hexes: they
 * become Land, whose shore is now derived from the water beside it (see
 * `migrateCoastalLand`).
 */

import { LEGACY_COASTAL_VALUE, LEGACY_ICE_VALUE, type BaseGeo, type HexShape, type IslandSpec, type LegacyIslandGeo, type MapHistorySnapshot, type MapState } from './types.js';

const LEGACY_SPECS: Record<LegacyIslandGeo, IslandSpec> = {
  Island: { large: 0, small: 1 },
  'Coastal Island': { large: 1, small: 0, coastal: { large: true } },
  'Large Island': { large: 1, small: 0 },
  'Small Islands': { large: 0, small: 3 },
};

function isLegacyIsland(value: unknown): value is LegacyIslandGeo {
  return typeof value === 'string' && value in LEGACY_SPECS;
}

function isLegacy(value: unknown): boolean {
  return isLegacyIsland(value) || value === LEGACY_ICE_VALUE;
}

/** The current type for a stored base value: legacy island types become Islands, Coastal Land becomes Land. */
export function currentBaseValue(value: BaseGeo | LegacyIslandGeo | typeof LEGACY_ICE_VALUE | typeof LEGACY_COASTAL_VALUE | null | undefined): BaseGeo | null | undefined {
  if (value === LEGACY_ICE_VALUE) return 'Sea Ice';
  if (value === LEGACY_COASTAL_VALUE) return 'Land';
  return isLegacyIsland(value) ? 'Islands' : value;
}

/**
 * Rewrite legacy island and ice types in the base layer (and its undo history) and
 * record their specs. Returns the same map when there is nothing to migrate.
 */
export function migrateLegacyIslands(map: MapState): MapState {
  const layer = map.layers?.base;
  const data = layer?.data as Array<BaseGeo | LegacyIslandGeo | typeof LEGACY_ICE_VALUE | null> | null | undefined;
  const hasLegacy = (values: unknown[] | null | undefined) => Boolean(values?.some(isLegacy));
  if (!layer || (!hasLegacy(data) && !layer.past?.some((s) => hasLegacy(s.data)) && !layer.future?.some((s) => hasLegacy(s.data)) && !map.islandSides)) {
    return map;
  }
  const specs: Record<string, IslandSpec> = { ...(map.islandSpecs ?? {}) };
  data?.forEach((value, i) => {
    if (!isLegacyIsland(value) || specs[String(i)]) return;
    const side = value === 'Coastal Island' ? map.islandSides?.[String(i)] : undefined;
    specs[String(i)] = { ...LEGACY_SPECS[value], ...(side !== undefined ? { side } : {}) };
  });
  const convert = <T>(values: T): T =>
    (Array.isArray(values) ? values.map((v) => currentBaseValue(v)) : values) as T;
  const { islandSides: _gone, ...rest } = map;
  return {
    ...rest,
    islandSpecs: specs,
    layers: {
      ...map.layers,
      base: {
        ...layer,
        data: convert(layer.data),
        past: (layer.past ?? []).map((s) => ({ ...s, data: convert(s.data) })),
        future: (layer.future ?? []).map((s) => ({ ...s, data: convert(s.data) })),
      },
    },
  };
}

type StoredBase = Array<BaseGeo | typeof LEGACY_COASTAL_VALUE | null>;

const hasCoastal = (values: unknown[] | null | undefined) => Boolean(values?.some((v) => v === LEGACY_COASTAL_VALUE));

function coastalSnapshot<T extends MapHistorySnapshot>(map: T): T {
  const layer = map.layers?.base;
  const shapes = map.hexShapes;
  const shapesStale = Boolean(shapes && Object.values(shapes).some((s) => (s.type as string) === LEGACY_COASTAL_VALUE));
  if (!layer || (!hasCoastal(layer.data as StoredBase | null) && !layer.past?.some((s) => hasCoastal(s.data as StoredBase | null))
    && !layer.future?.some((s) => hasCoastal(s.data as StoredBase | null)) && !shapesStale)) {
    return map;
  }
  const convert = <V>(values: V): V =>
    (Array.isArray(values) ? values.map((v) => (v === LEGACY_COASTAL_VALUE ? 'Land' : v)) : values) as V;
  const nextShapes: Record<string, HexShape> | undefined = shapes && shapesStale
    ? Object.fromEntries(Object.entries(shapes).map(([k, s]) => [k, (s.type as string) === LEGACY_COASTAL_VALUE ? { ...s, type: 'Land' as const } : s]))
    : shapes;
  return {
    ...map,
    ...(nextShapes ? { hexShapes: nextShapes } : {}),
    layers: {
      ...map.layers,
      base: {
        ...layer,
        data: convert(layer.data),
        past: (layer.past ?? []).map((s) => ({ ...s, data: convert(s.data) })),
        future: (layer.future ?? []).map((s) => ({ ...s, data: convert(s.data) })),
      },
    },
  };
}

/**
 * Rewrite Coastal Land as Land in the base layer, its layer history and the map's undo
 * history, and move settings made for Coastal Land hexes (`hexShapes`) to Land, where they
 * apply while the hex meets water. Returns the same map when there is nothing to migrate.
 */
export function migrateCoastalLand(map: MapState): MapState {
  const next = coastalSnapshot(map);
  const history = map.history;
  if (!history) return next;
  const past = history.past.map(coastalSnapshot);
  const future = history.future.map(coastalSnapshot);
  const historyChanged = past.some((s, k) => s !== history.past[k]) || future.some((s, k) => s !== history.future[k]);
  if (next === map && !historyChanged) return map;
  return { ...next, history: historyChanged ? { past, future } : history };
}

/** Every migration a loaded map goes through, oldest first. */
export function migrateMap(map: MapState): MapState {
  return migrateCoastalLand(migrateLegacyIslands(map));
}
