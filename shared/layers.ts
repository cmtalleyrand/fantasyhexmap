/**
 * Layer metadata: dependency graph, unlock rules and staleness.
 *
 * `requires` are hard dependencies - the layer cannot be generated until they
 * exist. `uses` are soft: the layer is generated with them as context when they
 * are present, and goes stale when they change (or when one that did not exist
 * at generation time appears - that is how "vegetation was generated before the
 * rivers existed" surfaces in the UI).
 */

import {
  LAYER_ORDER,
  MAX_HISTORY,
  type LayerId,
  type LayerState,
  type LayersState,
  type MapState,
} from './types.js';

export interface LayerMeta {
  id: LayerId;
  label: string;
  blurb: string;
  requires: LayerId[];
  uses: LayerId[];
  /** true when the layer stores one value per hex rather than a feature list. */
  perHex: boolean;
}

export const LAYER_META: Record<LayerId, LayerMeta> = {
  base: {
    id: 'base',
    label: 'Base Geography',
    blurb: 'Land, Coastal Land, Sea, Lake, Ice and Island - the foundation every other layer sits on.',
    requires: [],
    uses: [],
    perHex: true,
  },
  elevation: {
    id: 'elevation',
    label: 'Elevation / Ruggedness',
    blurb: 'Lowland through Mountains, plus Plateau. Land-like hexes only.',
    requires: ['base'],
    uses: [],
    perHex: true,
  },
  climate: {
    id: 'climate',
    label: 'Climate',
    blurb: 'Full Köppen classification, driven by latitude, elevation and the description.',
    requires: ['base'],
    uses: ['elevation'],
    perHex: true,
  },
  vegetation: {
    id: 'vegetation',
    label: 'Vegetation',
    blurb: 'Ungrazed, grassland, forest and cultivated cover, coherent with climate and elevation.',
    requires: ['base'],
    uses: ['elevation', 'climate', 'rivers'],
    perHex: true,
  },
  rivers: {
    id: 'rivers',
    label: 'Rivers',
    blurb: 'Edge-to-edge water courses running downhill to a sea, lake or map edge.',
    requires: ['base'],
    uses: ['elevation'],
    perHex: false,
  },
  cities: {
    id: 'cities',
    label: 'Cities',
    blurb: 'Named settlements with populations, river access and edge-specific coastlines.',
    requires: ['base'],
    uses: ['elevation', 'climate', 'vegetation', 'rivers'],
    perHex: false,
  },
  polities: {
    id: 'polities',
    label: 'Polities',
    blurb: 'A strict partition of the land: every land hex belongs to one polity or none.',
    requires: ['base'],
    uses: ['elevation', 'rivers', 'cities'],
    perHex: false,
  },
  population: {
    id: 'population',
    label: 'Population',
    blurb: 'Background rural population per hex, distinct from city populations.',
    requires: ['base'],
    uses: ['elevation', 'climate', 'vegetation', 'rivers', 'cities', 'polities'],
    perHex: true,
  },
};

export function emptyLayer<K extends LayerId>(): LayerState<K> {
  return {
    data: null,
    warnings: [],
    notes: null,
    generatedAt: null,
    depVersions: {},
    version: 0,
    past: [],
    future: [],
  };
}

export function emptyLayers(): LayersState {
  const out = {} as LayersState;
  for (const id of LAYER_ORDER) {
    (out as Record<LayerId, LayerState>)[id] = emptyLayer();
  }
  return out;
}

