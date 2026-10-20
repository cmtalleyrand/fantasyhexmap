import type { MapState } from '../../shared/types.js';

/** Undo stacks and generation logs are not rendering inputs. */
export function renderSnapshot(map: MapState): MapState {
  return { ...map, history: undefined, journal: [], layers: Object.fromEntries(
    Object.entries(map.layers).map(([id, layer]) => [id, { ...layer, past: [], future: [], warnings: [], depVersions: {} }]),
  ) as unknown as MapState['layers'] };
}

/** Restore immutable identities lost to structured cloning at the worker boundary. */
function share(previous: unknown, next: unknown): unknown {
  if (Object.is(previous, next)) return previous;
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object'
    || Array.isArray(previous) !== Array.isArray(next)) return next;
  const a = previous as Record<string, unknown>, b = next as Record<string, unknown>;
  const keys = Object.keys(b);
  let equal = keys.length === Object.keys(a).length;
  let changed = false;
  const result = (Array.isArray(next) ? [...next] : { ...b }) as Record<string, unknown>;
  for (const key of keys) {
    const value = share(a[key], b[key]);
    if (!Object.prototype.hasOwnProperty.call(a, key) || value !== a[key]) equal = false;
    if (value !== b[key]) changed = true;
    result[key] = value;
  }
  return equal ? previous : changed ? result : next;
}

/** A bounded history also restores cache identity after undo/redo. */
export class SceneInputs {
  private maps: MapState[] = [];

  retain(map: MapState): MapState {
    for (const previous of this.maps) if (previous.id === map.id) map = share(previous, map) as MapState;
    this.maps.push(map);
    if (this.maps.length > 4) this.maps.shift();
    return map;
  }
}
