/**
 * Helpers for user-defined layers (see `CustomLayer`): making them, and the
 * edits the reducer applies to them. Pure, so the reducer and tests share them.
 */

import type { CustomCategory, CustomLayer, MapState } from './types.js';

/** Distinguishable on a map, and readable under a translucent overlay. */
export const CUSTOM_PALETTE = [
  '#e6550d', '#3182bd', '#31a354', '#756bb1', '#d6a000',
  '#c51b7d', '#00a6a6', '#8c564b', '#636363', '#e377c2',
];

export function customLayersOf(map: Pick<MapState, 'customLayers'>): CustomLayer[] {
  return map.customLayers ?? [];
}

let counter = 0;
export function newCustomId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** The next palette colour not already used by `categories`, cycling when all are. */
export function nextCategoryColour(categories: readonly CustomCategory[]): string {
  const used = new Set(categories.map((c) => c.colour.toLowerCase()));
  return CUSTOM_PALETTE.find((c) => !used.has(c)) ?? CUSTOM_PALETTE[categories.length % CUSTOM_PALETTE.length]!;
}

export function makeCustomCategory(categories: readonly CustomCategory[], name?: string): CustomCategory {
  return {
    id: newCustomId('cat'),
    name: name?.trim() || `Category ${categories.length + 1}`,
    colour: nextCategoryColour(categories),
  };
}

export function makeCustomLayer(name: string, existing: readonly CustomLayer[] = []): CustomLayer {
  const trimmed = name.trim() || `Custom layer ${existing.length + 1}`;
  return {
    id: newCustomId('custom'),
    name: trimmed,
    categories: [makeCustomCategory([], 'Marked')],
    values: {},
    shown: true,
  };
}

/** Give `indices` the category (or take them out of the layer when null); unknown categories are ignored. */
export function assignHexes(layer: CustomLayer, indices: readonly number[], categoryId: string | null): CustomLayer {
  if (categoryId !== null && !layer.categories.some((c) => c.id === categoryId)) return layer;
  const values = { ...layer.values };
  for (const i of indices) {
    if (categoryId === null) delete values[String(i)];
    else values[String(i)] = categoryId;
  }
  return { ...layer, values };
}

/** Drop a category and every hex that held it. */
export function withoutCategory(layer: CustomLayer, categoryId: string): CustomLayer {
  const values: Record<string, string> = {};
  for (const [index, id] of Object.entries(layer.values)) if (id !== categoryId) values[index] = id;
  return { ...layer, categories: layer.categories.filter((c) => c.id !== categoryId), values };
}

/** How many hexes hold each category. */
export function categoryCounts(layer: CustomLayer): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of Object.values(layer.values)) out.set(id, (out.get(id) ?? 0) + 1);
  return out;
}

/** True for `#rrggbb`; anything else would be passed straight into the drawn scene. */
export function isHexColour(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}