export function createMapState(
  description: string,
  cols: number,
  rows: number,
  name = 'Untitled map',
  enabledLayers: LayerId[] = [...LAYER_ORDER],
): MapState {
  const now = Date.now();
  return {
    id: `map_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    description,
    cols,
    rows,
    createdAt: now,
    updatedAt: now,
    enabledLayers: normaliseSelection(enabledLayers),
    layers: emptyLayers(),
    journal: [],
  };
}

/**
 * A selection is only coherent if every hard dependency of a chosen layer is
 * chosen too, and base geography is always chosen - nothing works without it.
 * Returns the layers in pipeline order.
 */
export function normaliseSelection(selection: Iterable<LayerId>): LayerId[] {
  const chosen = new Set<LayerId>(selection);
  chosen.add('base');
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...chosen]) {
      for (const dep of LAYER_META[id].requires) {
        if (!chosen.has(dep)) {
          chosen.add(dep);
          grew = true;
        }
      }
    }
  }
  return LAYER_ORDER.filter((id) => chosen.has(id));
}

/** Layers a map does not plan to have; soft dependencies among these will never arrive. */
export function excludedLayers(map: MapState): LayerId[] {
  const enabled = new Set(map.enabledLayers ?? LAYER_ORDER);
  return LAYER_ORDER.filter((id) => !enabled.has(id));
}

export function isLayerEnabled(map: MapState, id: LayerId): boolean {
  return (map.enabledLayers ?? LAYER_ORDER).includes(id);
}

/** Enabled layers in pipeline order. */
export function plannedLayers(map: MapState): LayerId[] {
  const enabled = new Set(map.enabledLayers ?? LAYER_ORDER);
  return LAYER_ORDER.filter((id) => enabled.has(id));
}

/** Soft dependencies of `id` that this map has chosen not to have at all. */
export function excludedInfluences(map: MapState, id: LayerId): LayerId[] {
  const enabled = new Set(map.enabledLayers ?? LAYER_ORDER);
  return LAYER_META[id].uses.filter((dep) => !enabled.has(dep));
}

export function hasData(map: MapState, id: LayerId): boolean {
  return map.layers[id].data !== null;
}

/** A layer is unlocked once all of its hard dependencies have data. */
export function isUnlocked(map: MapState, id: LayerId): boolean {
  return LAYER_META[id].requires.every((dep) => hasData(map, dep));
}

export interface LayerPreset {
  id: string;
  label: string;
  blurb: string;
  layers: LayerId[];
}

/**
 * Starting points for the layer plan. Every one of these is a real way people
 * use a hex map, and each is far less work than the full pipeline on a big grid.
 */
export const LAYER_PRESETS: LayerPreset[] = [
  {
    id: 'everything',
    label: 'Everything',
    blurb: 'The full pipeline. Eight generations - slow and expensive on a large grid.',
    layers: [...LAYER_ORDER],
  },
  {
    id: 'physical',
    label: 'Physical world',
    blurb: 'Land, height, climate, cover and water. No people.',
    layers: ['base', 'elevation', 'climate', 'vegetation', 'rivers'],
  },
  {
    id: 'terrain',
    label: 'Terrain only',
    blurb: 'The shape of the land and its rivers - the quickest useful map.',
    layers: ['base', 'elevation', 'rivers'],
  },
  {
    id: 'political',
    label: 'Land and powers',
    blurb: 'Geography with settlements and borders, skipping the natural detail.',
    layers: ['base', 'elevation', 'cities', 'polities'],
  },
];

export function missingRequirements(map: MapState, id: LayerId): LayerId[] {
  return LAYER_META[id].requires.filter((dep) => !hasData(map, dep));
}

export interface StalenessReport {
  stale: boolean;
  reasons: string[];
}

/**
 * Compare the dependency versions recorded when the layer was last generated
 * with the versions those layers carry now.
 */
export function stalenessOf(map: MapState, id: LayerId): StalenessReport {
  const layer = map.layers[id];
  if (!layer.data || layer.generatedAt === null) return { stale: false, reasons: [] };
  const meta = LAYER_META[id];
  const reasons: string[] = [];
  for (const dep of [...meta.requires, ...meta.uses]) {
    const recorded = layer.depVersions[dep];
    const current = map.layers[dep].data ? map.layers[dep].version : undefined;
    if (recorded === undefined && current !== undefined) {
      reasons.push(`${LAYER_META[dep].label} was generated after this layer`);
    } else if (recorded !== undefined && current === undefined) {
      reasons.push(`${LAYER_META[dep].label} has been cleared`);
    } else if (recorded !== undefined && current !== undefined && recorded !== current) {
      reasons.push(`${LAYER_META[dep].label} changed`);
    }
  }
  return { stale: reasons.length > 0, reasons };
}

/** Versions to record against a layer generated right now. */
export function currentDepVersions(
  map: MapState,
  id: LayerId,
): Partial<Record<LayerId, number>> {
  const meta = LAYER_META[id];
  const out: Partial<Record<LayerId, number>> = {};
  for (const dep of [...meta.requires, ...meta.uses]) {
    if (map.layers[dep].data) out[dep] = map.layers[dep].version;
  }
  return out;
}

export function trimHistory<T>(stack: T[]): T[] {
  return stack.length > MAX_HISTORY ? stack.slice(stack.length - MAX_HISTORY) : stack;
}
