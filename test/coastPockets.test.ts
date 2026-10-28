import assert from 'node:assert/strict';
import test from 'node:test';
import { chainEdges, coastEdges, surfaceMap } from '../src/render/coast.ts';
import { polyArea, shapeCoast } from '../src/render/footprint.ts';
import { pathPolylines } from '../src/render/ice.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';
import { hexCenter, hexCorners, neighbourOf, inBounds, type Point } from '../shared/hex.ts';
import { createMapState } from './seededMap.ts';
import type { BaseGeo, Irregularity } from '../shared/types.ts';
import { scenePaths } from './helpers/scene.ts';

const W = 9, H = 8, size = 30, hexArea = 1.5 * Math.sqrt(3) * size * size;
const id = (c: number, r: number) => r * W + c;
const style = resolveStyle({ preset: 'parchment', overrides: { water: 'flat', grain: false, grid: 'none', land: 'uniform' } });

/** Land rows above and below a two-row channel, narrowed by a strait hex in each row. */
function stackedStrait(): BaseGeo[] {
  const base: BaseGeo[] = Array(W * H).fill('Land');
  for (let c = 0; c < W; c++) { base[id(c, 3)] = 'Sea'; base[id(c, 4)] = 'Sea'; }
  for (let i = 0; i < W * H; i++) {
    if (base[i] !== 'Land') continue;
    const touchesSea = [0, 1, 2, 3, 4, 5].some(e => {
      const n = neighbourOf(i % W, Math.floor(i / W), e);
      return inBounds(W, H, n.col, n.row) && base[id(n.col, n.row)] === 'Sea';
    });
    if (touchesSea) base[i] = 'Land';
  }
  base[id(4, 3)] = 'Strait';
  base[id(4, 4)] = 'Strait';
  return base;
}

/** The closed coastline rings of a rendered map with their signed areas, in hexes (negative: water enclosed by land). */
function coastRings(base: BaseGeo[], irregularity: Irregularity, shapes: Record<string, object> = {}): number[] {
  const map = createMapState('Coast pockets', W, H);
  map.id = 'coast-pockets';
  map.layers.base.data = base;
  map.defaultIrregularity = irregularity;
  map.hexShapes = shapes as typeof map.hexShapes;
  const scene = buildScene(map, { size, visible: defaultVisibility(), labels: false, style });
  const rings = scenePaths(scene.prims)
    .filter(p => p.stroke === style.palette.coast)
    .flatMap(p => pathPolylines(p.d, 8));
  return rings.filter(r => r.length > 2 && Math.hypot(r[0]!.x - r.at(-1)!.x, r[0]!.y - r.at(-1)!.y) < 1e-6)
    .map(r => r.reduce((sum, p, k) => { const q = r[(k + 1) % r.length]!; return sum + p.x * q.y - q.x * p.y; }, 0) / 2 / hexArea);
}

test('a strait between reshaped coasts leaves no small enclosed lakes in its banks', () => {
  for (const irregularity of ['Smooth', 'Wavy', 'Ragged'] as Irregularity[]) {
    for (const shapes of [{}, { [id(4, 3)]: { type: 'Strait', land: 45 }, [id(4, 4)]: { type: 'Strait', land: 45 } }]) {
      const pockets = coastRings(stackedStrait(), irregularity, shapes).filter(a => a < 0 && a > -0.5);
      assert.deepEqual(pockets, [], `${irregularity}: water pockets of ${pockets.map(a => a.toFixed(3)).join(', ')} hexes`);
    }
  }
});

test('a strait with land on one side only draws one bank along its passage, not prongs round a slot', () => {
  const base = stackedStrait();
  const shaped = shapeCoast(coastEdges(base, W, H, size), surfaceMap(base, W, H), size,
    new Map([[id(4, 3), { share: 0.3, kind: 'channel' as const, width: 0.3 * Math.sqrt(3) * size }]]))!;
  const land = shaped.land.get(id(4, 3))!;
  // Prongs leave water enclosed on three sides inside the bank: the land's hull is much larger than the land.
  const hull = (points: Point[]) => {
    const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const half = (pts: Point[]) => pts.reduce<Point[]>((out, p) => {
      while (out.length > 1 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 0) out.pop();
      out.push(p);
      return out;
    }, []);
    return [...half(sorted).slice(0, -1), ...half(sorted.reverse()).slice(0, -1)];
  };
  const area = land.reduce((sum, p) => sum + polyArea(p), 0);
  assert.ok(area > 0);
  assert.ok(polyArea(hull(land.flat())) < area * 1.2, 'the bank is one solid shore');
  // And the passage stays open across the hex: its water touches both of the strait's side edges.
  const chains = chainEdges(shaped.edges);
  assert.ok(chains.every(chain => chain.edges.some(edge => edge.hex !== id(4, 3))), 'every shore is joined to a mainland');
});

