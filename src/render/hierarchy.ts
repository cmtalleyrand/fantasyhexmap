/**
 * How a polity hierarchy is drawn: the colour each polity is shown in, and
 * which level each polity's name is set at.
 */

import { ancestry } from '../../shared/polityTree.js';
import type { Polity } from '../../shared/types.js';
import { contrastingPolityColours } from './palette.js';

function mix(a: string, b: string, t: number): string {
  const pa = /^#([0-9a-f]{6})$/i.exec(a);
  const pb = /^#([0-9a-f]{6})$/i.exec(b);
  if (!pa || !pb) return a;
  const na = parseInt(pa[1]!, 16);
  const nb = parseInt(pb[1]!, 16);
  const ch = (s: number) => Math.round(((na >> s) & 255) * (1 - t) + ((nb >> s) & 255) * t);
  return `#${[16, 8, 0].map((s) => ch(s).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The colour each polity is drawn in. With `tints`, a polity that is part of
 * another is drawn as a shade of its parent's colour - siblings alternating
 * lighter and darker, stepping further for each pair - so a realm and its
 * provinces read as one family. Otherwise every polity keeps its own colour.
 */
export function polityDisplayColours(polities: Polity[], mode: 'own' | 'tints'): Map<string, string> {
  const out = new Map<string, string>();
  const byId = new Map(polities.map((p) => [p.id, p]));
  const resolve = (p: Polity, depth = 0): string => {
    const hit = out.get(p.id);
    if (hit) return hit;
    const parent = p.parentId ? byId.get(p.parentId) : undefined;
    let colour = p.colour;
    if (mode === 'tints' && parent && depth < polities.length) {
      const siblings = polities.filter((q) => q.parentId === parent.id);
      const k = siblings.indexOf(p);
      const step = 0.14 + 0.1 * Math.floor(k / 2);
      colour = mix(resolve(parent, depth + 1), k % 2 === 0 ? '#ffffff' : '#000000', Math.min(0.5, step));
    }
    out.set(p.id, colour);
    return colour;
  };
  for (const p of polities) resolve(p);
  return out;
}

/** Depth of each polity: 0 for a polity that is part of nothing. */
export function polityDepths(polities: Polity[]): Map<string, number> {
  return new Map(polities.map((p) => [p.id, ancestry(polities, p.id).length - 1]));
}

/**
 * The owner array seen at one level of the hierarchy: each hex attributed to
 * its owner's ancestor at `depth`, or null where the owner sits higher up.
 */
export function ownersAtDepth(polities: Polity[], owner: (string | null)[], depth: number): (string | null)[] {
  const chains = new Map(polities.map((p) => [p.id, ancestry(polities, p.id).reverse()]));
  return owner.map((id) => (id ? chains.get(id)?.[depth] ?? null : null));
}

/**
 * A realm colour softened for a style: pastel lifts it toward white, muted
 * pulls it toward a warm grey. Vivid leaves it as chosen.
 */
export function toned(colour: string, tone: 'vivid' | 'pastel' | 'muted'): string {
  if (tone === 'pastel') return mix(colour, '#ffffff', 0.45);
  if (tone === 'muted') return mix(mix(colour, '#8c877a', 0.42), '#ffffff', 0.08);
  return colour;
}

/**
 * Colours for "Assign contrasting colours" that respect the hierarchy:
 * top-level realms are made to contrast with their neighbours (judged over
 * each realm's whole territory, parts included), and every part takes a
 * shade of its realm's colour, so a realm and its provinces read as one
 * family while neighbouring realms stay distinct.
 */
export function contrastingRealmColours(
  polities: Polity[],
  owner: (string | null)[],
  cols: number,
  rows: number,
): Map<string, string> {
  const top = new Map(polities.map((p) => [p.id, ancestry(polities, p.id).at(-1)!]));
  const tops = polities.filter((p) => top.get(p.id) === p.id).map((p) => p.id);
  const topOwner = owner.map((id) => (id ? top.get(id) ?? null : null));
  const topColours = contrastingPolityColours(tops, topOwner, cols, rows);
  const seeded = polities.map((p) => (topColours.has(p.id) ? { ...p, colour: topColours.get(p.id)! } : p));
  return polityDisplayColours(seeded, 'tints');
}
