/**
 * How local the coast is (DECISIONS §91): whether a window of the map draws the same coast near its
 * middle as the whole map does.
 *
 *   npx tsx scripts/coast-locality.ts [populated|mixed] [smooth]
 *
 * "shift" crops one column or two rows off the map (renumbering hexes and moving page coordinates)
 * and measures the coast more than four hexes from the edges. "mask" keeps the map's size, indices
 * and coordinates, turns every hex beyond `margin` of a coastal hex to Sea, and measures the coast
 * within 1.5 hexes of it. Distances are from each point of the whole map's coast to the nearest
 * segment of the other. `smooth` sets Smooth irregularity, which has no roughening.
 */
import { fixture, options } from './render-profile-input.ts';
import { buildStaticScene } from '../src/render/scene.ts';
import { createMapState } from '../shared/layers.ts';
import { neighbourOf, inBounds, hexCenter } from '../shared/hex.ts';
import { pathPolylines } from '../src/render/ice.ts';
const kind = process.argv[2] ?? 'populated';
const map = fixture(kind), { cols, rows } = map;
if (process.argv[3] === 'smooth') { (map as any).defaultIrregularity = 'Smooth'; (map as any).defaultLakeIrregularity = 'Smooth'; }
const opts: any = options(); opts.labels = false; opts.visible = { base: true };
const SQ = Math.sqrt(3), size = opts.size;
const base = map.layers.base.data!;
const coastHexes = base.flatMap((v, i) => v === 'Land' && [0,1,2,3,4,5].some(e => { const n = neighbourOf(i % cols, Math.floor(i / cols), e); return inBounds(cols, rows, n.col, n.row) && base[n.row * cols + n.col] === 'Sea'; }) ? [i] : []);
const ringsOf = (scene: any, dx = 0, dy = 0) => { const out: number[][][] = []; const walk = (ps: any[]) => { for (const p of ps) { if (p.kind === 'group') walk(p.prims); else if (p.kind === 'path' && p.stroke === opts.style.palette.coast) { for (const ring of pathPolylines(p.d, 8)) out.push(ring.map(q => [q.x + dx, q.y + dy])); } } }; walk(scene.prims); return out; };
// Distance from each point to the nearest segment of the other rings, by a grid of segments.
const segDistance = (rings: number[][][]) => { const cell = 8, grid = new Map<string, number[][]>(); for (const r of rings) for (let k = 0; k + 1 < r.length; k++) { const [ax, ay] = r[k]!, [bx, by] = r[k + 1]!; for (let x = Math.floor(Math.min(ax!, bx!) / cell); x <= Math.floor(Math.max(ax!, bx!) / cell); x++) for (let y = Math.floor(Math.min(ay!, by!) / cell); y <= Math.floor(Math.max(ay!, by!) / cell); y++) { const key = x + ',' + y; (grid.get(key) ?? grid.set(key, []).get(key)!).push([ax!, ay!, bx!, by!]); } }
  return (x: number, y: number) => { let best = Infinity; for (let reach = 1; reach <= 8 && best > (reach - 1) * cell; reach *= 2) { const cx = Math.floor(x / cell), cy = Math.floor(y / cell); for (let i = cx - reach; i <= cx + reach; i++) for (let j = cy - reach; j <= cy + reach; j++) for (const [ax, ay, bx, by] of grid.get(i + ',' + j) ?? []) { const dx = bx! - ax!, dy = by! - ay!, l = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - ax!) * dx + (y - ay!) * dy) / l)); best = Math.min(best, Math.hypot(x - ax! - t * dx, y - ay! - t * dy)); } } return best; }; };
const crop = (m: any, c0: number, r0: number, w: number, h: number) => {
  const out: any = createMapState('crop', w, h);
  out.id = m.id; out.hexDimensions = m.hexDimensions; out.defaultIrregularity = m.defaultIrregularity; out.defaultLakeIrregularity = m.defaultLakeIrregularity;
  const idx = (c: number, r: number) => r * m.cols + c;
  out.layers.base.data = Array.from({ length: w * h }, (_, i) => m.layers.base.data[idx(c0 + i % w, r0 + Math.floor(i / w))]);
  const remap = (rec: any) => rec && Object.fromEntries(Object.entries(rec).flatMap(([k, v]) => { const c = Number(k) % m.cols - c0, r = Math.floor(Number(k) / m.cols) - r0; return c >= 0 && c < w && r >= 0 && r < h ? [[String(r * w + c), v]] : []; }));
  out.hexShapes = remap(m.hexShapes); out.islandSpecs = remap(m.islandSpecs);
  return out;
};

{
  const whole = crop(map, 0, 0, cols, rows), shifted = crop(map, 1, 0, cols - 1, rows), shifted2 = crop(map, 0, 2, cols, rows - 2);
  const a = ringsOf(buildStaticScene(map, opts)).flat();
  for (const [name, m, dx, dy] of [['whole', whole, 0, 0], ['minus first column', shifted, size * SQ, 0], ['minus two rows', shifted2, 0, size * 3]] as const) {
    const dist = segDistance(ringsOf(buildStaticScene(m, opts), dx, dy));
    // Away from the map's edges (more than 4 hexes in).
    const ds: number[] = [];
    for (const [x, y] of a) { if (x! < size * 8 || y! < size * 8 || x! > size * SQ * (cols - 4) || y! > size * 1.5 * (rows - 4)) continue; ds.push(dist(x!, y!)); }
    ds.sort((p, q) => p - q); console.log(name, 'interior points', ds.length, 'p50', ds[ds.length >> 1]?.toFixed(3), 'p95', ds[Math.floor(ds.length * .95)]?.toFixed(3), 'max', ds.at(-1)?.toFixed(3));
  }
}
{
  // Mask, not crop: hexes beyond `margin` of a coastal hex become Sea; indices and coordinates stay.
  const fullD = ringsOf(buildStaticScene(map, opts));
  for (const k of [.3, .55, .8]) {
    const hex = coastHexes[Math.floor(coastHexes.length * k)]!, hc = hex % cols, hr = Math.floor(hex / cols), at = hexCenter(hc, hr, size);
    for (const margin of [4, 6, 9]) {
      const masked: any = { ...map, layers: { ...map.layers, base: { ...map.layers.base, data: base.map((v, i) => Math.abs(i % cols - hc) <= margin && Math.abs(Math.floor(i / cols) - hr) <= margin ? v : 'Sea') } } };
      const t = performance.now(); const dist = segDistance(ringsOf(buildStaticScene(masked, opts))); const ms = performance.now() - t;
      const ds: number[] = []; for (const r of fullD) for (const [x, y] of r) if (Math.hypot(x! - at.x, y! - at.y) < size * 3) ds.push(dist(x!, y!));
      ds.sort((p, q) => p - q); console.log(`mask hex ${hex} margin ${margin}: ${Math.round(ms)} ms, within 1.5 hexes p50 ${ds[ds.length >> 1]?.toFixed(3)} p95 ${ds[Math.floor(ds.length * .95)]?.toFixed(3)} max ${ds.at(-1)?.toFixed(3)} px`);
    }
  }
}
