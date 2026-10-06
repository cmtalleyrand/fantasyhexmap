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
  // Fine irregularity is intentional: test against fold-backs and intersections, rather
  // than requiring every coast sample to have the low curvature of a smooth capsule.
  const ring = rings[0]!.slice(0, -1);
  ring.forEach((p, i) => {
    const q = ring[(i + 1) % ring.length]!;
    const length = Math.hypot(q.x - p.x, q.y - p.y);
    assert.ok(length > 0 && length < size * 0.3, 'detail is sampled continuously');
  });
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
    for (let seed = 0; seed < 32; seed++) {
      const geometry = coastGeometryOf(shaped.edges, true, { size, noise: (x, y, k) => noise(x, y, k + seed * 100), amplitude: () => 0.2, displacementLimit: limit }, shaped);
      const rings = geometry.paths.flatMap(d => pathPolylines(d, 6));
      assert.equal(crossings(rings), 0, `${type}, seed ${seed}`);
      const inside = evenOddTest(rings, size / 8), centre = hexCenter(3, 3, size);
      // The land neck runs east-west; the water channel runs north-south.
      // These closed rings enclose the land island or the water hole, respectively.
      for (let y = -width * 0.25; y <= width * 0.25; y += width / 8) {
        assert.equal(inside(type === 'Isthmus' ? { x: centre.x, y: centre.y + y } : { x: centre.x + y, y: centre.y }), true, `${type}, seed ${seed}, width at y=${y}`);
      }
    }
  }
});

test('coast components remain disjoint across varied seeds, with lakes and small islands retained', () => {
  const base: BaseGeo[] = Array(64).fill('Sea');
  for (const i of [9,10,11,17,18,19,25,26,27,45,46,53,54]) base[i] = 'Land';
  base[18] = 'Sea'; // water hole in the northern island
  for (let seed = 0; seed < 32; seed++) {
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

test('irregularity survives the silhouette stage, grows with its level, and does not lock to hex intervals', () => {
  const base: BaseGeo[] = Array(64).fill('Sea');
  for (const i of [19, 27, 36]) base[i] = 'Land';
  const edges = coastEdges(base, cols, rows, size);
  const make = (amplitude: number, seeded = true) => pathPolylines(coastGeometryOf(edges, true, {
    size, noise: seeded ? noise : () => 0.5, amplitude: () => amplitude,
  }).paths[0]!, 6)[0]!.slice(0, -1);
  const quiet = make(0.12, false);
  const residual = (amplitude: number) => {
    const ring = make(amplitude);
    return ring.map((p, i) => {
      const a = quiet[(i - 1 + quiet.length) % quiet.length]!, b = quiet[(i + 1) % quiet.length]!;
      const dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx,dy);
      return ((p.x - quiet[i]!.x) * -dy + (p.y - quiet[i]!.y) * dx) / length;
    });
  };
  const rms = (values: number[]) => Math.sqrt(values.reduce((sum, v) => sum + v*v, 0) / values.length);
  const ragged = rms(residual(0.12));
  assert.ok(ragged > size * 0.045, `visible Ragged displacement: ${ragged / size} hex radii`);

  // Measure level progression on fine detail: broad bays can reach explicit width limits
  // before local detail does. Whole-outline RMS conflates the two geometric stages.
  const offsets = residual(0.12), span = Math.round(size * 0.3 / (edges.length * size / quiet.length));
  const detail = (values: number[]) => values.map((value, i) => {
    let sum = 0;
    for (let k = -span; k <= span; k++) sum += values[(i + k + values.length) % values.length]!;
    return value - sum / (2 * span + 1);
  });
  const fine = detail(offsets);
  const detailLevels = [0.06, 0.12, 0.2].map(a => rms(detail(residual(a))));
  assert.ok(detailLevels[1]! > detailLevels[0]! * 1.4 && detailLevels[2]! > detailLevels[1]! * 1.2, `levels preserve progressively more fine detail: ${detailLevels}`);
  assert.ok(rms(fine) > size * 0.018, 'smaller bays and points survive alongside larger changes');
  const crossingArcs: number[] = [];
  const step = edges.reduce((sum,e) => sum + Math.hypot(e.to.x-e.from.x,e.to.y-e.from.y),0) / offsets.length;
  offsets.forEach((a,i) => {
    const b = offsets[(i+1)%offsets.length]!;
    if (a*b<0) crossingArcs.push((i+a/(a-b))*step);
  });
  assert.ok(crossingArcs.length >= 8, 'both bays and points occur around the component');
  const coherence = Math.hypot(
    crossingArcs.reduce((sum,arc)=>sum+Math.cos(arc/size*Math.PI*2),0),
    crossingArcs.reduce((sum,arc)=>sum+Math.sin(arc/size*Math.PI*2),0),
  ) / crossingArcs.length;
  assert.ok(coherence < 0.5, `detail phases do not align with hex-edge lengths: ${coherence}`);
});

test('the final land silhouette has ground beneath folds in its donor patches', async () => {
  const { createMapState } = await import('../shared/layers.ts');
  const { buildScene, defaultVisibility, landTestOf } = await import('../src/render/scene.ts');
  const { resolveStyle } = await import('../src/render/styles.ts');
  const map = createMapState('Coast evidence', cols, rows);
  map.id = 'coast-evidence';
  map.layers.base.data = Array(64).fill('Sea');
  for (const i of [19, 27, 36]) map.layers.base.data[i] = 'Coastal Land';
  map.defaultIrregularity = 'Ragged';
  const style = resolveStyle({ preset: 'parchment' });
  const scene = buildScene(map, { size, visible: defaultVisibility(), labels: false, style });
  // These points were visible pinholes where the swept patch folded at an old hex corner.
  // Test the rendered scene's actual painted coverage as well as its geometric land predicate.
  for (const point of [{ x: 210.5, y: 130.5 }, { x: 211, y: 131 }]) {
    assert.equal(landTestOf(scene)!(point), true);
    let landPainted = false;
    const covers = (rings: Point[][]) => evenOddTest(rings, size / 8)(point);
    const inspect = (prims: typeof scene.prims, visible = true) => {
      for (const prim of prims) {
        if (prim.kind === 'group') {
          inspect(prim.prims, visible && (!prim.clip || covers(pathPolylines(prim.clip,6))));
        } else if (visible && (prim.fill === style.palette.land || prim.fill === style.palette.coastalLand)) {
          if (prim.kind === 'polygon' && covers([prim.points])) landPainted = true;
          if (prim.kind === 'path' && covers(pathPolylines(prim.d,6))) landPainted = true;
        }
      }
    };
    inspect(scene.prims);
    assert.ok(landPainted, 'the land has a donor ground fill rather than showing the sea background');
  }
});
