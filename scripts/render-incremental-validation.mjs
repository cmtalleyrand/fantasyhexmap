/** Replay edits against a cache-bypassing reference in the same browser/compositor. */
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const output = resolve(arg('--output', 'work/render-incremental'));
mkdirSync(output, { recursive: true });
const bundle = buildSync({ entryPoints: ['scripts/render-incremental-fixture.ts'], bundle: true, write: false,
  format: 'iife', globalName: 'api', loader: { '.woff2': 'dataurl' } }).outputFiles[0].text;
const referenceBundle = buildSync({ entryPoints: [resolve(arg('--baseline', '.'), 'scripts/render-incremental-fixture.ts')], bundle: true, write: false,
  format: 'iife', globalName: 'referenceApi', loader: { '.woff2': 'dataurl' } }).outputFiles[0].text;
const browser = await launchBrowser(), records = [];
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await serveBuild(context, 'dist', { '/api.js': bundle, '/reference.js': referenceBundle });
  const page = await context.newPage();
  await page.goto('http://render.test/blank'); await page.addScriptTag({ url: 'http://render.test/api.js' });
  await page.addScriptTag({ url: 'http://render.test/reference.js' });
  const cases = await page.evaluate(() => api.editCases().map(c => c.name));
  for (let index = 0; index < cases.length; index++) {
    if (arg('--only', '') && !cases[index].startsWith(arg('--only', ''))) continue;
    const record = await page.evaluate(async index => {
      const { name, map, options } = api.editCases()[index];
      const beforeFonts = api.measureEpoch;
      await api.loadLettering(options.style.knobs.lettering); await document.fonts.ready;
      if (name === 'placement/font' && api.measureEpoch <= beforeFonts) throw Error('Newly loaded fonts did not invalidate measurements');
      await referenceApi.loadLettering(options.style.knobs.lettering); await document.fonts.ready;
      const epoch = api.measureEpoch;
      await api.loadLettering(options.style.knobs.lettering);
      if (api.measureEpoch !== epoch) throw Error('Already loaded fonts invalidated placement');
      // Also exercise readiness invalidation independently of changing the lettering policy.
      if (name === 'placement/river-course') { api.invalidateTextMeasures(); referenceApi.invalidateTextMeasures(); }
      api.beginRenderProfile(); const start = performance.now();
      const cached = api.buildStaticScene(structuredClone(map), options), cachedMs = performance.now() - start;
      const profile = api.endRenderProfile();
      if (name === 'placement/opacity' || name === 'placement/colour') {
        if ((profile.counters['placement.searches'] ?? 0) || (profile.counters['symbols.searches'] ?? 0)) throw Error('Eligible browser rebuild repeated placement searches');
      }
      const fullStart = performance.now(), full = referenceApi.buildStaticScene(structuredClone(map), { ...options, cache: 'off' });
      const fullMs = performance.now() - fullStart;
      // Each production scene is cloned once on its way to the paint worker.
      const cachedWorker = structuredClone(cached), fullWorker = structuredClone(full);
      // Export inputs need an equal Path2D history too. Chromium can rasterize a
      // previously stroked Path2D a channel level differently from a fresh one,
      // even for the same scene object (see docs/drawing-status.md). Cloning both
      // inputs preserves their values and aliases, but prevents earlier cases'
      // painter memo entries from favouring the incremental side. Pixel and scene
      // comparisons remain exact; production painting is unchanged.
      const cachedExport = structuredClone(cached), fullExport = structuredClone(full);
      const coastPrims = prims => prims.flatMap(p => p.kind === 'group' ? coastPrims(p.prims)
        : p.kind === 'path' && p.stroke === options.style.palette.coast ? [p] : []);
      const coast = coastPrims(full.prims), focusHex = Object.keys(map.hexShapes ?? {})[0];
      const selected = focusHex === undefined ? null : Number(focusHex);
      const focus = selected === null ? coast.find(p => p.d.length > 10)?.d.find(c => c[0] === 'L' || c[0] === 'M')?.slice(1)
        : [options.size * Math.sqrt(3) * (selected % map.cols + .5 * (Math.floor(selected / map.cols) & 1)) + options.size * Math.sqrt(3) / 2,
          options.size * (1.5 * Math.floor(selected / map.cols) + 1)];
      const images = [];
      for (const dpr of [1, 2]) for (const zoom of ['fit', 4]) for (const mode of ['full', 'coast']) for (const compositor of ['worker', 'export']) {
        const pixels = [], width = 1000 * dpr, height = 800 * dpr;
        const canvases = [];
        for (const [original, painter] of [[compositor === 'worker' ? cachedWorker : cachedExport, api],
          [compositor === 'worker' ? fullWorker : fullExport, referenceApi]]) {
          const scene = mode === 'full' ? original : { ...original, background: '#fff', prims: coastPrims(original.prims) };
          const canvas = compositor === 'worker' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
          const ctx = canvas.getContext('2d'), scale = zoom === 'fit' ? Math.min(1000 / scene.width, 800 / scene.height) : zoom;
          ctx.scale(dpr, dpr); ctx.fillStyle = scene.background; ctx.fillRect(0, 0, 1000, 800);
          if (zoom !== 'fit' && focus) ctx.translate(500 - focus[0] * scale, 400 - focus[1] * scale);
          ctx.scale(scale, scale); painter.drawScene(ctx, scene, undefined, compositor === 'worker');
          pixels.push(ctx.getImageData(0, 0, width, height).data);
          canvases.push(canvas);
        }
        let changedPixels = 0, maxChannelDelta = 0, coastInkPixels = 0;
        const differences = [];
        for (let i = 0; i < pixels[0].length; i += 4) {
          let hit = false;
          for (let c = 0; c < 4; c++) { const delta = Math.abs(pixels[0][i+c] - pixels[1][i+c]); if (delta) hit = true; maxChannelDelta = Math.max(maxChannelDelta, delta); }
          if (hit) { changedPixels++; if (differences.length < 10) differences.push({ x: (i / 4) % width, y: Math.floor(i / 4 / width), cached: [...pixels[0].slice(i,i+4)], full: [...pixels[1].slice(i,i+4)] }); }
          if (mode === 'coast' && (pixels[1][i] !== 255 || pixels[1][i+1] !== 255 || pixels[1][i+2] !== 255)) coastInkPixels++;
        }
        const artifacts = {};
        if (changedPixels || (dpr === 1 && zoom === 'fit' && mode === 'full' && compositor === 'export')) {
          const diff = new OffscreenCanvas(width, height), dc = diff.getContext('2d'), dd = dc.createImageData(width, height);
          for (let i = 0; i < pixels[0].length; i += 4) if ([0,1,2,3].some(c => pixels[0][i+c] !== pixels[1][i+c])) { dd.data[i] = 255; dd.data[i+3] = 255; }
          dc.putImageData(dd, 0, 0);
          for (const [label, canvas] of [['cached', canvases[0]], ['reference', canvases[1]], ['diff', diff]]) {
            const blob = canvas instanceof OffscreenCanvas ? await canvas.convertToBlob() : await new Promise(r => canvas.toBlob(r));
            const bytes = new Uint8Array(await blob.arrayBuffer()); let binary = '';
            for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            artifacts[label] = btoa(binary);
          }
        }
        images.push({ dpr, zoom, mode, compositor, changedPixels, maxChannelDelta, coastInkPixels, differences, artifacts });
      }
      return { name, cachedMs, fullMs, profile, identicalScene: JSON.stringify(cached) === JSON.stringify(full), images };
    }, index);
    for (const image of record.images) {
      for (const [version, png] of Object.entries(image.artifacts)) writeFileSync(resolve(output, `${record.name.replaceAll('/', '-')}-${image.mode}-${image.compositor}-${image.zoom}-dpr${image.dpr}-${version}.png`), Buffer.from(png, 'base64'));
      delete image.artifacts;
    }
    records.push(record);
    console.log(JSON.stringify({ name: record.name, identicalScene: record.identicalScene, cachedMs: record.cachedMs,
      changedPixels: Math.max(...record.images.map(i => i.changedPixels)) }));
  }
  await context.close();
} finally { await browser.close(); }
writeFileSync(resolve(output, 'results.json'), JSON.stringify({ browser: browser.version(), baseline: resolve(arg('--baseline', '.')), records }, null, 2));
if (records.some(r => !r.identicalScene || r.images.some(i => i.changedPixels || (i.mode === 'coast' && i.zoom === 'fit' && !i.coastInkPixels)))) throw Error('Incremental geometry or browser pixels changed, or empty coast mask');
