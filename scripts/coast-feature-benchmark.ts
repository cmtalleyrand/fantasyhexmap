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
const { featureFixture } = await import('./coastFeatureFixture.ts');
const fixture = () => featureFixture({ createMapState, neighbourOf, inBounds, hexIndex }, N, layout);

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
  const editedScene = buildStaticScene({ ...map, layers: { ...map.layers, base: { ...map.layers.base, data: base } } }, options);
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
    editHash: createHash('sha256').update(JSON.stringify(editedScene)).digest('hex').slice(0, 12),
  }));
}
