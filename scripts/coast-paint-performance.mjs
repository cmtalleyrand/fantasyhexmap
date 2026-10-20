/** Paired full-scene construction and worker-style Canvas painting benchmark. */
import { buildSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';
const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const output = resolve(arg('--output', 'work/coast-paint-performance'));
const baseline = execFileSync('git', ['rev-parse', `${arg('--baseline', 'HEAD')}^{commit}`], { encoding: 'utf8' }).trim();
const archived = resolve(output, 'baseline'); mkdirSync(archived, { recursive: true });
execFileSync('tar', ['-x', '-C', archived], { input: execFileSync('git', ['archive', baseline], { maxBuffer: 64 * 1024 * 1024 }) });
try { symlinkSync(resolve('node_modules'), resolve(archived, 'node_modules'), 'dir'); } catch (e) { if (e.code !== 'EEXIST') throw e; }
const bundles = {};
for (const [version, root] of [['before', archived], ['after', resolve('.')]]) bundles[`/${version}.js`] = buildSync({ stdin: { contents: `
export { buildStaticScene } from ${JSON.stringify(resolve(root, 'src/render/scene.ts'))};
export { drawScene } from ${JSON.stringify(resolve(root, 'src/render/canvas.ts'))};
export { fixture, options } from './scripts/render-profile-input.ts';
`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: `${version}Api`, loader: { '.woff2': 'dataurl' } }).outputFiles[0].text;
const browser = await launchBrowser(), records = [];
try {
  const context = await browser.newContext(); await serveBuild(context, '.', bundles);
  const page = await context.newPage(); await page.goto('http://render.test/blank');
  for (const version of ['before', 'after']) await page.addScriptTag({ url: `http://render.test/${version}.js` });
  for (const kind of ['populated', 'feature']) {
    const result = await page.evaluate(({ kind }) => {
      const apis = { before: beforeApi, after: afterApi }, samples = [], scenes = {}, maps = {}, opts = afterApi.options();
      const measure = (run, version, phase, action) => { const start = performance.now(); const value = action(); samples.push({ run, version, phase, ms: performance.now() - start }); return value; };
      for (let run = 0; run < 3; run++) for (const version of run % 2 ? ['after', 'before'] : ['before', 'after']) {
        const map = afterApi.fixture(kind); map.id += `-paint-perf-${run}`; maps[version] = map;
        scenes[version] = measure(run, version, 'cold', () => apis[version].buildStaticScene(map, opts));
      }
      for (let run = 0; run < 9; run++) for (const version of run % 2 ? ['after', 'before'] : ['before', 'after']) {
        measure(run, version, 'warm', () => apis[version].buildStaticScene(maps[version], { ...opts, polityOpacity: run % 2 ? .55 : .35 }));
      }
      for (const [phase, scale] of [['paint-1x', 1], ['paint-4x-dpr2', 8]]) {
        const c = new OffscreenCanvas(1200, 900), ctx = c.getContext('2d', { willReadFrequently: true });
        // Read back a pixel to include deferred rasterization. Both versions
        // use the same canvas, viewport, pan, zoom, and dense-clip compositor.
        for (let run = -1; run < 9; run++) for (const version of run % 2 ? ['after', 'before'] : ['before', 'after']) {
          const s = scenes[version], left = Math.max(0, s.width * .45 - 600 / scale), top = Math.max(0, s.height * .45 - 450 / scale);
          const viewport = { left, top, right: left + 1200 / scale, bottom: top + 900 / scale };
          const start = performance.now(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = s.background; ctx.fillRect(0, 0, 1200, 900);
          ctx.setTransform(scale, 0, 0, scale, -left * scale, -top * scale); apis[version].drawScene(ctx, s, viewport, true); ctx.getImageData(0, 0, 1, 1);
          if (run >= 0) samples.push({ run, version, phase, ms: performance.now() - start });
        }
      }
      // A real base edit invalidates the coast and its paint cache.
      for (let run = 0; run < 3; run++) for (const version of run % 2 ? ['after', 'before'] : ['before', 'after']) {
        const map = structuredClone(maps[version]);
        const coasts = map.layers.base.data.flatMap((b, i) => b === 'Coastal Land' ? [i] : []);
        const i = coasts[Math.min(run, coasts.length - 1)]; map.layers.base.data[i] = 'Sea';
        measure(run, version, 'edit', () => apis[version].buildStaticScene(map, opts));
      }
      return { kind, samples };
    }, { kind });
    records.push(result); console.log(`Finished ${kind}`);
    writeFileSync(resolve(output, 'results.json'), JSON.stringify({ baseline, browser: browser.version(), records }, null, 2) + '\n');
  }
  await context.close();
} finally { await browser.close(); }
const median = a => { const s = [...a].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const summary = records.flatMap(({ kind, samples }) => [...new Set(samples.map(s => s.phase))].map(phase => {
  const before = median(samples.filter(s => s.phase === phase && s.version === 'before').map(s => s.ms));
  const after = median(samples.filter(s => s.phase === phase && s.version === 'after').map(s => s.ms));
  const pairs = samples.filter(s => s.phase === phase && s.version === 'before').map(b => {
    const a = samples.find(s => s.phase === phase && s.version === 'after' && s.run === b.run);
    return { before: b.ms, after: a.ms, ratio: a.ms / b.ms, delta: a.ms - b.ms };
  });
  return { kind, phase, before, after, ratio: after / before, pairedMedianRatio: median(pairs.map(p => p.ratio)), pairedMedianDelta: median(pairs.map(p => p.delta)), pairs };
}));
writeFileSync(resolve(output, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'); console.log(JSON.stringify(summary, null, 2));
if (process.argv.includes('--check') && summary.some(r => r.pairedMedianRatio > 1.05 && r.pairedMedianDelta > 1)) throw Error('Coast paint performance regression');
