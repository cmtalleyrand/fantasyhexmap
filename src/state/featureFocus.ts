import { hexIndex } from '../../shared/hex.js';
import { holdersOf } from '../../shared/polityShares.js';
import { isRangeElevation, type LayerId, type MapState } from '../../shared/types.js';

/** Saved feature extent, independent of hexes selected for the next edit. */
export function featureFocus(map: MapState, layer: LayerId, id: string | null | undefined) {
  if (!id) return null;
  if (layer === 'elevation') {
    const range = map.mountainRanges?.find(r => r.id === id);
    return range ? { id, name: range.name, kind: 'Mountain range', editable: true,
      hexes: range.hexes.filter(i => isRangeElevation(map.layers.elevation.data?.[i])) } : null;
  }
  if (layer === 'polities') {
    const data = map.layers.polities.data, polity = data?.polities.find(p => p.id === id);
    return data && polity ? { id, name: polity.name, kind: 'Polity', editable: true,
      hexes: data.owner.flatMap((_, i) => holdersOf(data, i).some(([holder]) => holder === id) ? [i] : []) } : null;
  }
  if (layer === 'cities') {
    const city = map.layers.cities.data?.cities.find(c => c.id === id);
    return city ? { id, name: city.name, kind: 'City', editable: false, hexes: [hexIndex(map.cols, city.col, city.row)] } : null;
  }
  if (layer === 'rivers') {
    const river = map.layers.rivers.data?.rivers.find(r => r.id === id);
    return river ? { id, name: river.name || 'Unnamed river', kind: 'River', editable: false,
      hexes: [...new Set(river.segments.map(s => hexIndex(map.cols, s.col, s.row)))] } : null;
  }
  return null;
}
