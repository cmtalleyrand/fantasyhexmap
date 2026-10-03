/**
 * Auto-shading: a part of a larger polity can take its colour as a shade of
 * its parent's, so a realm and its provinces read as one family and a change
 * to the realm's colour carries down to every part that follows it.
 *
 * `Polity.autoShade` marks a polity whose `colour` is derived this way. The
 * stored colour is kept in step (rather than computed only at draw time) so
 * exports, legends and the colour pickers all see the colour actually shown.
 */

import { ancestry } from './polityTree.js';
import type { Polity } from './types.js';

/** Linear blend of two #rrggbb colours; `a` is returned unchanged if either is malformed. */
export function mixHex(a: string, b: string, t: number): string {
  const pa = /^#([0-9a-f]{6})$/i.exec(a);
  const pb = /^#([0-9a-f]{6})$/i.exec(b);
  if (!pa || !pb) return a;
  const na = parseInt(pa[1]!, 16);
  const nb = parseInt(pb[1]!, 16);
  const ch = (s: number) => Math.round(((na >> s) & 255) * (1 - t) + ((nb >> s) & 255) * t);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The shade of `parentColour` for the `k`th part (0-based, in list order):
 * parts alternate lighter and darker, stepping further out for each pair.
 */
export function shadeOf(parentColour: string, k: number): string {
  const step = Math.min(0.5, 0.14 + 0.1 * Math.floor(k / 2));
  return mixHex(parentColour, k % 2 === 0 ? '#ffffff' : '#000000', step);
}

/**
 * Re-derive the colour of every auto-shaded polity from its parent's (already
 * resolved) colour, top of the tree first. Returns the same array when nothing
 * changes, so callers can detect a no-op by identity.
 */
export function applyAutoShade(polities: Polity[]): Polity[] {
  const depth = new Map(polities.map((p) => [p.id, ancestry(polities, p.id).length - 1]));
  const resolved = new Map(polities.map((p) => [p.id, p]));
  const order = [...polities].sort((a, b) => depth.get(a.id)! - depth.get(b.id)!);
  for (const p of order) {
    const parent = p.parentId ? resolved.get(p.parentId) : undefined;
    if (!p.autoShade) continue;
    if (!parent) {
      // Nothing to follow any more (its realm was removed or it was detached).
      const { autoShade: _drop, ...rest } = p;
      resolved.set(p.id, rest);
      continue;
    }
    const k = polities.filter((q) => q.parentId === parent.id).findIndex((q) => q.id === p.id);
    const colour = shadeOf(parent.colour, Math.max(0, k));
    if (colour !== p.colour) resolved.set(p.id, { ...p, colour });
  }
  const next = polities.map((p) => resolved.get(p.id)!);
  return next.every((p, i) => p === polities[i]) ? polities : next;
}
