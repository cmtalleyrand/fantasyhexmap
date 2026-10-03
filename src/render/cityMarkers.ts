/**
 * City marker sets.
 *
 * - Symbols: the app's own markers (disc, ringed disc, diamond, crenellated
 *   block), drawn by the renderers from a `city` primitive.
 * - Classic: the atlas convention, a dot for a village, a ringed dot for a
 *   town, a double ring for a city and a star in a ring for a metropolis.
 * - Illustrated: small ink silhouettes, a house, a cluster of houses, a
 *   walled town with towers and a castle, varied a little per city by seed.
 *
 * Classic and illustrated markers are plain paths and circles, so canvas and
 * SVG draw them alike. Each is outlined in the paper colour so it stays
 * legible over relief and realm colour.
 */

import type { Point } from '../../shared/hex.js';
import type { PathCmd, Prim } from './prims.js';
import type { CitySymbol } from './prims.js';

export type CityMarkerSet = 'symbols' | 'classic' | 'illustrated';

export interface MarkerColours {
  ink: string;
  paper: string;
  river: string;
}

/**
 * How a city meets its river, whichever marker set it is drawn in. The marker
 * is not ringed in water: the river keeps its own course and the marker is
 * placed against it, by size.
 *
 * - village, town: on the bank, the marker's rim just over the bank line;
 * - city: on the bank, with the river running under the marker's rim;
 * - metropolis: on the river itself, which runs across the marker and splits it
 *   (`riverThrough`), the one size large enough to straddle the water.
 *
 * Each figure is how far the marker's centre stands from the river's edge, as a
 * fraction of the marker's own footprint (null: on the river's line).
 */
const BANK_STANDOFF: Record<CitySymbol, number | null> = { village: 0.9, town: 0.9, city: 0.6, metropolis: null };

/** The body of each marker as drawn, in marker radii: the sets draw the same size at different scales. */
const FOOTPRINT: Record<CityMarkerSet, Record<CitySymbol, number>> = {
  symbols: { village: 0.58, town: 0.82, city: 1, metropolis: 1 },
  classic: { village: 0.4, town: 0.62, city: 0.8, metropolis: 0.9 },
  illustrated: { village: 0.5, town: 0.6, city: 0.65, metropolis: 0.9 },
};

/** Whether the river runs across a city marker of this size, splitting it. */
export function riverBisects(symbol: CitySymbol): boolean {
  return BANK_STANDOFF[symbol] === null;
}

/** How far a river city's marker stands from its river's centre line, for a river `width` wide; 0 where the river runs across it. */
export function bankOffset(set: CityMarkerSet, symbol: CitySymbol, r: number, width: number): number {
  const standoff = BANK_STANDOFF[symbol];
  return standoff === null ? 0 : width / 2 + r * FOOTPRINT[set][symbol] * standoff;
}

/**
 * The river running across a metropolis: a band of water along `flow` (a unit
 * vector) over the marker, as wide as the river there, with banks. It reaches
 * past the marker on both sides, where it meets the river's own line. Drawn
 * after the marker.
 */
export function riverThrough(
  c: Point,
  r: number,
  flow: Point,
  width: number,
  colours: { river: string; bank?: string; paper: string },
): Prim[] {
  const half = Math.max(width, r * 0.3) / 2;
  const reach = r * 1.4;
  const nx = -flow.y;
  const ny = flow.x;
  const at = (along: number, across: number): Point => ({ x: c.x + flow.x * along + nx * across, y: c.y + flow.y * along + ny * across });
  return [
    { kind: 'polygon', points: [at(-reach, -half), at(reach, -half), at(reach, half), at(-reach, half)], fill: colours.river },
    { kind: 'polyline', points: [at(-reach, -half), at(reach, -half)], stroke: colours.bank ?? colours.paper, strokeWidth: Math.max(0.8, r * 0.08), round: true },
    { kind: 'polyline', points: [at(-reach, half), at(reach, half)], stroke: colours.bank ?? colours.paper, strokeWidth: Math.max(0.8, r * 0.08), round: true },
  ];
}

