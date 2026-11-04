import { inBounds, neighbourOf } from './hex.js';
import type { BaseData, BaseGeo } from './types.js';

/** Geography topology, distinct from elevation/settlement eligibility (a strait has land banks). */
export function geographyCategory(value: BaseGeo | null | undefined): 'land' | 'water' | null {
  switch (value) {
    case 'Land': case 'Glacier': case 'Mainland and islands': case 'Isthmus': case 'Strait': return 'land';
    case 'Sea': case 'Lake': case 'Sea Ice': case 'Islands': return 'water';
    default: return null;
  }
}

export interface GeographyIssue {
  hex: number;
  kind: 'passage-neighbours' | 'mainland-neighbours' | 'detached-water-land'
    | 'island-connection' | 'mainland-connection' | 'missing-islands' | 'passage-connection';
  message: string;
}

export const GEOGRAPHY_WARNING_PREFIX = 'Invalid geography at ';

export function geographyMessage(base: BaseData, cols: number, hex: number, detail: string): string {
  return `${GEOGRAPHY_WARNING_PREFIX}${hex % cols},${Math.floor(hex / cols)} (${base[hex]}): ${detail}`;
}

/** Missing/off-map cells are not invented as water. A passage needs all six actual neighbours. */
export function checkBaseGeography(base: BaseData, cols: number, rows: number): GeographyIssue[] {
  const issues: GeographyIssue[] = [];
  for (let hex = 0; hex < cols * rows; hex++) {
    const value = base[hex];
    if (value !== 'Mainland and islands' && value !== 'Isthmus' && value !== 'Strait') continue;
    let land = 0, water = 0;
    for (let edge = 0; edge < 6; edge++) {
      const n = neighbourOf(hex % cols, Math.floor(hex / cols), edge);
      if (!inBounds(cols, rows, n.col, n.row)) continue;
      const category = geographyCategory(base[n.row * cols + n.col]);
      if (category === 'land') land++;
      if (category === 'water') water++;
    }
    if (value === 'Mainland and islands') {
      if (land === 0 || water === 0) issues.push({ hex, kind: 'mainland-neighbours',
        message: geographyMessage(base, cols, hex, `needs at least one land neighbour and one water neighbour; found ${land} land and ${water} water.`) });
    } else if (land !== 2 || water !== 4) {
      issues.push({ hex, kind: 'passage-neighbours',
        message: geographyMessage(base, cols, hex, `needs exactly two land neighbours and four water neighbours; found ${land} land and ${water} water.`) });
    }
  }
  return issues;
}

/**
 * Correct generated geography before it becomes a map. An unsupported mainland becomes
 * islands, an inland mainland-and-islands hex becomes ordinary land, and an invalid
 * passage becomes the ordinary land/water its surroundings support. Never invent banks
 * or a land bridge just to justify a special type.
 */
export function correctBaseGeography(base: BaseData, cols: number, rows: number): BaseData {
  const data = [...base];
  const neighbours = (hex: number) => Array.from({ length: 6 }, (_, edge) => {
    const n = neighbourOf(hex % cols, Math.floor(hex / cols), edge);
    return inBounds(cols, rows, n.col, n.row) ? n.row * cols + n.col : -1;
  }).filter(h => h >= 0);
  // A group of mainland fragments cannot supply its own missing mainland. It needs
  // actual Land or Glacier somewhere in its connected land-bearing component.
  const seen = new Set<number>();
  for (let hex = 0; hex < data.length; hex++) {
    if (geographyCategory(data[hex]) !== 'land' || seen.has(hex)) continue;
    const group = [hex]; seen.add(hex);
    for (let at = 0; at < group.length; at++) for (const h of neighbours(group[at]!)) {
      if (!seen.has(h) && geographyCategory(data[h]) === 'land') { seen.add(h); group.push(h); }
    }
    if (!group.some(h => data[h] === 'Land' || data[h] === 'Glacier')) {
      for (const h of group) if (data[h] === 'Mainland and islands') data[h] = 'Islands';
    }
  }
  for (;;) {
    const invalid = checkBaseGeography(data, cols, rows);
    if (!invalid.length) return data;
    for (const { hex } of invalid) {
      const around = neighbours(hex).map(h => data[h]);
      const land = around.filter(v => geographyCategory(v) === 'land').length;
      if (data[hex] === 'Mainland and islands') data[hex] = land > 0 ? 'Land' : 'Islands';
      else if (land >= 2) data[hex] = 'Land';
      else if (data[hex] === 'Isthmus') data[hex] = 'Islands';
      else data[hex] = around.includes('Lake') && !around.includes('Sea') && !around.includes('Sea Ice') ? 'Lake' : 'Sea';
    }
  }
}
