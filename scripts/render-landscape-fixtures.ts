import { createMapState } from '../shared/layers.ts';
import type { BaseGeo, MapState } from '../shared/types.ts';

/** Representative geography for visual review, separate from the fixed timing fixtures. */
export function landscapeGallery(): Array<{ name: string; map: MapState }> {
  const cols = 48, rows = 36;
  const map = createMapState('Large continent with three inland lakes', cols, rows);
  map.id = 'review-continent-large-lakes';
  map.description = 'One large continent, two coastal bays, three multi-hex inland lakes, and a three-hex island in the western lake.';
  map.defaultIrregularity = 'Wavy';
  map.defaultLakeIrregularity = 'Wavy';
  const ellipse = (col: number, row: number, x: number, y: number, rx: number, ry: number) =>
    ((col - x) / rx) ** 2 + ((row - y) / ry) ** 2 <= 1;
  const base: BaseGeo[] = Array.from({ length: cols * rows }, (_, h) => {
    const col = h % cols, row = Math.floor(h / cols);
    if (!ellipse(col, row, 24, 18, 21, 16)) return 'Sea';
    if (ellipse(col, row, 5, 14, 5, 3.5) || ellipse(col, row, 44, 23, 5, 3.5)) return 'Sea';
    return 'Land';
  });
  const lakes = [
    { id: 'western-lake', name: 'Western Lake', x: 18, y: 14, rx: 4.4, ry: 3.2 },
    { id: 'southern-lake', name: 'Southern Lake', x: 29, y: 23, rx: 4.8, ry: 3.5 },
    { id: 'northern-lake', name: 'Northern Lake', x: 30, y: 10, rx: 3.5, ry: 1.7 },
  ];
  for (const lake of lakes) for (let h = 0; h < base.length; h++) {
    if (base[h] === 'Land' && ellipse(h % cols, Math.floor(h / cols), lake.x, lake.y, lake.rx, lake.ry)) base[h] = 'Lake';
  }
  // An actual island inside a multi-hex lake; the other two lakes have open water.
  for (const [col, row] of [[18, 14], [19, 14], [18, 15]] as const) base[row * cols + col] = 'Land';
  // This coastal hex shares its eastern edge with the continent. Unlike an isolated
  // island hex, its mainland part must stay attached across that shared edge.
  const mainlandAndIslands = 18 * cols + 3;
  base[mainlandAndIslands] = 'Mainland and islands';
  map.islandSpecs = { [mainlandAndIslands]: { large: 0, small: 2 } };
  map.layers.base.data = base;
  map.geoNames = lakes.map(lake => ({ id: lake.id, kind: 'lake', name: lake.name,
    hexes: base.flatMap((value, h) => value === 'Lake'
      && ellipse(h % cols, Math.floor(h / cols), lake.x, lake.y, lake.rx, lake.ry) ? [h] : []) }));
  return [{ name: 'continent-large-lakes', map }];
}
