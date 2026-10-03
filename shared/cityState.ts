import type { City, Polity } from './types.js';

/** A city-state holding fewer hexes than this is named by its capital alone. */
export const CITY_STATE_SMALL_HEXES = 7;

/**
 * The cities that stand in for their polity's name: for each small city-state,
 * its seat (the capital, else the most populous city in its own land). A
 * city-state with no city of its own, or too large to be known by one name,
 * is absent and is named like any other polity.
 * Returns polity id -> city id.
 */
export function cityStateSeats(
  polities: readonly Polity[],
  owner: readonly (string | null)[],
  cities: readonly City[],
  cols: number,
): Map<string, string> {
  const seats = new Map<string, string>();
  const candidates = polities.filter((p) => p.cityState);
  if (candidates.length === 0) return seats;
  const held = new Map<string, number>();
  for (const id of owner) if (id) held.set(id, (held.get(id) ?? 0) + 1);
  for (const polity of candidates) {
    if ((held.get(polity.id) ?? 0) >= CITY_STATE_SMALL_HEXES) continue;
    const inside = cities.filter((c) => owner[c.row * cols + c.col] === polity.id);
    const seat = inside.find((c) => c.capital) ?? inside.reduce<City | null>((a, c) => (!a || c.population > a.population ? c : a), null);
    if (seat) seats.set(polity.id, seat.id);
  }
  return seats;
}
