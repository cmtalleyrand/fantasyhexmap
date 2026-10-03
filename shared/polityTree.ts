/**
 * Polity hierarchy: which polities are parts of which.
 *
 * `Polity.parentId` makes a forest. A link is valid only when it names
 * another polity in the same layer and following parents never returns to
 * where it started; anything else is dropped rather than guessed at, so every
 * consumer can assume a clean forest.
 */

import type { Polity } from './types.js';

/** Remove parent links that name nothing, name the polity itself, or close a loop. */
export function withValidParents(polities: Polity[]): { polities: Polity[]; dropped: number } {
  const ids = new Set(polities.map((p) => p.id));
  const parent = new Map<string, string>();
  let dropped = 0;
  for (const p of polities) {
    if (p.parentId === undefined) continue;
    if (!ids.has(p.parentId) || p.parentId === p.id) dropped++;
    else parent.set(p.id, p.parentId);
  }
  // Break each loop at the first link found on it, in list order.
  for (const p of polities) {
    const seen = new Set<string>([p.id]);
    let at = parent.get(p.id);
    while (at !== undefined) {
      if (seen.has(at)) {
        parent.delete(p.id);
        dropped++;
        break;
      }
      seen.add(at);
      at = parent.get(at);
    }
  }
  const out = polities.map((p) => {
    const want = parent.get(p.id);
    if (want === p.parentId) return p;
    const { parentId: _drop, ...rest } = p;
    return want ? { ...rest, parentId: want } : rest;
  });
  return { polities: out, dropped };
}

/** The chain from `id` up to its top-level polity, `id` first. */
export function ancestry(polities: Polity[], id: string): string[] {
  const byId = new Map(polities.map((p) => [p.id, p]));
  const chain: string[] = [];
  let at: string | undefined = id;
  while (at !== undefined && !chain.includes(at)) {
    chain.push(at);
    at = byId.get(at)?.parentId;
  }
  return chain;
}

/** The top-level polity `id` belongs to (itself, if it has no parent). */
export function topLevelOf(polities: Polity[], id: string): string {
  return ancestry(polities, id).at(-1) ?? id;
}

/** Every polity whose ancestry includes `id`, `id` itself included. */
export function descendantsOf(polities: Polity[], id: string): Set<string> {
  const out = new Set<string>();
  for (const p of polities) if (ancestry(polities, p.id).includes(id)) out.add(p.id);
  return out;
}

/** Whether making `parentId` the parent of `id` would close a loop. */
export function wouldCycle(polities: Polity[], id: string, parentId: string): boolean {
  return parentId === id || ancestry(polities, parentId).includes(id);
}

/**
 * The polities in display order: each top-level polity followed by its parts,
 * depth first, siblings in list order. `depth` is 0 for a top-level polity and
 * `parts` counts all its descendants, so a UI can group and indent a realm
 * with its provinces without reordering the stored list.
 */
export function polityOutline(polities: Polity[]): { polity: Polity; depth: number; parts: number }[] {
  const ids = new Set(polities.map((p) => p.id));
  const children = new Map<string, Polity[]>();
  const roots: Polity[] = [];
  for (const p of polities) {
    if (p.parentId && ids.has(p.parentId) && p.parentId !== p.id) {
      children.set(p.parentId, [...(children.get(p.parentId) ?? []), p]);
    } else roots.push(p);
  }
  const out: { polity: Polity; depth: number; parts: number }[] = [];
  const seen = new Set<string>();
  const visit = (p: Polity, depth: number): number => {
    if (seen.has(p.id)) return 0;
    seen.add(p.id);
    const slot = out.length;
    out.push({ polity: p, depth, parts: 0 });
    let parts = 0;
    for (const c of children.get(p.id) ?? []) {
      if (!seen.has(c.id)) parts += 1 + visit(c, depth + 1);
    }
    out[slot]!.parts = parts;
    return parts;
  };
  for (const p of roots) visit(p, 0);
  // Anything left sits on a loop; show it rather than lose it.
  for (const p of polities) visit(p, 0);
  return out;
}
