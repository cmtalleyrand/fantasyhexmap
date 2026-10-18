/** Placement phases and component construction, measured in Chromium against the saved pre-cache source. */
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const reference = arg('--reference', 'work/part34-baseline'), output = resolve(arg('--output', 'work/render-cache-performance'));
mkdirSync(output, { recursive: true });
const bundles = {};
for (const [name, file] of [['before', resolve(reference, 'scripts/render-profile-fixture.ts')], ['after', resolve('scripts/render-incremental-fixture.ts')]])
  bundles[`/${name}.js`] = buildSync({ entryPoints: [file], bundle: true, write: false, format: 'iife', globalName: `${name}Api`, loader: { '.woff2': 'dataurl' } }).outputFiles[0].text;
const browser = await launchBrowser();
let records;
try {
  const context = await browser.newContext(); await serveBuild(context, 'dist', bundles);
  const page = await context.newPage(); await page.goto('http://render.test/blank');
  for (const name of ['before', 'after']) await page.addScriptTag({ url: `http://render.test/${name}.js` });
  records = await page.evaluate(async () => {
    const out = [], options = afterApi.options();
    await beforeApi.loadLettering(options.style.knobs.lettering); await afterApi.loadLettering(options.style.knobs.lettering); await document.fonts.ready;
    for (const scenario of ['populated-opacity', 'independent-shore', 'independent-unique-shore']) {
      const initial = scenario === 'populated-opacity' ? afterApi.fixture('populated') : afterApi.componentFixture();
      const maps = { before: structuredClone(initial), after: structuredClone(initial) };
      for (const [name, api] of [['before', beforeApi], ['after', afterApi]]) api.buildStaticScene(maps[name], options);
      for (let run = 0; run < 20; run++) {
        const order = run % 2 ? [['after', afterApi], ['before', beforeApi]] : [['before', beforeApi], ['after', afterApi]];
        for (const [name, api] of order) {
          const map = maps[name], opts = { ...options, polityOpacity: run % 2 ? .55 : .35 };
          // Match build.worker.ts: every request ensures the fonts are ready.
          await api.loadLettering(options.style.knobs.lettering);
          if (scenario.startsWith('independent-')) {
            map.layers.base = { ...map.layers.base, data: [...map.layers.base.data] };
            const i = scenario === 'independent-shore' ? 5 * 40 + 3 : (4 + Math.floor(run / 5)) * 40 + 2 + run % 5;
            map.layers.base.data[i] = scenario === 'independent-shore' ? (run % 2 ? 'Coastal Land' : 'Sea')
              : map.layers.base.data[i] === 'Sea' ? 'Coastal Land' : 'Sea';
          }
          api.beginRenderProfile(); const start = performance.now(); api.buildStaticScene(map, opts);
          out.push({ scenario, version: name, run, ms: performance.now() - start, profile: api.endRenderProfile() });
        }
      }
    }
    return out;
  });
  await context.close();
} finally { await browser.close(); }
writeFileSync(resolve(output, 'results.json'), JSON.stringify({ browser: browser.version(), reference, records }, null, 2));
for (const scenario of [...new Set(records.map(r => r.scenario))]) for (const version of ['before', 'after']) {
  const a = records.filter(r => r.scenario === scenario && r.version === version).map(r => r.ms).sort((a,b)=>a-b);
  console.log(JSON.stringify({ scenario, version, median: a[10], p95: a[18], max: a[19] }));
}
