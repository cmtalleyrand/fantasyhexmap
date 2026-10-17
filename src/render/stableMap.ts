import type { MapState } from '../../shared/types.js';

/**
 * For the build worker. Each message brings a fresh copy of the map, so every part of it is a new object.
 * The scene's caches (the traced coast above all, the costliest part of a build) are
 * kept by the identity of the map's parts; a part whose content has not changed is
 * swapped for the copy the last build used, so a display change or an edit to one
 * layer reuses everything the others allow.
 */
export function stableMap(): (map: MapState) => MapState {
  let previous: { map: MapState; text: Map<string, string> } | null = null;
  return (map) => {
    const text = new Map<string, string>();
    const reuse = <T>(key: string, value: T, old: T | undefined): T => {
      const json = JSON.stringify(value) ?? 'undefined';
      text.set(key, json);
      return old !== undefined && previous?.text.get(key) === json ? old : value;
    };
    const layers = { ...map.layers };
    for (const id of Object.keys(layers) as Array<keyof MapState['layers']>) {
      const old = previous?.map.layers[id];
      const data = reuse(`layer:${id}`, layers[id].data, old?.data as typeof layers[typeof id]['data'] | undefined);
      (layers as Record<string, unknown>)[id] = data === layers[id].data ? layers[id] : { ...layers[id], data };
    }
    const next = { ...map, layers } as MapState;
    for (const key of Object.keys(map) as Array<keyof MapState>) {
      if (key === 'layers') continue;
      (next as unknown as Record<string, unknown>)[key] = reuse(`map:${key}`, map[key], previous?.map[key]);
    }
    previous = { map: next, text };
    return next;
  };
}
