import assert from 'node:assert/strict';
import test from 'node:test';
import { nearestOn } from '../src/render/footprint.ts';
import { hexCenter, pixelToOffset } from '../shared/hex.ts';
import { beginRenderProfile, endRenderProfile } from '../src/render/profile.ts';
import { windingRiver, riverMetrics, cases, buildScene, landTestOf } from '../scripts/drawing-investigation-fixtures.ts';
import { riverCourse, landBySide } from '../src/render/rivers.ts';
import { evenOddTest } from '../src/render/coast.ts';
import { pathPolylines } from '../src/render/ice.ts';
import type { Prim } from '../src/render/prims.ts';
import { coastMap, options } from '../scripts/drawing-investigation-fixtures.ts';
import { groupCompromises } from '../src/render/compromises.ts';
import { escarpmentWithinLand } from '../src/render/symbols.ts';
import { auditScene } from '../src/render/audit.ts';
import { placeRiverLabels } from '../src/render/featureLabels.ts';

test('gentle rivers stay in their hexes and below 60 degrees across 400 pinned seeds', () => {
  const river = windingRiver();
  for (let n = 0; n < 400; n++) {
    const metrics = riverMetrics(riverCourse(river, 20, `s${n}`, { wander: 'gentle' })!.centreline);
    assert.equal(metrics.outside, 0, `s${n}: left own hexes`);
    assert.ok(metrics.maxTurn < 60, `s${n}: ${metrics.maxTurn} degrees at ${metrics.turnAt}`);
  }
});

test('nearest-segment side misclassifies a point beyond a sharp spit tip', () => {
  const ring = [{ x: 0, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 20 }];
  const parity = evenOddTest([ring], 2), point = { x: 20.11, y: 10.09 };
  assert.equal(parity(point), false);
  assert.equal(landBySide([[...ring, ring[0]!]], 100, parity)(point), true);
});

test('island land queries agree with the finished irregular island paths', () => {
  const { map, opts } = cases().find(c => c.name === 'islands')!;
  const scene = buildScene(map, opts), land = landTestOf(scene)!;
  const paths: Extract<Prim, { kind: 'path' }>[] = [];
  const visit = (prims: Prim[]) => { for (const p of prims) {
    if (p.kind === 'group') visit(p.prims);
    if (p.kind === 'path' && p.fill === ((opts.uniformLand ?? opts.style.knobs.land === 'uniform') ? opts.style.palette.land : opts.style.palette.island) && p.stroke === undefined) paths.push(p);
  } };
  visit(scene.prims);
  assert.ok(paths.length > 0, 'painted island paths found');
  const bodies = paths.flatMap(p => pathPolylines(p.d, 24)).map(r => evenOddTest([r], 2));
  // Below the mainland coast: no mainland can obscure the island comparison.
  for (let y = 146; y < 198; y += .7) for (let x = 130; x < 217; x += .7) {
    const q = { x, y };
    // Ignore a subpixel neighbourhood of the flattened curve, not whole coastal pixels.
    const expected = bodies.some(body => body(q));
    const stable = [[-.15,0],[.15,0],[0,-.15],[0,.15]].every(([dx,dy]) => bodies.some(body => body({ x:x+dx!, y:y+dy! })) === expected);
    if (stable) assert.equal(land(q), expected, `at ${x},${y}`);
  }
});

test('routine placement of a city onto dry ground does not produce a compromise notice', () => {
  const { map, opts } = cases().find(c => c.name === 'realm-illustrated')!;
  const scene = buildScene(map, opts);
  assert.ok(!scene.compromises?.some(c => /City.*moved onto land/.test(c.what)));
});

test('an island drawn with curves inside a lake is dry ground', () => {
  const { map, opts } = cases().find(c=>c.name==='lake-island')!;
  const scene=buildScene(map,opts), land=landTestOf(scene)!;
  assert.equal(land({x:opts.size*Math.sqrt(3)*(3+.5)+opts.size*Math.sqrt(3)/2,y:opts.size*(1.5*3+1)}),true);
});

test('a coast patch beside a lake belongs to dry ground outside the lake body', () => {
  const {map,opts}=cases().find(c=>c.name==='lake')!;
  assert.equal(landTestOf(buildScene(map,opts))!({x:136,y:140}),true);
});

