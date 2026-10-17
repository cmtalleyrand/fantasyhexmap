/**
 * Scene-construction benchmark on a map that exercises the coast fitting: explicit land shares,
 * concentration, straits, isthmuses, island hexes and lakes. The older render-performance fixtures
 * contain none of these, which is why they did not show the regressions of PRs #128–#136.
 *
 *   node --import tsx scripts/coast-feature-benchmark.ts [--root <checkout>] [--size 30] [--runs 1] [--layout mixed|plain]
 *
 * `--root` points at another checkout (for example a `git archive` of an older commit with
 * node_modules linked) so revisions are timed on the same fixture. Prints, per run, the cold build,
 * a one-hex edit rebuild, scene weight, and the share error measured from the finished scene.
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name: string, fallback: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback;
const root = resolve(arg('--root', '.'));
const N = Number(arg('--size', '30'));
const runs = Number(arg('--runs', '1'));
const layout = arg('--layout', 'mixed');
const load = (file: string) => import(pathToFileURL(resolve(root, file)).href);
const { createMapState } = await load('shared/layers.ts');
const { buildStaticScene, defaultVisibility, landTestOf } = await load('src/render/scene.ts');
const { resolveStyle } = await load('src/render/styles.ts');
const { neighbourOf, inBounds, hexIndex, hexCenter } = await load('shared/hex.ts');

function fixture() {
  const map = createMapState('Coast feature benchmark', N, N);
  map.id = `coast-feature-${layout}`;
  let state = 12345;
  const random = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  const base: string[] = Array.from({ length: N * N }, (_, i) => {
    const x = i % N, y = Math.floor(i / N);
    const d = Math.hypot(x - N / 2, (y - N / 2) * 0.9) + Math.sin(y / 2.3) * 3 + Math.cos(x / 1.7) * 2;
    return d < N * 0.33 ? 'Land' : 'Sea';
  });
  for (let k = 0; k < 6; k++) {
    const c = Math.floor(N * 0.4 + random() * N * 0.2) * N + Math.floor(N * 0.35 + random() * N * 0.3);
    if (base[c] === 'Land') base[c] = 'Lake';
  }
  const neighbours = (i: number) => [0, 1, 2, 3, 4, 5].map(e => {
    const n = neighbourOf(i % N, Math.floor(i / N), e);
    return inBounds(N, N, n.col, n.row) ? hexIndex(N, n.col, n.row) : -1;
  });
  const shapes: Record<string, object> = {}, islandSpecs: Record<string, object> = {};
  const original = [...base];
  for (let i = 0; i < N * N; i++) {
    const around = neighbours(i);
    if (original[i] === 'Land' && around.some(j => j >= 0 && original[j] === 'Sea')) {
      const r = random();
      if (layout === 'plain') { base[i] = 'Coastal Land'; continue; }
      if (r < 0.06) { base[i] = 'Strait'; shapes[i] = { type: 'Strait', land: 40 }; }
      else if (r < 0.10) { base[i] = 'Isthmus'; shapes[i] = { type: 'Isthmus', land: 50 }; }
      else if (r < 0.16) { base[i] = 'Mainland and islands'; islandSpecs[i] = { count: 2 }; }
      else {
        base[i] = 'Coastal Land';
        if (r < 0.7) shapes[i] = { type: 'Coastal Land', land: 30 + Math.round(random() * 60),
          ...(r < 0.4 ? { concentrationSide: Math.floor(random() * 6), concentration: 60 } : {}) };
      }
    } else if (original[i] === 'Sea' && around.some(j => j >= 0 && original[j] === 'Land') && random() < 0.08 && layout !== 'plain') {
      base[i] = 'Islands';
      islandSpecs[i] = { count: 1 + Math.floor(random() * 3) };
    }
  }
  map.layers.base.data = base;
  map.hexShapes = shapes;
  map.islandSpecs = islandSpecs;
  return map;
}

const size = 26;
const options = { size, visible: defaultVisibility(), labels: false, style: resolveStyle({ preset: 'parchment', overrides: { coast: 'smooth' } }) };
for (let run = 0; run < runs; run++) {
  const map = fixture();
  map.id += run;
  const start = performance.now();
  const scene = buildStaticScene(map, options);
  const cold = performance.now() - start;
  const base = [...map.layers.base.data];
  const edited = Math.floor(N / 2) * N + Math.floor(N * 0.17);
  base[edited] = base[edited] === 'Sea' ? 'Coastal Land' : 'Sea';
  const t = performance.now();
  buildStaticScene({ ...map, layers: { ...map.layers, base: { ...map.layers.base, data: base } } }, options);
  const edit = performance.now() - t;
  let prims = 0, commands = 0;
  const walk = (list: Array<{ d?: unknown[]; prims?: unknown[]; clip?: unknown[] }>) => {
    for (const p of list) {
      prims++;
      commands += (p.d?.length ?? 0) + (p.clip?.length ?? 0);
      if (p.prims) walk(p.prims as typeof list);
    }
  };
  walk(scene.prims);
  // Share error measured from the finished picture (fill only; the coastline's ink is not counted).
  const land = landTestOf(scene);
  const errors: number[] = [];
  for (const [key, shape] of Object.entries(map.hexShapes as Record<string, { type: string; land?: number }>)) {
    if (!land || shape.land === undefined || shape.type !== 'Coastal Land') continue;
    const i = Number(key), c = hexCenter(i % N, Math.floor(i / N), size);
    let inside = 0, dry = 0;
    for (let x = -size; x <= size; x += size / 24) for (let y = -size; y <= size; y += size / 24) {
      if (Math.abs(x) > Math.sqrt(3) / 2 * size || Math.abs(y) + Math.abs(x) / Math.sqrt(3) > size) continue;
      inside++;
      if (land({ x: c.x + x, y: c.y + y })) dry++;
    }
    errors.push(Math.abs(dry / inside * 100 - shape.land));
  }
  errors.sort((a, b) => a - b);
  const q = (f: number) => errors.length ? Number(errors[Math.floor(f * (errors.length - 1))]!.toFixed(1)) : null;
  console.log(JSON.stringify({
    root, layout, size: N, coldMs: Math.round(cold), editMs: Math.round(edit), prims, commands,
    sceneMB: Number((JSON.stringify(scene).length / 1e6).toFixed(1)), compromises: scene.compromises?.length ?? 0,
    shareErrorPts: { median: q(0.5), p90: q(0.9), max: q(1), over5: errors.filter(e => e > 5).length, of: errors.length },
    hash: createHash('sha256').update(JSON.stringify(scene)).digest('hex').slice(0, 12),
  }));
}