test('a mainland hex is cut back from its sea into a tapered shore, not laid as bands along its land edges', () => {
  // A mainland hex against two adjoining land edges: bands along both made a thin chevron mirrored about their corner.
  const base: BaseGeo[] = Array(W * H).fill('Sea');
  const m = id(4, 4);
  base[m] = 'Mainland and islands';
  const dry = [1, 2];
  for (const e of dry) {
    const n = neighbourOf(4, 4, e);
    base[id(n.col, n.row)] = 'Land';
  }
  const surface = surfaceMap(base, W, H);
  assert.ok(surface.split.has(m));
  const shaped = shapeCoast(coastEdges(base, W, H, size), surface, size, new Map([[m, { share: 0.3, kind: 'inset' as const }]]))!;
  const land = shaped.land.get(m)!;
  const area = land.reduce((sum, p) => sum + polyArea(p), 0) / hexArea;
  assert.ok(Math.abs(area - 0.3) < 0.01, `drew ${area}`);
  const corners = hexCorners(4, 4, size), shared = corners[2]!;
  // How far along each land edge, from the corner they share, the land reaches.
  for (const e of dry) {
    const far = e === 1 ? corners[1]! : corners[3]!;
    const length = Math.hypot(far.x - shared.x, far.y - shared.y);
    const reach = Math.max(...land.flat().map(p => {
      const t = ((p.x - shared.x) * (far.x - shared.x) + (p.y - shared.y) * (far.y - shared.y)) / length;
      const off = Math.abs((p.x - shared.x) * (far.y - shared.y) - (p.y - shared.y) * (far.x - shared.x)) / length;
      return off < 1e-6 ? t : 0;
    }));
    assert.ok(reach < length * 0.9, `edge ${e}: land runs ${(reach / length * 100).toFixed(0)}% of the way along it`);
  }
});

test('islands off a smoothed mainland keep their share, kept clear of the coast as drawn', () => {
  // Islands were kept clear of the mainland's reshaped polygon, which the smoothed coast's
  // fitting enlarges well past the drawn shore, and were crowded down to specks.
  const base: BaseGeo[] = Array(W * H).fill('Sea');
  for (let r = 0; r < H; r++) for (let c = 0; c < 3; c++) base[id(c, r)] = c === 2 ? 'Land' : 'Land';
  const m = id(3, 3);
  base[m] = 'Mainland and islands';
  const map = createMapState('Mainland islands', W, H);
  map.id = 'mainland-islands';
  map.layers.base.data = base;
  map.defaultIrregularity = 'Wavy';
  map.islandSpecs = { [m]: { large: 0, small: 2 } };
  const smoothStyle = resolveStyle({ preset: 'parchment', overrides: { coast: 'smooth' } });
  const scene = buildScene(map, { size, visible: defaultVisibility(), labels: false, style: smoothStyle });
  const paths = scenePaths(scene.prims)
    .filter(p => p.stroke === smoothStyle.palette.coast)
    .flatMap(p => pathPolylines(p.d, 12));
  // The islands: the small closed outlines in the hex.
  const centre = hexCenter(3, 3, size);
  const areaOf = (r: Point[]) => Math.abs(r.reduce((s, p, k) => { const q = r[(k + 1) % r.length]!; return s + p.x * q.y - q.x * p.y; }, 0)) / 2 / hexArea;
  const isles = paths.filter(r => {
    const c = r.reduce((sum, p) => ({ x: sum.x + p.x / r.length, y: sum.y + p.y / r.length }), { x: 0, y: 0 });
    return areaOf(r) < 0.3 && Math.hypot(c.x - centre.x, c.y - centre.y) < size;
  });
  assert.equal(isles.length, 2, 'both islands are drawn');
  const shown = isles.reduce((sum, r) => sum + areaOf(r), 0);
  assert.ok(shown > 0.1 * 0.6, `two small islands drawn at ${(shown * 100).toFixed(1)}% of the hex for a 10% share`);
});