test('a low-share open coast has no fold-back loops after roughening', () => {
  const { map, opts } = cases().find(c => c.name === 'coast-fit-parchment')!;
  const rings: { x: number; y: number }[][] = [];
  const collect = (ps: Prim[]) => { for (const p of ps) {
    if (p.kind === 'group') collect(p.prims);
    else if (p.kind === 'path' && p.stroke === opts.style.palette.coast) rings.push(...pathPolylines(p.d, 12));
  } };
  collect(buildScene(map, opts).prims);
  const cross = (a: {x:number;y:number}, b: {x:number;y:number}, c: {x:number;y:number}) =>
    (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  let crossings = 0;
  for (const ring of rings) for (let i=0;i+1<ring.length;i++) for (let j=i+2;j+1<ring.length;j++) {
    const a=ring[i]!,b=ring[i+1]!,c=ring[j]!,d=ring[j+1]!;
    if(cross(a,b,c)*cross(a,b,d)<-1e-8&&cross(c,d,a)*cross(c,d,b)<-1e-8)crossings++;
  }
  assert.equal(crossings, 0, 'coast ink must not cross itself into a knot');
  // Read the finished contour over a four-unit arc on each side, independently
  // of the loop cleanup and fitter. The rejected cape turned about 143 degrees.
  let worstTurn=0;
  for(const ring of rings)for(let i=1;i+1<ring.length;i++) {
    const p=ring[i]!;
    if(p.x<155||p.x>195||p.y<120)continue;
    const along=(direction:number)=>{
      let j=i,length=0;
      while(j+direction>=0&&j+direction<ring.length&&length<opts.size*.1){
        const a=ring[j]!,b=ring[j+direction]!;length+=Math.hypot(b.x-a.x,b.y-a.y);j+=direction;
      }
      return ring[j]!;
    };
    const a=along(-1),b=along(1),ux=p.x-a.x,uy=p.y-a.y,vx=b.x-p.x,vy=b.y-p.y;
    worstTurn=Math.max(worstTurn,Math.abs(Math.atan2(ux*vy-uy*vx,ux*vx+uy*vy))*180/Math.PI);
  }
  assert.ok(worstTurn<110,`low-share cape is pinched into a ${worstTurn.toFixed(1)} degree turn`);

});

test('stopping plateau escarpments at water does not produce a compromise notice', () => {
  const map = coastMap(5);
  map.layers.elevation.data![12] = 'Plateau';
  const scene = buildScene(map, options());
  const notes = scene.compromises?.filter(c => c.hexes.includes(12) && c.what === 'Plateau escarpment left out');
  assert.equal(notes?.length ?? 0, 0);
});

test('escarpment ink clears the shore and its long strokes cannot bridge a bay', () => {
  const mark = { y: 2, prims: [{ kind: 'path' as const, d: [['M', 0, 2], ['L', 10, 2]] as import('../src/render/prims.ts').PathCmd[], stroke: '#000', strokeWidth: 2 }] };
  assert.equal(escarpmentWithinLand(mark, p=>p.y>0, .5), true);
  assert.equal(escarpmentWithinLand(mark, p=>p.y>1, .5), false, 'ink and clearance cross the shore');
  assert.equal(escarpmentWithinLand(mark, p=>p.x<2||p.x>3, 0), false, 'a bay between the old vertex/midpoint probes');
});

test('grouped reports put losses ahead of repeated adaptations and retain every hex', () => {
  const notes = Array.from({ length: 100 }, (_, i) => ({ hexes: [i], what: 'Mountains symbols drawn at 30% size', why: 'small island', severity: 'adaptation' as const }));
  const groups = groupCompromises([...notes, { hexes: [105], what: 'No mountains symbols drawn', why: 'no room', severity: 'loss' }]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0]!.hexes, [105]);
  assert.equal(groups[1]!.hexes.length, 100);
  assert.equal(notes[0]!.hexes.length, 1, 'grouping does not mutate scene metadata');
});

test('a water name that cannot fit stays off land and its omission is reported', () => {
  for(const name of ['small-sea-name','small-lake-name']){
    const {map,opts}=cases().find(c=>c.name===name)!;
    const scene=buildScene(map,opts);
    assert.deepEqual(auditScene(map,scene,opts.size).filter(i=>i.kind==='sea-name-over-land'),[]);
    assert.ok(scene.compromises?.some(c=>c.what.includes('Water name')&&c.what.includes('left out')&&c.hexes.includes(12)));
  }
});

test('river names cannot use an open-sea fallback and an omitted name is reported', () => {
  assert.deepEqual(placeRiverLabels([windingRiver()],20,undefined,undefined,[],undefined,undefined,undefined,()=>false),[]);
  const {map,opts}=cases().find(c=>c.name==='river-mouth')!;
  const scene=buildScene(map,opts);
  assert.deepEqual(auditScene(map,scene,opts.size).filter(i=>i.kind==='river-name-over-water'),[]);
});

for (const name of ['coast-fit-classic', 'coast-fit-parchment']) test(`${name} reaches its land share on the finished outline`, () => {
  const {map,opts}=cases().find(c=>c.name===name)!;
  beginRenderProfile();
  const scene=buildScene(map,{...opts,cache:'off'}),profile=endRenderProfile()!;
  const land=landTestOf(scene)!,c=hexCenter(2,2,opts.size);
  const ink: {rings: {x:number;y:number}[][];reach:number}[]=[];
  const collect=(ps:Prim[])=>{for(const p of ps){if(p.kind==='group')collect(p.prims);else if(p.kind==='path'&&p.stroke===opts.style.palette.coast)ink.push({rings:pathPolylines(p.d,12),reach:(p.strokeWidth??1)/2});}};
  collect(scene.prims);
  let total=0,dry=0;
  for(let y=c.y-opts.size;y<c.y+opts.size;y+=.25)for(let x=c.x-opts.size;x<c.x+opts.size;x+=.25){
    const h=pixelToOffset(x,y,opts.size);if(h.col!==2||h.row!==2)continue;
    total++;if(land({x,y})||ink.some(s=>nearestOn({x,y},s.rings).dist<=s.reach))dry++;
  }
  const wanted=map.hexShapes!['12']!.land!;
  assert.ok(Math.abs(100*dry/total-wanted)<1, `${100*dry/total}% versus ${wanted}%`);
  assert.ok(!scene.compromises?.some(c=>c.hexes.includes(12)&&/land share/i.test(c.what)));
  if(name==='coast-fit-classic')assert.equal(profile.counters['coast.globalPasses'],4);
});
