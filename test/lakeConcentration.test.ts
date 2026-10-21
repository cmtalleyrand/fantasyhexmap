import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from './seededMap.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import { NEW_USER_STYLE_CHOICE, resolveStyle } from '../src/render/styles.ts';
import { hexCorners } from '../shared/hex.ts';
import { areaCoverage, polyArea } from '../src/render/footprint.ts';
import { pathPolylines } from '../src/render/ice.ts';
import type { Prim } from '../src/render/prims.ts';
import type { BaseGeo } from '../shared/types.ts';

const style = resolveStyle(NEW_USER_STYLE_CHOICE), size = 30;
const corners = hexCorners(2, 2, size), full = polyArea(corners);
function measure(share: number, side: number, strength: number) {
  const map = createMapState('Lake concentration defaults', 5, 5);
  map.id = 'lake-concentration-evidence';
  map.layers.base.data = Array<BaseGeo>(25).fill('Land'); map.layers.base.data[12] = 'Lake';
  map.hexShapes = { '12': { type: 'Lake', land: share * 100, concentrationSide: side, concentration: strength } };
  const scene = buildScene(map, { size, style, visible: defaultVisibility(), labels: false, cache: 'off' });
  const fills: Extract<Prim, { kind: 'path' }>[] = [], strokes: typeof fills = [];
  const gather = (ps: Prim[]) => { for (const p of ps) {
    if (p.kind === 'group') gather(p.prims);
    else if (p.kind === 'path') {
      if (p.fill === style.palette.lake) fills.push(p);
      if (p.stroke === style.palette.coast) strokes.push(p);
    }
  } };
  gather(scene.prims);
  const lake = fills.flatMap(p => p.d), shore = strokes.flatMap(p => p.d);
  assert.deepEqual(lake, shore, 'the lake fill uses the same geometry as its shoreline');
  const frame = [{ x: -30, y: -30 }, { x: 350, y: -30 }, { x: 350, y: 350 }, { x: -30, y: 350 }];
  const coverage = areaCoverage([frame, ...pathPolylines(lake, 12)], { evenOdd: true,
    stroke: { rings: pathPolylines(shore, 12), reach: Math.max(...strokes.map(p => p.strokeWidth ?? 0)) / 2 } });
  return { land: coverage(corners, 256) / full,
    east: coverage([corners[5]!, corners[0]!, corners[1]!, corners[2]!], 256) / full };
}

test('default Ragged lake keeps its land target under strong concentration in all six directions', () => {
  for (let side = 0; side < 6; side++) {
    const result = measure(0.8, side, 100);
    assert.ok(Math.abs(result.land - 0.8) < 0.01, `side ${side}: ${result.land}`);
  }
});

test('default lake concentration redistributes land towards either side and ignores side at zero strength', () => {
  for (const share of [0.2, 0.4, 0.8]) {
    const zero = measure(share, 0, 0);
    assert.equal(measure(share, 3, 0).east, zero.east);
    for (const strength of [50, 100]) {
      assert.ok(measure(share, 0, strength).east > zero.east + 0.005, `${share}, ${strength}: east`);
      assert.ok(measure(share, 3, strength).east < zero.east - 0.005, `${share}, ${strength}: west`);
    }
  }
});