/** Points of a closed polygon as path commands. */
function poly(points: Array<[number, number]>): PathCmd[] {
  return [...points.map(([x, y], k) => [k === 0 ? 'M' : 'L', x, y] as PathCmd), ['Z']];
}

function star(c: Point, outer: number, inner: number): PathCmd[] {
  const pts: Array<[number, number]> = [];
  for (let k = 0; k < 10; k++) {
    const r = k % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    pts.push([c.x + Math.cos(a) * r, c.y + Math.sin(a) * r]);
  }
  return poly(pts);
}

/** A house: a wall and a pitched roof, standing on `ground`, centred on x. */
function house(x: number, ground: number, w: number, h: number, roof: number): PathCmd[] {
  return poly([
    [x - w / 2, ground],
    [x - w / 2, ground - h],
    [x, ground - h - roof],
    [x + w / 2, ground - h],
    [x + w / 2, ground],
  ]);
}

/** A tower with a crenellated top (`merlons` teeth), standing on `ground`. */
function tower(x: number, ground: number, w: number, h: number, merlons = 2): PathCmd[] {
  const top = ground - h;
  const tooth = h * 0.16;
  const pts: Array<[number, number]> = [[x - w / 2, ground], [x - w / 2, top - tooth]];
  const step = w / (merlons * 2 - 1);
  for (let k = 0; k < merlons * 2 - 1; k++) {
    const x0 = x - w / 2 + k * step;
    const up = k % 2 === 0;
    pts.push([x0, up ? top - tooth : top], [x0 + step, up ? top - tooth : top]);
  }
  pts.push([x + w / 2, top - tooth], [x + w / 2, ground]);
  return poly(pts);
}

/** A tower with a conical roof. */
function spire(x: number, ground: number, w: number, h: number, roof: number): PathCmd[] {
  return poly([
    [x - w / 2, ground],
    [x - w / 2, ground - h],
    [x, ground - h - roof],
    [x + w / 2, ground - h],
    [x + w / 2, ground],
  ]);
}

/**
 * The marker for one city, in the classic or illustrated set, centred on `c`
 * with radius `r` (the same footprint the symbols set uses).
 */
export function cityMarker(
  set: Exclude<CityMarkerSet, 'symbols'>,
  symbol: CitySymbol,
  c: Point,
  r: number,
  colours: MarkerColours,
  rand: (k: number) => number,
): Prim[] {
  const { ink, paper } = colours;
  const edge = Math.max(0.8, r * 0.16);
  if (set === 'classic') {
    switch (symbol) {
      case 'village':
        return [{ kind: 'circle', c, r: r * 0.4, fill: ink, stroke: paper, strokeWidth: edge }];
      case 'town':
        return [
          { kind: 'circle', c, r: r * 0.62, fill: paper, stroke: ink, strokeWidth: edge },
          { kind: 'circle', c, r: r * 0.28, fill: ink },
        ];
      case 'city':
        return [
          { kind: 'circle', c, r: r * 0.8, fill: paper, stroke: ink, strokeWidth: edge },
          { kind: 'circle', c, r: r * 0.52, stroke: ink, strokeWidth: edge * 0.8 },
          { kind: 'circle', c, r: r * 0.26, fill: ink },
        ];
      default:
        return [
          { kind: 'circle', c, r: r * 0.9, fill: paper, stroke: ink, strokeWidth: edge },
          { kind: 'path', d: star(c, r * 0.68, r * 0.28), fill: ink },
        ];
    }
  }
  // Illustrated: silhouettes standing on a ground line a little below the site.
  const ground = c.y + r * 0.45;
  const v = (k: number) => 0.85 + rand(k) * 0.3;
  let shapes: PathCmd[];
  switch (symbol) {
    case 'village':
      shapes = house(c.x, ground, r * 0.7, r * 0.45 * v(1), r * 0.4);
      break;
    case 'town':
      shapes = [
        ...house(c.x - r * 0.5, ground, r * 0.55, r * 0.42 * v(1), r * 0.32),
        ...spire(c.x, ground, r * 0.36, r * 0.8 * v(2), r * 0.45),
        ...house(c.x + r * 0.5, ground, r * 0.6, r * 0.5 * v(3), r * 0.34),
      ];
      break;
    case 'city':
      shapes = [
        // A wall between two towers, with roofs showing over it.
        ...house(c.x - r * 0.25, ground - r * 0.4, r * 0.4, r * 0.3 * v(1), r * 0.3),
        ...spire(c.x + r * 0.2, ground - r * 0.4, r * 0.3, r * 0.5 * v(2), r * 0.4),
        ...tower(c.x, ground, r * 1.4, r * 0.5, 4),
        ...tower(c.x - r * 0.75, ground, r * 0.36, r * 0.85, 2),
        ...tower(c.x + r * 0.75, ground, r * 0.36, r * 0.85, 2),
      ];
      break;
    default:
      shapes = [
        // A keep between two spired towers, on a curtain wall, with a flag.
        ...tower(c.x, ground, r * 1.7, r * 0.45, 5),
        ...tower(c.x, ground - r * 0.4, r * 0.62, r * 0.95, 3),
        ...spire(c.x - r * 0.68, ground - r * 0.2, r * 0.34, r * 0.7, r * 0.42),
        ...spire(c.x + r * 0.68, ground - r * 0.2, r * 0.34, r * 0.7, r * 0.42),
        ...poly([
          [c.x - r * 0.03, ground - r * 1.55],
          [c.x - r * 0.03, ground - r * 1.95],
          [c.x + r * 0.3, ground - r * 1.85],
          [c.x + r * 0.03, ground - r * 1.76],
          [c.x + r * 0.03, ground - r * 1.55],
        ]),
      ];
  }
  return [
    // The paper outline first, under the ink, so neighbouring shapes read as one.
    { kind: 'path', d: shapes, stroke: paper, strokeWidth: edge * 2.2, round: true },
    { kind: 'path', d: shapes, fill: ink },
  ];
}

