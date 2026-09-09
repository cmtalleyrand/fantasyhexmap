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

import { recomputeCityFacts, isLandLike } from '../../shared/derive.js';
import { currentDepVersions, trimHistory } from '../../shared/layers.js';
import type {
  City,
  LayerDataMap,
  LayerId,
  LayerSnapshot,
  LayerState,
  MapState,
  Polity,
  River,
} from '../../shared/types.js';

export type Action =
  | { type: 'load'; map: MapState }
  | { type: 'setMeta'; name?: string; description?: string }
  | { type: 'applyGeneration'; layer: LayerId; data: LayerDataMap[LayerId]; warnings: string[]; notes: string | null }
  | { type: 'setHexValues'; layer: 'base' | 'elevation' | 'climate' | 'vegetation' | 'population'; indices: number[]; value: unknown }
  | { type: 'setPolityOwner'; indices: number[]; polityId: string | null }
  | { type: 'upsertPolity'; polity: Polity }
  | { type: 'removePolity'; id: string }
  | { type: 'upsertCity'; city: City }
  | { type: 'removeCity'; id: string }
  | { type: 'updateRiver'; river: River }
  | { type: 'removeRiver'; id: string }
  | { type: 'clearLayer'; layer: LayerId }
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

/** Commit a change to one layer: snapshot the old value, bump the version. */
function commit<K extends LayerId>(
  layer: LayerState<K>,
  next: Partial<LayerSnapshot<K>>,
): LayerState<K> {
  return {
    ...layer,
    ...next,
    version: layer.version + 1,
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

/**
 * Re-derive facts that are functions of other layers. Runs after any change to
 * base geography or rivers.
 */
function reconcile(map: MapState): MapState {
  const base = map.layers.base.data;
  if (!base) return map;
  const rivers = map.layers.rivers.data?.rivers ?? null;
  let layers = map.layers;

  const cities = layers.cities.data;
  if (cities) {
    const next = cities.cities
      .filter((c) => isLandLike(base[c.row * map.cols + c.col]))
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
      if (id && !isLandLike(base[i])) {
        dirty = true;
        return null;
      }
      return id;
    });
    if (dirty) {
      layers = { ...layers, polities: { ...layers.polities, data: { ...polities, owner } } };
    }
  }

  return layers === map.layers ? map : { ...map, layers };
}

export function reducer(map: MapState, action: Action): MapState {
  switch (action.type) {
    case 'load':
      return action.map;

    case 'setMeta':
      return {
        ...map,
        name: action.name ?? map.name,
        description: action.description ?? map.description,
        updatedAt: Date.now(),
      };

    case 'applyGeneration': {
      const layer = map.layers[action.layer];
      const next = withLayer(
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
      const next = withLayer(
        map,
        action.layer,
        commit(layer as LayerState, { data: data as LayerDataMap[LayerId] }),
      );
      return action.layer === 'base' ? reconcile(next) : next;
    }

    case 'setPolityOwner': {
      const layer = map.layers.polities;
      if (!layer.data) return map;
      const owner = layer.data.owner.slice();
      const base = map.layers.base.data;
      for (const i of action.indices) {
        if (i < 0 || i >= owner.length) continue;
        // The partition covers land only; a claim on water is not representable.
        if (action.polityId && base && !isLandLike(base[i])) continue;
        owner[i] = action.polityId;
      }
      return withLayer(map, 'polities', commit(layer, { data: { ...layer.data, owner } }));
    }

    case 'upsertPolity': {
      const layer = map.layers.polities;
      const current = layer.data ?? { polities: [], owner: new Array(map.cols * map.rows).fill(null) };
      const exists = current.polities.some((p) => p.id === action.polity.id);
      const polities = exists
        ? current.polities.map((p) => (p.id === action.polity.id ? action.polity : p))
        : [...current.polities, action.polity];
      return withLayer(map, 'polities', commit(layer, { data: { ...current, polities } }));
    }

    case 'removePolity': {
      const layer = map.layers.polities;
      if (!layer.data) return map;
      return withLayer(
        map,
        'polities',
        commit(layer, {
          data: {
            polities: layer.data.polities.filter((p) => p.id !== action.id),
            owner: layer.data.owner.map((id) => (id === action.id ? null : id)),
          },
        }),
      );
    }

    case 'upsertCity': {
      const layer = map.layers.cities;
      const current = layer.data ?? { cities: [] };
      const base = map.layers.base.data;
      const city = base
        ? recomputeCityFacts(action.city, base, map.cols, map.rows, map.layers.rivers.data?.rivers ?? null)
        : action.city;
      const exists = current.cities.some((c) => c.id === city.id);
      const cities = exists
        ? current.cities.map((c) => (c.id === city.id ? city : c))
        : [...current.cities, city];
      return withLayer(map, 'cities', commit(layer, { data: { cities } }));
    }

    case 'removeCity': {
      const layer = map.layers.cities;
      if (!layer.data) return map;
      return withLayer(
        map,
        'cities',
        commit(layer, { data: { cities: layer.data.cities.filter((c) => c.id !== action.id) } }),
      );
    }

    case 'updateRiver': {
      const layer = map.layers.rivers;
      if (!layer.data) return map;
      const next = withLayer(
        map,
        'rivers',
        commit(layer, {
          data: {
            rivers: layer.data.rivers.map((r) => (r.id === action.river.id ? action.river : r)),
          },
        }),
      );
      return reconcile(next);
    }

    case 'removeRiver': {
      const layer = map.layers.rivers;
      if (!layer.data) return map;
      const next = withLayer(
        map,
        'rivers',
        commit(layer, { data: { rivers: layer.data.rivers.filter((r) => r.id !== action.id) } }),
      );
      return reconcile(next);
    }

    case 'clearLayer': {
      const layer = map.layers[action.layer];
      if (!layer.data) return map;
      const next = withLayer(
        map,
        action.layer,
        commit(layer, { data: null, warnings: [], notes: null, generatedAt: null, depVersions: {} }),
      );
      return action.layer === 'base' || action.layer === 'rivers' ? reconcile(next) : next;
    }

    case 'undo': {
      const layer = map.layers[action.layer];
      const previous = layer.past[layer.past.length - 1];
      if (!previous) return map;
      const next = withLayer(map, action.layer, {
        ...layer,
        ...previous,
        version: layer.version + 1,
        past: layer.past.slice(0, -1),
        future: trimHistory([...layer.future, snapshotOf(layer)]),
      });
      return action.layer === 'base' || action.layer === 'rivers' ? reconcile(next) : next;
    }

    case 'redo': {
      const layer = map.layers[action.layer];
      const ahead = layer.future[layer.future.length - 1];
      if (!ahead) return map;
      const next = withLayer(map, action.layer, {
        ...layer,
        ...ahead,
        version: layer.version + 1,
        past: trimHistory([...layer.past, snapshotOf(layer)]),
        future: layer.future.slice(0, -1),
      });
      return action.layer === 'base' || action.layer === 'rivers' ? reconcile(next) : next;
    }

    default:
      return map;
  }
}
