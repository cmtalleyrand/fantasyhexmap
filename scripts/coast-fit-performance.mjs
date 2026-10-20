/** Isolated construction costs for the two pinned coast failures, with caches off. */
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';
const arg = (k, fallback) => process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : fallback;
const baseline = arg('--baseline', 'work/current-main'), runs = Number(arg('--runs', '50'));
if (!Number.isInteger(runs) || runs < 3) throw Error('At least three runs required');
const output = resolve(arg('--output', 'work/coast-fit-performance'));
mkdirSync(output, { recursive: true });
const bundles = {};
for (const [name, root] of [['before', baseline], ['after', '.']]) {
  const contents = `export { cases } from ${JSON.stringify(resolve('scripts/drawing-investigation-fixtures.ts'))};
    export { buildScene } from ${JSON.stringify(resolve(root, 'src/render/scene.ts'))};
    export { beginRenderProfile, endRenderProfile } from ${JSON.stringify(resolve(root, 'src/render/profile.ts'))};`;
  bundles[`/${name}.js`] = buildSync({ stdin: { contents, resolveDir: resolve('.'), loader: 'ts' },
    bundle: true, write: false, format: 'iife', globalName: `${name}Api`, loader: { '.woff2': 'dataurl' },
  }).outputFiles[0].text;
}
const browser = await launchBrowser();
try {
  const context = await browser.newContext(); await serveBuild(context, '.', bundles);
  const page = await context.newPage(); await page.goto('http://render.test/blank');
  for (const name of ['before', 'after']) await page.addScriptTag({ url: `http://render.test/${name}.js` });
  const records = await page.evaluate(runs => {
    const records = [];
    for (const name of ['coast-fit-parchment', 'coast-fit-classic']) {
      const { map, opts } = afterApi.cases().find(c => c.name === name);
      const options = { ...opts, cache: 'off', labels: false, riverNames: false, seaNames: false,
        visible: Object.fromEntries(Object.keys(opts.visible).map(k => [k, k === 'base'])) };
      for (let run = 0; run < runs; run++) for (const [version, api] of (run % 2
        ? [['after', afterApi], ['before', beforeApi]] : [['before', beforeApi], ['after', afterApi]])) {
        api.beginRenderProfile(); const start = performance.now(); api.buildScene(map, options);
        const ms = performance.now() - start, profile = api.endRenderProfile();
        if (!(profile.counters['coast.traces'] > 0)) throw Error('Coast benchmark did not construct a coastline');
        records.push({ name, version, run, ms, profile });
      }
    }
    return records;
  }, runs);
  const summary = [];
  for (const name of ['coast-fit-parchment', 'coast-fit-classic']) for (const version of ['before', 'after']) {
    const values = records.filter(r => r.name === name && r.version === version && r.run > 1).map(r => r.ms).sort((a, b) => a - b);
    summary.push({ name, version, n: values.length, median: values[Math.floor(values.length / 2)], p95: values[Math.ceil(values.length * .95) - 1] });
  }
  const result = { browser: browser.version(), scope: 'Two pinned 5x4 maps, geography only, cache off, alternating order; first two runs omitted. Construction only, no painting or transfer.', summary, records };
  writeFileSync(resolve(output, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await context.close();
} finally { await browser.close(); }
