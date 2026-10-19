import assert from 'node:assert/strict';
import test from 'node:test';
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
    if (p.kind === 'path' && p.fill === opts.style.palette.island) paths.push(p);
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
