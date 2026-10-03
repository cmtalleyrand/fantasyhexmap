import test from 'node:test';
import assert from 'node:assert/strict';
import { citySite } from '../src/render/sites.ts';
import { landTest, surfaceMap, surfaceEdges } from '../src/render/coast.ts';
import { hexCenter } from '../shared/hex.ts';
import type { BaseGeo, City } from '../shared/types.ts';

const size = 20;
const S: BaseGeo = 'Sea';
const L: BaseGeo = 'Land';
const I: BaseGeo = 'Isthmus';

test('a port in an isthmus hex stands on the neck, not out in the water of its rim', () => {
  // The isthmus (index 12) joins land to the west and east, with sea north and south.
  const base: BaseGeo[] = [S, S, S, S, S, L, S, S, S, S, S, L, I, L, S, S, S, S, S, S, S, S, S, S, S].map((b, i) => (i === 11 || i === 13 ? L : b));
  const map = surfaceMap(base, 5, 5);
  const onLand = landTest(map, new Map(), new Map(), size);
  const city = { id: 'c', col: 2, row: 2, coastalEdges: [1, 2], onRiver: false } as unknown as City;
  const c = hexCenter(2, 2, size);
  const p = citySite(city, { size, base, cols: 5, onLand });
  assert.ok(onLand(p), 'the city is on land');
  assert.ok(Math.hypot(p.x - c.x, p.y - c.y) < size * 0.5, 'and near the neck');
  void surfaceEdges;
});
