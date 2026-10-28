import { createMapState } from './seededMap.ts';
import { buildScene, defaultVisibility, landTestOf } from '../src/render/scene.ts';
import { NEW_USER_STYLE_CHOICE, resolveStyle } from '../src/render/styles.ts';
import { hexCorners, neighbourOf } from '../shared/hex.ts';
const style = resolveStyle(NEW_USER_STYLE_CHOICE), size = 30;
for (const water of ['Lake', 'Sea'] as const) for (const [coastal, lakeLand] of [[80, 10], [95, 5], [80, 30], [60, 20]]) {
  const map = createMapState('probe', 5, 5);
  map.id = 'lake-concentration-evidence';
  map.layers.base.data = Array(25).fill('Land'); map.layers.base.data[12] = water;
  map.hexDimensions.coastalLandPercent = coastal; map.hexDimensions.lakeLandPercent = lakeLand; map.hexDimensions.seaLandPercent = lakeLand;
  const t0 = Date.now();
  const scene = buildScene(map, { size, style, visible: defaultVisibility(), labels: false, cache: 'off' });
  const ms = Date.now() - t0;
  const dry = landTestOf(scene)!;
  const share = (i: number) => {
    const c = hexCorners(i % 5, Math.floor(i / 5), size);
    const xs = c.map(p => p.x), ys = c.map(p => p.y);
    let n = 0, l = 0;
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.5) for (let y = Math.min(...ys); y <= Math.max(...ys); y += 0.5) {
      let inside = true;
      for (let k = 0; k < 6; k++) { const a = c[k]!, b = c[(k + 1) % 6]!; if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < 0) { inside = false; break; } }
      if (!inside) continue; n++; if (dry({ x, y })) l++;
    }
    return (l / n * 100).toFixed(0);
  };
  const nbs = [0, 1, 2, 3, 4, 5].map(e => { const n = neighbourOf(2, 2, e); return n.row * 5 + n.col; });
  console.log(`${water} land ${coastal}% water-land ${lakeLand}%: water hex ${share(12)}%, shore ${nbs.map(share).join(' ')}  reports ${JSON.stringify(scene.compromises?.map(c => c.what) ?? [])} ${ms}ms`);
}
