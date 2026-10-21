import { isIslandType, islandSpecFor, type BaseData, type GeneratedIslandSettings, type HexShape, type IslandSpec } from './types.js';

/** Apply sparse generated settings identically in map state and multi-layer chat context. */
export function mergeGeneratedIslandSettings(
  previousBase: BaseData | null,
  base: BaseData,
  current: { islandSpecs?: Record<string, IslandSpec>; hexShapes?: Record<string, HexShape> },
  edits: GeneratedIslandSettings,
): { islandSpecs: Record<string, IslandSpec>; hexShapes: Record<string, HexShape> } {
  // A changed terrain type must not revive settings belonging to its previous type.
  const islandSpecs = Object.fromEntries(Object.entries(current.islandSpecs ?? {}).filter(([key]) =>
    isIslandType(base[Number(key)]) && previousBase?.[Number(key)] === base[Number(key)]));
  const hexShapes = Object.fromEntries(Object.entries(current.hexShapes ?? {}).filter(([key, shape]) =>
    base[Number(key)] === shape.type));
  for (const [key, spec] of Object.entries(edits.islandSpecs ?? {})) {
    const i = Number(key);
    if (Number.isInteger(i) && i >= 0 && i < base.length && isIslandType(base[i])) {
      islandSpecs[key] = islandSpecFor(base[i], spec);
    }
  }
  for (const [key, shape] of Object.entries(edits.hexShapes ?? {})) {
    const i = Number(key);
    if (Number.isInteger(i) && i >= 0 && i < base.length && isIslandType(base[i]) && shape.type === base[i]) {
      hexShapes[key] = { ...hexShapes[key], type: shape.type, irregular: shape.irregular };
    }
  }
  return { islandSpecs, hexShapes };
}
