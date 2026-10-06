/** Cold 40×40 builds with populated layers and labels; --check enforces the 1 s budget. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSync } from 'esbuild';
const argument = name => process.argv[process.argv.indexOf(name) + 1];
const ref = process.argv.includes('--baseline') ? argument('--baseline') : '8acfcc0';
const sha = execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
const root = resolve('.'), archived = resolve('work', `performance-baseline-${sha}`);
mkdirSync(archived, { recursive: true });
execFileSync('tar', ['-x', '-C', archived], { input: execFileSync('git', ['archive', sha], { maxBuffer: 64 * 1024 * 1024 }) });
try { symlinkSync(resolve('node_modules'), resolve(archived, 'node_modules'), 'dir'); } catch (e) { if (e.code !== 'EEXIST') throw e; }
const files = {};
for (const [version, source] of [['before', archived], ['after', root]]) {
  let contents = readFileSync('scripts/render-all-layers-fixture.ts', 'utf8').replace(/(['"])\.\.\/(src|shared|core)\/([^'"]+)\1/g, (_, quote, folder, file) => JSON.stringify(resolve(source, folder, file)));
  contents += `\nexport { loadLettering } from ${JSON.stringify(resolve(source, 'src/render/fontFiles.ts'))};`;
  files[version] = resolve('work', `all-layers-${version}.js`);
  buildSync({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, format: 'iife', globalName: `${version}Api`, loader: { '.woff2': 'dataurl' }, outfile: files[version] });
}
let puppeteer;
try { puppeteer = (await import('puppeteer-core')).default; } catch { puppeteer = (await import(pathToFileURL(resolve('work/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js')).href)).default; }
const browser = await puppeteer.launch({ executablePath: process.argv.includes('--chromium') ? argument('--chromium') : '/usr/bin/chromium', pipe: true, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
const runs = [];
try {
  for (let run = 0; run < 3; run++) {
    const page = await browser.newPage();
    await page.addScriptTag({ path: files.before }); await page.addScriptTag({ path: files.after });
    const result = await page.evaluate(async run => {
      const map = afterApi.fixture(`all-layer-performance${run}`), opts = afterApi.options();
      await beforeApi.loadLettering(opts.style.knobs.lettering);
      await afterApi.loadLettering(opts.style.knobs.lettering);
      await document.fonts.ready;
      const timings = {}, scenes = {}, pixels = {};
      // Alternate execution order so the optimized build is not always second.
      const order = run % 2 ? [['after', afterApi], ['before', beforeApi]] : [['before', beforeApi], ['after', afterApi]];
      for (const [version, api] of order) {
        const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 800;
        const ctx = canvas.getContext('2d'); ctx.scale(.5, .5);
        const start = performance.now();
        const scene = api.buildScene(structuredClone(map), opts), built = performance.now();
        api.drawScene(ctx, scene);
        // Force queued canvas operations to finish within the timed interval.
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        timings[version] = { buildMs: built - start, totalMs: performance.now() - start };
        scenes[version] = JSON.stringify(scene); pixels[version] = image.data;
      }
      let pixelDifferences = 0;
      for (let i = 0; i < pixels.before.length; i++) if (pixels.before[i] !== pixels.after[i]) pixelDifferences++;
      return { run, executionOrder: order.map(([version]) => version), layerCounts: { base: map.layers.base.data.length, elevation: map.layers.elevation.data.filter(v => v !== null).length, climate: map.layers.climate.data.filter(v => v !== null).length, vegetation: map.layers.vegetation.data.filter(v => v !== null).length, rivers: map.layers.rivers.data.rivers.length, cities: map.layers.cities.data.cities.length, polities: map.layers.polities.data.polities.length, population: map.layers.population.data.filter(v => v !== null).length }, timings, identicalScene: scenes.before === scenes.after, pixelDifferences };
    }, run);
    runs.push(result); console.log(JSON.stringify(result));
    await page.close();
  }
} finally { await browser.close(); }
const median = values => [...values].sort((a, b) => a - b)[1];
const report = { baseline: sha, size: 40, allLayers: true, labels: true, runs, beforeMedianMs: median(runs.map(r => r.timings.before.totalMs)), afterMedianMs: median(runs.map(r => r.timings.after.totalMs)), budgetMs: 1000, meetsBudget: runs.every(r => r.timings.after.totalMs < 1000) };
writeFileSync('work/render-all-layers-performance.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (runs.some(r => !r.identicalScene || r.pixelDifferences !== 0)) throw Error('All-layer geometry or pixels differ from baseline');
if (process.argv.includes('--check') && !report.meetsBudget) throw Error('40×40 all-layer rendering exceeds the 1000 ms budget');
