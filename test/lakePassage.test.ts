import assert from 'node:assert/strict';
import test from 'node:test';
import { localLakeShore } from '../src/render/lakePassage.ts';
import { evenOddTest } from '../src/render/coast.ts';
import { pathPolylines } from '../src/render/ice.ts';
import type { PathCmd } from '../src/render/prims.ts';

const original: PathCmd[] = [['M', 0, 0], ['L', 200, 0], ['L', 200, 200], ['L', 0, 200], ['Z']];
const reshaped: PathCmd[] = [['M', 0, 0], ['L', 60, 0], ['L', 80, 45], ['L', 120, 45], ['L', 140, 0], ['L', 200, 0], ['L', 200, 200], ['L', 0, 200], ['Z']];
for (const overlapping of [false, true]) test(`local lake shore preserves water topology with ${overlapping ? 'overlapping edits' : 'one edit'}`, () => {
  const passages = overlapping ? [{ x: 90, y: 30 }, { x: 110, y: 30 }] : [{ x: 100, y: 30 }];
  const rings = pathPolylines(localLakeShore(original, reshaped, passages, 20));
  const water = evenOddTest(rings, 2);
  assert.equal(water({ x: 100, y: 40 }), false, 'the edited headland is land');
  assert.equal(water({ x: 100, y: 60 }), true, 'water beyond the headland remains water');
  for (const p of [{ x: 10, y: 10 }, { x: 190, y: 10 }, { x: 100, y: 190 }]) assert.equal(water(p), true, 'distant lake water is preserved');
  const segments = rings.flatMap(r => r.slice(1).map((p, k) => [r[k]!, p] as const));
  const cross = (a: {x:number;y:number}, b: {x:number;y:number}, c: {x:number;y:number}) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  for (let i=0;i<segments.length;i++) for (let j=i+1;j<segments.length;j++) {
    const [a,b]=segments[i]!,[c,d]=segments[j]!;
    assert.ok(!(cross(a,b,c)*cross(a,b,d)<-1e-8 && cross(c,d,a)*cross(c,d,b)<-1e-8), 'edit boundaries must not cross');
  }
});
