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
  Polity,
  River,
  TokenUsage,
} from '../../shared/types.js';

export type Action =
  | { type: 'load'; map: MapState }
  | { type: 'setMeta'; name?: string; description?: string }
  | { type: 'setHexDimensions'; hexDimensions: HexDimensions }
  | { type: 'setPlan'; layers: LayerId[] }
  | { type: 'setAllowUnderwater'; allow: boolean }
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
  | { type: 'upsertPolity'; polity: Polity }
  | { type: 'setPolityColours'; colours: Record<string, string> }
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
      layers = { ...layers, polities: { ...layers.polities, data: { ...polities, owner } } };
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
        withLayer(next, 'polities', commit(next.layers.polities, { data: { ...polities, owner } })),
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
      if (identicalData(layer.data.owner, owner)) return map;
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
      if (exists && identicalData(current.polities, polities)) return map;
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

    case 'setPolityColours': {
      const layer = map.layers.polities;
      if (!layer.data) return map;
      const polities = layer.data.polities.map((p) => ({ ...p, colour: action.colours[p.id] ?? p.colour }));
      if (identicalData(layer.data.polities, polities)) return map;
      return journal(
        withLayer(map, 'polities', commit(layer, { data: { ...layer.data, polities } })),
        manualEntry('polities', 'Assigned a contrasting colour set to polities.'),
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
