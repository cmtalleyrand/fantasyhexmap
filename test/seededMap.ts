/** Render assertions must not inherit createMapState's wall-clock/random seed. */
import { createMapState as create } from '../shared/layers.ts';
export * from '../shared/layers.ts';
export function createMapState(...args: Parameters<typeof create>): ReturnType<typeof create> {
  const map = create(...args);
  map.id = `test-map:${JSON.stringify(args.slice(0, 4))}`;
  return map;
}
