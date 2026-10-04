import assert from 'node:assert/strict';
import test from 'node:test';
import { hexCenter } from '../shared/hex.ts';
import { createMapState } from '../shared/layers.ts';
import type { BaseGeo, MapState } from '../shared/types.ts';
import { drawnLand, evenOddTest, type CoastGeometry } from '../src/render/coast.ts';
import { pathPolylines } from '../src/render/ice.ts';
import type { PathCmd } from '../src/render/prims.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';
import { keepToLand, reliefSymbols, standsOnLand } from '../src/render/symbols.ts';

/** A coast made of the given open chains (each a list of points, land on the right of travel). */
function openCoast(...lines: Array<Array<[number, number]>>): CoastGeometry {
  return {
    chains: lines.map(() => ({ closed: false })),
    paths: lines.map((line) => line.map(([x, y], k) => [k === 0 ? 'M' : 'L', x, y] as PathCmd)),
  } as unknown as CoastGeometry;
}

const landOf = (geometry: CoastGeometry) => evenOddTest(pathPolylines(drawnLand(geometry, 100, 100, 10)), 5);

test('two bays from one edge: each coast is joined to the next along the page, not to itself', () => {
  // Land everywhere but two bays cut down from the top edge.
  const land = landOf(openCoast(
    [[20, 0], [20, 30], [30, 30], [30, 0]],
    [[60, 0], [60, 30], [70, 30], [70, 0]],
  ));
  assert.ok(land({ x: 45, y: 50 }), 'the land between and below the bays');
  assert.ok(land({ x: 90, y: 90 }), 'the far corner');
  assert.ok(!land({ x: 25, y: 10 }), 'the first bay');
  assert.ok(!land({ x: 65, y: 10 }), 'the second bay');
});

test('a coast closed round the top-left corner of the page does not cross itself', () => {
  // Land along the top: the coast runs from the right edge to the left edge.
  const land = landOf(openCoast([[100, 40], [50, 45], [0, 40]]));
  assert.ok(land({ x: 50, y: 10 }));
  assert.ok(land({ x: 5, y: 5 }));
  assert.ok(land({ x: 95, y: 5 }));
  assert.ok(!land({ x: 50, y: 80 }));
});

test('a coast cut into pieces inside the map is joined piece to piece', () => {
  const land = landOf(openCoast([[100, 40], [50, 45]], [[50, 45], [0, 40]]));
  assert.ok(land({ x: 50, y: 10 }));
  assert.ok(land({ x: 10, y: 5 }));
  assert.ok(!land({ x: 50, y: 80 }));
  assert.ok(!land({ x: 90, y: 90 }));
});

test('a set of symbols is shrunk and moved onto the land, never left over water', () => {
  const size = 40;
  const centre = { x: 100, y: 100 };
  // Only a small disc to the upper left of the hex's middle is land.
  const onLand = (p: { x: number; y: number }) => Math.hypot(p.x - 88, p.y - 85) < 18;
  const inHex = (p: { x: number; y: number }) => Math.hypot(p.x - centre.x, p.y - centre.y) < size * 0.85;
  const draw = (at: { x: number; y: number }, s: number) => reliefSymbols(at, s, 'Mountains', () => 0.5, { ground: '#d8c8a0', ink: '#333333' });
  assert.ok(!draw(centre, size).every((p) => standsOnLand(p, onLand)), 'as laid out, the peaks are partly over water');
  const fitted = keepToLand(draw, centre, size, onLand, inHex);
  assert.ok(fitted.scale < 1, 'they are drawn smaller');
  for (const p of fitted.placed) assert.ok(standsOnLand(p, onLand), 'every symbol kept is on land');
  assert.equal(fitted.placed.length + fitted.dropped, fitted.wanted);
  // With no land at all, nothing is drawn, and that is reported as dropped.
  const none = keepToLand(draw, centre, size, () => false, inHex);
  assert.equal(none.placed.length, 0);
  assert.equal(none.dropped, none.wanted);
});

function coastWithMountains(share: number): MapState {
  const map = createMapState('Peaks', 5, 4);
  map.id = 'peaks'; // the coast's roughening is seeded by the map
  const L: BaseGeo = 'Land', C: BaseGeo = 'Coastal Land', S: BaseGeo = 'Sea';
  map.layers.base.data = [L, L, L, L, L, C, C, C, C, C, S, S, C, S, S, S, S, S, S, S];
  map.hexShapes = { '12': { type: 'Coastal Land', land: share } };
  map.layers.elevation.data = map.layers.base.data.map((b, i) => (b === S ? null : i === 12 ? 'Mountains' : 'Hills'));
  return map;
}

test('a coast hex with a small land share draws its peaks smaller and says so', () => {
  const visible = defaultVisibility();
  visible.elevation = true;
  const style = resolveStyle({ preset: 'parchment' });
  const small = buildScene(coastWithMountains(20), { size: 40, visible, labels: false, style });
  const here = (small.compromises ?? []).filter((c) => c.hex === 12);
  assert.equal(here.length, 1, 'the hex is reported');
  // Smaller, or (where even the smallest size will not take them all) some of them left out.
  assert.match(here[0]!.what, /^(Mountains symbols drawn at \d+% size|\d of \d mountains symbols left out, the rest drawn at \d+% size)$/);
  assert.match(here[0]!.why, /never drawn over water/);
  // Whole land hexes away from the coast are drawn as laid out, and not reported.
  const centre = hexCenter(2, 0, 40);
  assert.ok(!(small.compromises ?? []).some((c) => c.hex === 2), `hex at ${centre.x},${centre.y} is whole land`);
});
