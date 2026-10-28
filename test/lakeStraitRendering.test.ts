import assert from 'node:assert/strict';
import test from 'node:test';
import { LAND_SHARE_TOLERANCE } from '../shared/surfaceArea.ts';
import { lakeStraitFixture, LAKE_STRAIT_CASES, FAST_LAKE_STRAIT_CASES } from './fixtures/lakeStrait.ts';
import { assertLakeStraitCase, centre, cols, connected, render, size, style, throat } from './helpers/lakeStrait.ts';
import { buildScene, defaultVisibility, landTestOf } from '../src/render/scene.ts';
import { lakeStraitFrame } from '../src/render/footprint.ts';
import { evenOddTest } from '../src/render/coast.ts';
import { hexCenter, hexCorners } from '../shared/hex.ts';
import type { ChannelWidth, Irregularity, MapState } from '../shared/types.ts';

/** A lake between a northern shore and a southwestern peninsula, as reported. */
function fixture(width: ChannelWidth = 'Normal', side?: number, land?: number, irregular: Irregularity = 'Ragged'): MapState {
  return lakeStraitFixture({ width, side, land, irregular });
}
test('narrow lake straits retain a continuous water route after roughening and coastline ink', () => {
  for (const irregular of ['Smooth', 'Ragged', 'Fractured'] as const) for (const width of ['Very narrow', 'Narrow'] as const) {
    const draw = render(fixture(width, undefined, undefined, irregular));
    assert.ok(connected(draw), `${irregular}, ${width}: lake passage pinched shut`);
  }
});
test('lake strait widths alter the rendered constriction', () => {
  const narrow = render(fixture('Narrow')), normal = render(fixture('Normal'));
  assert.ok(throat(normal).distance > throat(narrow).distance + size * 0.1);
  for (const [draw, fraction] of [[narrow, 0.15], [normal, 0.3]] as const) {
    const actual = throat(draw).distance, expected = fraction * Math.sqrt(3) * size;
    assert.ok(Math.abs(actual - expected) < size * 0.04, `painted shore width ${actual} must match requested ${expected}`);
  }
});
test('west and east lake junction selections move the rendered passage', () => {
  const west = render(fixture('Normal', 3)), east = render(fixture('Normal', 0));
  assert.notDeepEqual(west.rings, east.rings, 'junction setting must affect final lake shore');
  const c = hexCenter(3, 3, size);
  const westThroat = throat(west), eastThroat = throat(east);
  assert.ok(westThroat.x < c.x - size * 0.4, 'western selection puts the constriction west of centre');
  assert.ok(eastThroat.x > c.x + size * 0.4, 'eastern selection puts the constriction east of centre');
  assert.ok(eastThroat.x - westThroat.x > size * 0.8, 'the constriction follows the selected side');
  // The banks are non-opposite: compare the route's position, not vertical
  // mouth widths (which also depend on the channel's angle).
  assert.ok(west.water(westThroat), 'western junction lies in water');
  assert.ok(east.water(eastThroat), 'eastern junction lies in water');
  assert.equal(landTestOf(west.scene)?.({ x: c.x, y: c.y - size * 0.75 }), true, 'expanded lake bank is available for land placement');
  assert.equal(landTestOf(east.scene)?.(eastThroat), false, 'moved channel is water for placement too');
  assert.ok(connected(west)); assert.ok(connected(east));
});
test('lake straits report land shares without sacrificing their headland shape to high targets', () => {
  const low = render(fixture('Narrow', undefined, 30));
  const middle = render(fixture('Narrow', undefined, 50));
  assert.ok(Math.abs(low.share() - 0.3) < 0.01, `30% request rendered ${low.share()}`);
  assert.ok(Math.abs(middle.share() - 0.5) < 0.01, `50% request rendered ${middle.share()}`);
  const natural = render(fixture('Narrow'));
  const eighty = render(fixture('Narrow', undefined, 80));
  assert.deepEqual(eighty.rings, natural.rings, '80% must not flatten the headlands to force a land-area target');
  const note = eighty.scene.compromises?.find(c => c.hexes.includes(centre));
  assert.ok(note, 'the ignored high target must be reported');
  assert.ok(Math.abs(Number(note.what.match(/^(\d+)%/)?.[1]) / 100 - eighty.share()) < 0.01);
});

