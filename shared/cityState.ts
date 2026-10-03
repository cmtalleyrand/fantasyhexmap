import type { City, Polity } from './types.js';

/** A city-state of up to this many hexes is named by its capital alone, unless the user chooses otherwise. */
export const DEFAULT_CITY_STATE_MAX_HEXES = 3;
export const CITY_STATE_MAX_HEXES_RANGE = { min: 1, max: 12 } as const;

export function parseCityStateMaxHexes(value: unknown): number {
  const n = typeof value === 'number' ? Math.round(value) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_CITY_STATE_MAX_HEXES;
  return Math.min(CITY_STATE_MAX_HEXES_RANGE.max, Math.max(CITY_STATE_MAX_HEXES_RANGE.min, n));
}

/**
 * The cities that stand in for their polity's name: for each small city-state,
 * its seat (the capital, else the most populous city in its own land). A
 * city-state with no city of its own, or larger than `maxHexes`,
 * is absent and is named like any other polity.
 * Returns polity id -> city id.
 */
export function cityStateSeats(
  polities: readonly Polity[],
  owner: readonly (string | null)[],
  cities: readonly City[],
  cols: number,
  maxHexes: number = DEFAULT_CITY_STATE_MAX_HEXES,
): Map<string, string> {
  const seats = new Map<string, string>();
  const candidates = polities.filter((p) => p.cityState);
  if (candidates.length === 0) return seats;
  const held = new Map<string, number>();
  for (const id of owner) if (id) held.set(id, (held.get(id) ?? 0) + 1);
  for (const polity of candidates) {
    if ((held.get(polity.id) ?? 0) > maxHexes) continue;
    const inside = cities.filter((c) => owner[c.row * cols + c.col] === polity.id);
    const seat = inside.find((c) => c.capital) ?? inside.reduce<City | null>((a, c) => (!a || c.population > a.population ? c : a), null);
    if (seat) seats.set(polity.id, seat.id);
  }
  return seats;
}
