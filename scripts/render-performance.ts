/** Reproducible scene-build benchmark. Run with node --import tsx scripts/render-performance.ts --baseline origin/main */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const size = process.argv.includes('--size') ? Number(arg('--size')) : 50;
const runs = process.argv.includes('--runs') ? Number(arg('--runs')) : 3;
if (!Number.isInteger(size) || size < 10 || size > 100 || !Number.isInteger(runs) || runs < 1 || runs > 10) throw new Error('Use size 10–100 and runs 1–10.');
const root = resolve('.');
const sources = [{ label: 'current', root }];
if (process.argv.includes('--baseline')) {
  const ref = arg('--baseline');
  const sha = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
  const baseline = resolve('work', `performance-baseline-${sha}`);
  mkdirSync(baseline, { recursive: true });
  execFileSync('tar', ['-x', '-C', baseline], { input: execFileSync('git', ['archive', sha], { maxBuffer: 64 * 1024 * 1024 }) });
  try { symlinkSync(resolve('node_modules'), resolve(baseline, 'node_modules'), 'dir'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  sources.unshift({ label: sha.slice(0, 7), root: baseline });
}
const results: Array<{ revision: string; layout: string; size: number; coldMs: number; displayMs: number; editMs: number; hashes: string[] }> = [];
if (process.argv.includes('--baseline-report')) {
  const recorded = JSON.parse(readFileSync(arg('--baseline-report')!, 'utf8'));
  if (recorded.size !== size || recorded.runs !== runs) throw new Error('Recorded baseline must use the same size and run count.');
  results.push(...recorded.results.filter((r: { revision: string }) => r.revision !== 'current'));
}
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
for (const source of sources) {
  const load = (file: string) => import(pathToFileURL(resolve(source.root, file)).href);
  const { createMapState } = await load('shared/layers.ts');
  const { buildStaticScene, defaultVisibility } = await load('src/render/scene.ts');
  const { resolveStyle } = await load('src/render/styles.ts');
  for (const layout of ['continent', 'archipelago', 'lakes']) {
    const cold: number[] = [], display: number[] = [], edit: number[] = [], hashes: string[] = [];
    for (let run = 0; run < runs; run++) {
      const map = createMapState('Performance fixture', size, size);
      map.id = `performance-${layout}-${run}`;
      map.layers.base.data = Array.from({ length: size * size }, (_, i) => {
        const x = i % size, y = Math.floor(i / size);
        return layout === 'continent' ? (x < size / 2 + Math.sin(y / 3) * 3 ? 'Coastal Land' : 'Sea')
          : layout === 'archipelago' ? (x % 8 < 4 && y % 8 < 4 ? 'Coastal Land' : 'Sea')
          : (x % 8 < 4 && y % 8 < 4 ? 'Lake' : 'Coastal Land');
      });
      const options = { size: 26, visible: defaultVisibility(), labels: false, style: resolveStyle({ preset: 'parchment', overrides: { coast: 'smooth' } }) };
      const start = performance.now();
      const scene = buildStaticScene(map, options);
      cold.push(performance.now() - start);
      hashes.push(createHash('sha256').update(JSON.stringify(scene)).digest('hex'));
      const t = performance.now();
      buildStaticScene(map, { ...options, labels: true });
      display.push(performance.now() - t);
      const base = [...map.layers.base.data];
      const index = Math.floor(size / 2) * size + Math.floor(size / 2);
      base[index] = base[index] === 'Sea' ? 'Coastal Land' : 'Sea';
      const changed = { ...map, layers: { ...map.layers, base: { ...map.layers.base, data: base } } };
      const e = performance.now();
      buildStaticScene(changed, options);
      edit.push(performance.now() - e);
      console.log(`${source.label}/${layout}/${run + 1}: cold ${cold.at(-1)!.toFixed(0)} ms, display ${display.at(-1)!.toFixed(0)} ms, edit ${edit.at(-1)!.toFixed(0)} ms`);
    }
    const result = { revision: source.label, layout, size, coldMs: median(cold), displayMs: median(display), editMs: median(edit), hashes };
    results.push(result);
    console.log(JSON.stringify(result));
  }
}
mkdirSync('work', { recursive: true });
writeFileSync('work/render-performance.json', JSON.stringify({ size, runs, results }, null, 2));
if (results.some(result => result.revision !== 'current')) {
  for (const layout of ['continent', 'archipelago', 'lakes']) {
    const before = results.find(r => r.layout === layout && r.revision !== 'current')!;
    const after = results.find(r => r.layout === layout && r.revision === 'current')!;
    if (JSON.stringify(before.hashes) !== JSON.stringify(after.hashes)) throw new Error(`${layout}: scene geometry differs from baseline`);
    console.log(`${layout}: ${(before.coldMs / after.coldMs).toFixed(2)}x faster cold builds; scene hashes identical`);
  }
}
