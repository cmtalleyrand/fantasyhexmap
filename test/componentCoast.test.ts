import assert from 'node:assert/strict';
import test from 'node:test';
import { coastEdges, coastGeometryOf, coastKey, evenOddTest, surfaceEdges, surfaceMap, type CoastEdge } from '../src/render/coast.ts';
import { shapeCoast } from '../src/render/footprint.ts';
import { pathPolylines } from '../src/render/ice.ts';
import { hexCenter, type Point } from '../shared/hex.ts';
import type { BaseGeo } from '../shared/types.ts';
const size = 30, cols = 8, rows = 8;
const noise = (x: number, y: number, k: number) => ((Math.sin(x * 12.9898 + y * 78.233 + k * 3.1) * 43758.5453) % 1 + 1) % 1;
function draw(base: BaseGeo[], scale = size) {
  return coastGeometryOf(coastEdges(base, cols, rows, scale), true, { size: scale, noise, amplitude: () => 0.2 });
}
function crossings(rings: Point[][]) {
  const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  let count = 0;
  rings.forEach((ring, r) => {
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length]!;
      rings.forEach((other, s) => {
        if (s < r)
          return;
        other.forEach((c, j) => {
          if (s === r && (j <= i || j === i + 1 || (i === 0 && j === ring.length - 1)))
            return;
          const d = other[(j + 1) % other.length]!;
          if (cross(a, b, c) * cross(a, b, d) < -1e-8 && cross(c, d, a) * cross(c, d, b) < -1e-8)
            count++;
        });
      });
    });
  });
  return count;
}
test('a three-hex component loses its grid-scale notches without crossings or losing its land centres', () => {
  const base: BaseGeo[] = Array(64).fill('Sea');
  for (const i of [19, 27, 36])
    base[i] = 'Land';
  const geometry = draw(base);
  const rings = geometry.paths.flatMap(d => pathPolylines(d, 6));
  assert.equal(rings.length, 1);
  assert.equal(crossings(rings), 0);
  const inside = evenOddTest(rings, size / 8);
  for (const i of [19, 27, 36])
    assert.ok(inside(hexCenter(i % cols, Math.floor(i / cols), size)));
  // A continuous silhouette should have no sharp reversals at hex junctions.
  const ring = rings[0]!;
  let maxTurn = 0;
  ring.forEach((p, i) => {
    const a = ring[(i - 1 + ring.length) % ring.length]!, b = ring[(i + 1) % ring.length]!;
    const u = { x: p.x - a.x, y: p.y - a.y }, v = { x: b.x - p.x, y: b.y - p.y };
    maxTurn = Math.max(maxTurn, Math.abs(Math.atan2(u.x * v.y - u.y * v.x, u.x * v.x + u.y * v.y)));
  });
  assert.ok(maxTurn < 0.4, `continuous tangent: largest sample turn ${maxTurn}`);
});
test('component coastlines are deterministic, scale with zoom, and map border anchors onto the actual contour', () => {
  const base: BaseGeo[] = Array(64).fill('Sea');
  for (const i of [19, 27, 36])
    base[i] = 'Land';
  const first = draw(base), second = draw(base), zoomed = draw(base, size * 2);
  assert.deepEqual(first.paths, second.paths);
  const a = pathPolylines(first.paths[0]!, 6)[0]!, b = pathPolylines(zoomed.paths[0]!, 6)[0]!;
  assert.equal(a.length, b.length);
  a.forEach((p, i) => assert.ok(Math.hypot(p.x * 2 - b[i]!.x, p.y * 2 - b[i]!.y) < 1e-7));
  for (const point of first.chains[0]!.points) {
    const anchor = first.anchors.get(coastKey(point))!;
    assert.ok(anchor);
    const nearest = Math.min(...a.map((p, i) => {
      const q = a[(i + 1) % a.length]!, dx = q.x - p.x, dy = q.y - p.y;
      const t = Math.max(0, Math.min(1, ((anchor.x - p.x) * dx + (anchor.y - p.y) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(anchor.x - p.x - dx * t, anchor.y - p.y - dy * t);
    }));
    assert.ok(nearest < 1e-7);
  }
});
test('an explicit narrow isthmus or strait retains its centre and at least half its specified width', () => {
  for (const type of ['Isthmus', 'Strait'] as const) {
    const base: BaseGeo[] = Array(64).fill(type === 'Isthmus' ? 'Sea' : 'Land');
    base[26] = 'Land';
    base[28] = 'Land';
    base[19] = 'Sea';
    base[35] = 'Sea';
    base[27] = type;
    const surface = surfaceMap(base, cols, rows), edges = surfaceEdges(surface, size, s => s === 'land');
    const width = size * Math.sqrt(3) * 0.1;
    const shaped = shapeCoast(edges, surface, size, new Map([[27, { share: 0.5, kind: type === 'Isthmus' ? 'neck' : 'channel', width }]]))!;
    const limit = (e: CoastEdge) => (e.hex === 27 || e.across === 27) ? width * 0.15 : Infinity;
    const geometry = coastGeometryOf(shaped.edges, true, { size, noise, amplitude: () => 0.2, displacementLimit: limit }, shaped);
    const rings = geometry.paths.flatMap(d => pathPolylines(d, 6));
    assert.equal(crossings(rings), 0, type);
    const inside = evenOddTest(rings, size / 8), centre = hexCenter(3, 3, size);
    // The land neck runs east-west; the water channel runs north-south.
    // These closed rings enclose the land island or the water hole, respectively.
    for (let y = -width * 0.25; y <= width * 0.25; y += width / 8) {
      assert.equal(inside(type === 'Isthmus' ? { x: centre.x, y: centre.y + y } : { x: centre.x + y, y: centre.y }), true, `${type} width at y=${y}`);
    }
  }
});

test('coast components remain disjoint across varied seeds, with lakes and small islands retained', () => {
  const base: BaseGeo[] = Array(64).fill('Sea');
  for (const i of [9,10,11,17,18,19,25,26,27,45,46,53,54]) base[i] = 'Land';
  base[18] = 'Sea'; // water hole in the northern island
  for (let seed = 0; seed < 12; seed++) {
    const geometry = coastGeometryOf(coastEdges(base, cols, rows, size), true, {
      size, noise: (x,y,k) => noise(x,y,k+seed*100), amplitude: () => 0.2,
    });
    const rings = geometry.paths.flatMap(d => pathPolylines(d,6));
    assert.equal(rings.length,3,'two land components and a water hole');
    assert.equal(crossings(rings),0,`seed ${seed}`);
    const inside = evenOddTest(rings,size/8);
    assert.equal(inside(hexCenter(2,2,size)),false,'water hole remains water');
    assert.equal(inside(hexCenter(5,6,size)),true,'small component remains land');
  }
});

test('open component coasts keep their map-edge endpoints and respond to the seed', () => {
  const base: BaseGeo[] = Array.from({length:64},(_,i) => i%cols<4?'Land':'Sea');
  const edges = coastEdges(base,cols,rows,size);
  const make = (k:number) => coastGeometryOf(edges,true,{size,noise:(x,y,p)=>noise(x,y,p+k),amplitude:()=>0.2});
  const a=make(0),b=make(20);
  assert.notDeepEqual(a.paths,b.paths);
  a.chains.forEach((chain,i)=>{
    assert.equal(chain.closed,false);
    const ring=pathPolylines(a.paths[i]!,6)[0]!;
    assert.deepEqual(ring[0],chain.points[0]);
    assert.deepEqual(ring.at(-1),chain.points.at(-1));
  });
});
