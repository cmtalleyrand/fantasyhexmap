/** Two pinned cases isolating Chromium Path2D history from scene construction. */
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';
const arg = (k, fallback) => process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : fallback;
const output = resolve(arg('--output', 'work/canvas-replay-history'));
mkdirSync(output, { recursive: true });
const bundles = {};
for (const name of ['api', 'referenceApi']) bundles[`/${name}.js`] = buildSync({
  entryPoints: ['scripts/render-incremental-fixture.ts'], bundle: true, write: false,
  format: 'iife', globalName: name, loader: { '.woff2': 'dataurl' },
}).outputFiles[0].text;
const browser = await launchBrowser();
try {
  const context = await browser.newContext();
  await serveBuild(context, '.', bundles);
  const page = await context.newPage(); await page.goto('http://render.test/blank');
  for (const name of ['api', 'referenceApi']) await page.addScriptTag({ url: `http://render.test/${name}.js` });
  const result = await page.evaluate(async () => {
    const cases = api.editCases().slice(0, 2);
    for (const painter of [api, referenceApi]) await painter.loadLettering(cases[0].options.style.knobs.lettering);
    await document.fonts.ready;
    const render = (scene, painter, dpr = 1, zoom = 'fit', coast = false, worker = false) => {
      const coastPrims = ps => ps.flatMap(p => p.kind === 'group' ? coastPrims(p.prims)
        : p.kind === 'path' && p.stroke === cases[0].options.style.palette.coast ? [p] : []);
      if (coast) scene = { ...scene, background: '#fff', prims: coastPrims(scene.prims) };
      const canvas = worker ? new OffscreenCanvas(1000 * dpr, 800 * dpr)
        : Object.assign(document.createElement('canvas'), { width: 1000 * dpr, height: 800 * dpr });
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr); ctx.fillStyle = scene.background; ctx.fillRect(0, 0, 1000, 800);
      const scale = zoom === 'fit' ? Math.min(1000 / scene.width, 800 / scene.height) : zoom;
      ctx.scale(scale, scale); painter.drawScene(ctx, scene, undefined, worker);
      return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    };
    const delta = (a, b) => {
      let changedPixels = 0, maxChannelDelta = 0;
      for (let k = 0; k < a.length; k += 4) {
        let changed = false;
        for (let c = 0; c < 4; c++) { const d = Math.abs(a[k+c] - b[k+c]); changed ||= !!d; maxChannelDelta = Math.max(maxChannelDelta, d); }
        if (changed) changedPixels++;
      }
      return { changedPixels, maxChannelDelta };
    };
    let cached, full;
    for (const c of cases) {
      cached = api.buildStaticScene(structuredClone(c.map), c.options);
      full = referenceApi.buildStaticScene(structuredClone(c.map), { ...c.options, cache: 'off' });
      if (c.name === 'components/shore') break;
      const workerScenes = [structuredClone(cached), structuredClone(full)];
      for (const dpr of [1, 2]) for (const zoom of ['fit', 4]) for (const coast of [false, true]) for (const worker of [true, false]) {
        for (const [i, painter] of [api, referenceApi].entries()) render(worker ? workerScenes[i] : [cached, full][i], painter, dpr, zoom, coast, worker);
      }
    }
    const original = delta(render(cached, api), render(full, referenceApi));
    const freshClones = delta(render(structuredClone(cached), api), render(structuredClone(full), referenceApi));
    const sameObject = delta(render(cached, api), render(cached, referenceApi));
    return { identicalScene: JSON.stringify(cached) === JSON.stringify(full), original, freshClones, sameObject };
  });
  writeFileSync(resolve(output, 'results.json'), JSON.stringify({ browser: browser.version(), ...result }, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.identicalScene || result.freshClones.changedPixels) throw Error('Controlled scene/pixel replay differs');
  await context.close();
} finally { await browser.close(); }
