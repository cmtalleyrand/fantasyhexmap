import assert from 'node:assert/strict';
import test from 'node:test';
import { realmBoundary } from '../src/render/realmBoundary.ts';
import { coastKey, evenOddTest, raggedEdge } from '../src/render/coast.ts';
import { pathPolylines } from '../src/render/ice.ts';
import { hexCenter, hexEdgePoints, neighbourOf } from '../shared/hex.ts';

const size = 40, cols = 5;
const straight = (_hex: number, _edge: number, a: {x:number;y:number}, b: {x:number;y:number}) => [a,b];

test('region outline cancels interior cell edges and retains unowned holes', () => {
  const selected = Array.from({length:25},(_,i)=>i).filter(i=>i!==12);
  const path=realmBoundary(selected,cols,size,straight);
  assert.equal(path.filter(c=>c[0]==='M').length,2);
  assert.equal(path.filter(c=>c[0]==='Z').length,2);
  const inside=evenOddTest(pathPolylines(path),size/8);
  assert.equal(inside(hexCenter(2,2,size)),false);
  assert.equal(inside(hexCenter(1,2,size)),true);
});

test('two ragged realm regions meet exactly on the ink path without growth or a gap', () => {
  const first=12,n=neighbourOf(2,2,0),second=n.row*cols+n.col;
  const [a,b]=hexEdgePoints(2,2,0,size),keys=new Set([coastKey(a),coastKey(b)]);
  const shape=(_i:number,_e:number,p:typeof a,q:typeof a)=>keys.has(coastKey(p))&&keys.has(coastKey(q))?[p,...raggedEdge(p,q,'wild','realm-test',size)]:[p,q];
  const one=evenOddTest(pathPolylines(realmBoundary([first],cols,size,shape)),size/8);
  const two=evenOddTest(pathPolylines(realmBoundary([second],cols,size,shape)),size/8);
  const line=shape(first,0,a,b);
  for(let j=1;j<line.length;j++){
    const p=line[j-1]!,q=line[j]!,dx=q.x-p.x,dy=q.y-p.y,len=Math.hypot(dx,dy);
    for(const t of [.3,.5,.7])for(const delta of [.15,.4]){
      const right={x:p.x+dx*t-dy/len*delta,y:p.y+dy*t+dx/len*delta};
      const left={x:p.x+dx*t+dy/len*delta,y:p.y+dy*t-dx/len*delta};
      assert.equal(one(right),true);assert.equal(two(right),false);
      assert.equal(one(left),false);assert.equal(two(left),true);
    }
  }
});

test('a frontier ending on the coast keeps its wander when the coast moves slightly', () => {
  const [a, b] = hexEdgePoints(4, 3, 1, 26);
  const anchored = { x: b.x + 0.37, y: b.y - 0.21 }, moved = { x: anchored.x + 0.004, y: anchored.y - 0.003 };
  for (const level of ['wobbly', 'ragged', 'wild'] as const) {
    const before = raggedEdge(a, anchored, level, 'seed', 26, [a, b]);
    const after = raggedEdge(a, moved, level, 'seed', 26, [a, b]);
    assert.equal(before.length, after.length);
    const shift = Math.max(...before.map((p, k) => Math.hypot(p.x - after[k]!.x, p.y - after[k]!.y)));
    assert.ok(shift < 0.01, `${level}: wander moved ${shift}`);
    // Walked the other way, the same line.
    const back = raggedEdge(anchored, a, level, 'seed', 26, [b, a]);
    assert.deepEqual([a, ...before.slice(0, -1)].reverse().map(p => [p.x, p.y].map(v => Math.round(v * 1e6))),
      back.map(p => [p.x, p.y].map(v => Math.round(v * 1e6))));
  }
  // Without moved ends the corners are the ends, as before.
  assert.deepEqual(raggedEdge(a, b, 'ragged', 'seed', 26), raggedEdge(a, b, 'ragged', 'seed', 26, [a, b]));
});


test('a thin coastal strip of a mainland-with-islands hex is drawn as the realm it lies along', async () => {
  const { buildStaticScene } = await import('../src/render/scene.ts');
  const { fixture, options } = await import('../scripts/render-profile-input.ts');
  const opts = options(), scene = buildStaticScene(fixture('populated'), opts);
  const vertices: Array<[number, number]> = [];
  const walk = (prims: typeof scene.prims): void => prims.forEach(p => p.kind === 'group' ? walk(p.prims)
    : p.kind === 'path' && p.stroke === opts.style!.palette.frontier ? p.d.forEach(c => { if (c.length === 3) vertices.push([c[1], c[2]]); }) : undefined);
  walk(scene.prims);
  const passes = (hex: number) => {
    const c = hexCenter(hex % 40, Math.floor(hex / 40), opts.size);
    return vertices.some(([x, y]) => Math.hypot(x - c.x, y - c.y) < 1e-6);
  };
  // Hex 87's land facing realm J's hex 46 is a strip along the coast: the border runs through its centre.
  assert.ok(passes(87));
  // Hex 794's land facing realm A is most of its sector: the border keeps to the hex edges.
  assert.ok(!passes(794));
});
