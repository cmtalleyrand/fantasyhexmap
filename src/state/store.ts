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
import { LAYER_META, normaliseSelection } from '../../shared/layers.js';
import type {
  City,
  Decision,
  JournalEntry,
  JournalKind,
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
  | { type: 'setPlan'; layers: LayerId[] }
  | {
      type: 'applyGeneration';
      layer: LayerId;
      data: LayerDataMap[LayerId];
      warnings: string[];
      notes: string | null;
      decisions?: Decision[];
      model?: string | null;
      instruction?: string | null;
      /** Omit the journal entry for changes that are not a generation (a hand-built river). */
      journal?: false;
    }
  | { type: 'setHexValues'; layer: 'base' | 'elevation' | 'climate' | 'vegetation' | 'population'; indices: number[]; value: unknown }
  | { type: 'setPolityOwner'; indices: number[]; polityId: string | null }
  | { type: 'upsertPolity'; polity: Polity }
  | { type: 'removePolity'; id: string }
  | { type: 'upsertCity'; city: City }
  | { type: 'removeCity'; id: string }
  | { type: 'addRiver'; river: River }
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

const MAX_JOURNAL = 400;

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
          kind: action.instruction ? 'instruct' : 'generate',
          instruction: action.instruction ?? null,
          summary: action.notes ?? `${LAYER_META[action.layer].label} generated.`,
          decisions: action.decisions ?? [],
          model: action.model ?? null,
          warnings: action.warnings.length,
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
      const target = action.polityId
        ? layer.data.polities.find((p) => p.id === action.polityId)?.name ?? 'a polity'
        : 'unclaimed';
      return journal(
        withLayer(map, 'polities', commit(layer, { data: { ...layer.data, owner } })),
        manualEntry(
          'polities',
          `Assigned ${action.indices.length} hex${action.indices.length === 1 ? '' : 'es'} to ${target} by hand.`,
        ),
      );
    }

    case 'upsertPolity': {
      const layer = map.layers.polities;
      const current = layer.data ?? { polities: [], owner: new Array(map.cols * map.rows).fill(null) };
      const exists = current.polities.some((p) => p.id === action.polity.id);
      const polities = exists
        ? current.polities.map((p) => (p.id === action.polity.id ? action.polity : p))
        : [...current.polities, action.polity];
      return journal(
        withLayer(map, 'polities', commit(layer, { data: { ...current, polities } })),
        manualEntry('polities', `${exists ? 'Edited' : 'Added'} the polity "${action.polity.name}" by hand.`),
      );
    }

    case 'removePolity': {
      const layer = map.layers.polities;
      if (!layer.data) return map;
      const removed = layer.data.polities.find((p) => p.id === action.id)?.name ?? 'a polity';
      return journal(
        withLayer(
          map,
          'polities',
          commit(layer, {
            data: {
              polities: layer.data.polities.filter((p) => p.id !== action.id),
              owner: layer.data.owner.map((id) => (id === action.id ? null : id)),
            },
          }),
        ),
        manualEntry('polities', `Removed the polity "${removed}" by hand.`),
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
      const next = journal(
        withLayer(
          map,
          'rivers',
          commit(layer, {
            data: {
              rivers: layer.data.rivers.map((r) => (r.id === action.river.id ? action.river : r)),
            },
          }),
        ),
        manualEntry('rivers', `Edited the river "${action.river.name}" by hand.`),
      );
      return reconcile(next);
    }

    case 'removeRiver': {
      const layer = map.layers.rivers;
      if (!layer.data) return map;
      const dropped = layer.data.rivers.find((r) => r.id === action.id)?.name ?? 'a river';
      const next = journal(
        withLayer(
          map,
          'rivers',
          commit(layer, { data: { rivers: layer.data.rivers.filter((r) => r.id !== action.id) } }),
        ),
        manualEntry('rivers', `Removed the river "${dropped}" by hand.`),
      );
      return reconcile(next);
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
          version: layer.version + 1,
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
          version: layer.version + 1,
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