test('natural lake straits are short gaps between tips, opening rapidly on both sides', () => {
  const c = hexCenter(3, 3, size), corners = hexCorners(3, 3, size);
  for (const irregular of ['Smooth', 'Ragged', 'Fractured'] as const) {
    const draw = render(fixture('Narrow', undefined, undefined, irregular));
    const frame = lakeStraitFrame(corners, c, [2, 4, 5], .15 * Math.sqrt(3) * size)!;
    const normal = frame.normal, tangent = { x: normal.y, y: -normal.x };
    const gap = (u: number) => {
      const at = (v: number) => ({ x: frame.centre.x + tangent.x * u + normal.x * v,
        y: frame.centre.y + tangent.y * u + normal.y * v });
      assert.ok(draw.water(at(0)), 'the short throat must connect to both wider water bodies');
      let width = 0;
      for (const side of [-1, 1]) for (let v = .1; v < size * 1.5; v += .1) {
        if (!draw.water(at(v * side))) break;
        width += .1;
      }
      return width;
    };
    const neck = gap(0);
    for (const side of [-1, 1]) assert.ok(gap(side * size * .4) > neck + size * .25,
      `${irregular}: banks must recede within 0.4 radii of the tips, not form a long canal`);
  }
});
test('strait irregularity adds visible flank detail with the surrounding lake held smooth', () => {
  const draw = (irregular: Irregularity) => {
    const map = fixture('Narrow', undefined, undefined, irregular);
    map.defaultLakeIrregularity = 'Smooth';
    return render(map);
  };
  const smooth = draw('Smooth'), corners = hexCorners(3, 3, size);
  const inHex = evenOddTest([corners], size / 8);
  const smoothSegments = smooth.rings.flatMap(r => r.slice(1).map((b, k) => [r[k]!, b] as const));
  for (const [irregular, minimum] of [['Wavy', .008], ['Ragged', .018], ['Fractured', .025]] as const) {
    const rough = draw(irregular);
    const points = rough.rings.flat().filter(inHex);
    let total = 0;
    for (const p of points) {
      let nearest = Infinity;
      for (const [a, b] of smoothSegments) {
        const dx = b.x-a.x, dy = b.y-a.y;
        const t = Math.max(0, Math.min(1, ((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy || 1)));
        nearest = Math.min(nearest, Math.hypot(p.x-a.x-dx*t, p.y-a.y-dy*t));
      }
      total += nearest;
    }
    const displacement = total / points.length;
    assert.ok(displacement > size * minimum,
      `${irregular} flank detail was smoothed away: mean displacement ${displacement}`);
    assert.ok(connected(rough), 'shore detail must leave the short water passage open');
    assert.ok(Math.abs(throat(rough).distance - .15 * Math.sqrt(3) * size) < size * .04);
  }
});

test('lake shores adjoining a strait retain their own land-share controls', () => {
  const map = fixture();
  map.hexShapes!['25'] = { type: 'Lake', land: 30 };
  const draw = render(map);
  assert.ok(Math.abs(draw.share(25) - 0.3) <= LAND_SHARE_TOLERANCE, `adjoining lake land share: ${draw.share(25)}`);
});

test('a separate lake keeps its existing outline when another lake contains a strait', () => {
  const map = fixture();
  map.layers.base.data![0] = 'Lake';
  const before = render(map).rings[0];
  map.layers.base.data![centre] = 'Lake';
  const after = render(map).rings[0];
  assert.deepEqual(before, after);
});
test('editing a lake junction and undoing it restores the cached rendered shore', () => {
  const map = fixture('Normal', 3);
  const west = render(map).rings;
  map.hexShapes![centre]!.straitJunctionSide = 0;
  const east = render(map).rings;
  assert.notDeepEqual(west, east);
  map.hexShapes![centre]!.straitJunctionSide = 3;
  assert.deepEqual(render(map).rings, west);
  const uncached = buildScene(map, { size, visible: defaultVisibility(), labels: false, style, cache: 'off' });
  assert.deepEqual(uncached.prims, render(map).scene.prims);
});

test('a lake passage reaching the map edge closes its water clip along the page', () => {
  const map = fixture('Narrow');
  for (let x = 0; x < 3; x++) map.layers.base.data![3 * cols + x] = 'Lake';
  const draw = render(map);
  assert.ok(connected(draw));
  assert.equal(draw.water(hexCenter(0, 3, size)), true);
  assert.equal(draw.water(hexCenter(0, 0, size)), false);
  assert.equal(draw.water(hexCenter(6, 6, size)), false);
});

for (const [index, example] of LAKE_STRAIT_CASES.entries()) {
  // The other cases run in the slow tier (test/slow/lakeStraitCases.test.ts).
  if (!FAST_LAKE_STRAIT_CASES.has(index)) continue;
  test(`representative lake strait ${index + 1}: ${example.width}, side=${example.side ?? 'middle'}, land=${example.land ?? 'natural'}, ${example.irregular}`, () => {
    assertLakeStraitCase(example);
  });
}

test('editing a passage preserves the distant shore of the same lake', () => {
  const narrow = render(fixture('Narrow')), normal = render(fixture('Normal'));
  const c = hexCenter(3, 3, size);
  const distanceTo = (p: {x:number;y:number}, rings: typeof normal.rings) => {
    let best = Infinity;
    for (const ring of rings) for (let k = 1; k < ring.length; k++) {
      const a = ring[k-1]!, b = ring[k]!, dx = b.x-a.x, dy = b.y-a.y;
      const t = Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));
      best = Math.min(best,Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy));
    }
    return best;
  };
  let checked = 0;
  for (const p of narrow.rings.flat()) if (Math.hypot(p.x-c.x,p.y-c.y) > size*2.6) {
    assert.ok(distanceTo(p,normal.rings) < size*0.006, 'changing width must not redraw the distant lake shore');
    checked++;
  }
  assert.ok(checked > 20);
});
