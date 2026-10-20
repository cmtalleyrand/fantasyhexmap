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
