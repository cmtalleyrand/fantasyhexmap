/**
 * How much of a frame's paint is rasterizing pixels, which a GPU-backed canvas takes off the
 * worker, and how much is issuing the drawing commands, which it does not (DECISIONS §98).
 *
 *   node scripts/render-paint-split.mjs [--runs 7] [--span 50]
 *
 * Builds the all-layer interaction map's scene in the page, then paints it as the paint worker
 * does, at a 1400×900 view, several times each:
 *   - to a real OffscreenCanvas (headless Chromium rasterizes in software);
 *   - to a stub context that accepts every call and draws nothing, with a 1×1 canvas so the
 *     composite layers it makes are 1×1 too: the cost of walking the scene, building paths and
 *     issuing commands.
 * The difference bounds what GPU rasterization could save. A GPU canvas still records every
 * command, so the stub's time remains.
 */
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const runs = Number(arg('--runs', '7')), span = Number(arg('--span', '50'));
const page = (await build({ bundle: true, write: false, format: 'iife', globalName: 'api', loader: { '.woff2': 'dataurl' }, logLevel: 'silent',
  stdin: { contents: `export { buildStaticScene } from ${JSON.stringify(resolve('src/render/scene.ts'))};
export { drawScene } from ${JSON.stringify(resolve('src/render/canvas.ts'))};
export { loadLettering } from ${JSON.stringify(resolve('src/render/fontFiles.ts'))};
export { fixture, options } from ${JSON.stringify(resolve('scripts/render-all-layers-fixture.ts'))};`, resolveDir: resolve('.'), loader: 'ts' } })).outputFiles[0].text;

const browser = await launchBrowser();
try {
  const context = await browser.newContext();
  await serveBuild(context, '.', { '/page.js': page });
  const tab = await context.newPage();
  await tab.goto('http://render.test/blank');
  await tab.addScriptTag({ url: '/page.js' });
  const rows = await tab.evaluate(async ({ runs, span }) => {
    const options = api.options();
    await api.loadLettering(options.style?.knobs.lettering ?? 'classic');
    const scene = api.buildStaticScene(api.fixture('interaction-study', span), options);
    const size = { width: 1400, height: 900 };
    const stub = () => {
      const target = { canvas: { width: 1, height: 1 } };
      const call = () => new Proxy(() => {}, { get: () => call(), apply: () => call() });
      return new Proxy(target, {
        get: (t, key) => key in t ? t[key] : key === 'getTransform' ? () => new DOMMatrix() : key === 'measureText' ? () => ({ width: 10 }) : () => call(),
        set: (t, key, value) => { t[key] = value; return true; },
      });
    };
    const paint = (ctx, scale, dpr) => {
      const view = { x: (size.width - scene.width * scale) / 2, y: (size.height - scene.height * scale) / 2, scale };
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size.width, size.height);
      ctx.translate(view.x, view.y);
      ctx.scale(view.scale, view.scale);
      ctx.fillStyle = scene.background;
      ctx.fillRect(0, 0, scene.width, scene.height);
      const margin = 2 / (dpr * view.scale);
      api.drawScene(ctx, scene, { left: -view.x / view.scale - margin, top: -view.y / view.scale - margin,
        right: (size.width - view.x) / view.scale + margin, bottom: (size.height - view.y) / view.scale + margin }, true);
    };
    const median = list => [...list].sort((a, b) => a - b)[list.length >> 1];
    const fit = Math.min(size.width / scene.width, size.height / scene.height);
    const out = [];
    for (const [label, scale] of [['fit', fit], ['zoom 1', 1], ['zoom 2', 2]]) for (const dpr of [1, 2]) {
      const real = [], commands = [];
      for (let k = 0; k <= runs; k++) {
        const canvas = new OffscreenCanvas(size.width * dpr, size.height * dpr);
        const ctx = canvas.getContext('2d', { alpha: false });
        let start = performance.now();
        paint(ctx, scale, dpr);
        canvas.transferToImageBitmap().close();
        const realMs = performance.now() - start;
        start = performance.now();
        paint(stub(), scale, dpr);
        const stubMs = performance.now() - start;
        if (k > 0) { real.push(realMs); commands.push(stubMs); } // the first of each is a warm-up
      }
      out.push({ view: label, dpr, paintMs: median(real), commandsMs: median(commands) });
    }
    return out;
  }, { runs, span });
  console.log('view     dpr  paint  commands  raster (ms, median of ' + runs + ')');
  for (const r of rows) console.log(`${r.view.padEnd(8)} ${String(r.dpr).padStart(3)} ${r.paintMs.toFixed(0).padStart(6)} ${r.commandsMs.toFixed(0).padStart(9)} ${(r.paintMs - r.commandsMs).toFixed(0).padStart(7)}`);
} finally {
  await browser.close();
}