/** Height of a capital's crown, and the gap left under it (radius multiples). */
const CROWN_HEIGHT = 0.6;
const CROWN_GAP = 0.12;

/** How far a marker reaches above and below its site, for label clearance (radius multiples). */
export function markerExtent(
  set: CityMarkerSet,
  symbol: CitySymbol,
  capital = false,
): { up: number; down: number; half: number } {
  const extent = ((): { up: number; down: number; half: number } => {
    if (set !== 'illustrated') return { up: 1, down: 1, half: 1 };
    switch (symbol) {
      case 'village':
        return { up: 0.6, down: 0.5, half: 0.45 };
      case 'town':
        return { up: 0.85, down: 0.5, half: 0.85 };
      case 'city':
        return { up: 0.9, down: 0.5, half: 1 };
      default:
        return { up: 1.55, down: 0.5, half: 0.95 };
    }
  })();
  if (!capital) return extent;
  return { ...extent, up: extent.up + CROWN_GAP + CROWN_HEIGHT, half: Math.max(extent.half, 0.55) };
}

/**
 * The crown that marks a capital, standing just above its marker. Plain paths,
 * outlined in the paper colour like the markers, so every marker set and both
 * renderers draw it alike.
 */
export function capitalCrown(
  set: CityMarkerSet,
  symbol: CitySymbol,
  c: Point,
  r: number,
  colours: Pick<MarkerColours, 'ink' | 'paper'>,
): Prim[] {
  const base = c.y - (markerExtent(set, symbol).up + CROWN_GAP) * r;
  const w = r * 1.1;
  const h = r * CROWN_HEIGHT;
  const crown = poly([
    [c.x - w / 2, base],
    [c.x - w / 2, base - h * 0.8],
    [c.x - w / 4, base - h * 0.45],
    [c.x, base - h],
    [c.x + w / 4, base - h * 0.45],
    [c.x + w / 2, base - h * 0.8],
    [c.x + w / 2, base],
  ]);
  const edge = Math.max(0.8, r * 0.16);
  return [
    { kind: 'path', d: crown, stroke: colours.paper, strokeWidth: edge * 2, round: true },
    { kind: 'path', d: crown, fill: colours.ink },
  ];
}
