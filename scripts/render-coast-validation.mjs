/** Exact baseline/candidate scenes and browser pixels, including maximum-zoom coast crops. */
import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, cpSync, symlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const referenceRoot = arg('--reference-root', '');
const sha = referenceRoot || execFileSync('git', ['rev-parse', `${arg('--baseline', 'HEAD')}^{commit}`], { encoding: 'utf8' }).trim();
const output = resolve(arg('--output', 'work/render-coast-validation')), archived = referenceRoot ? resolve(referenceRoot) : resolve(output, 'baseline');
mkdirSync(output, { recursive: true });
if (!referenceRoot) {
mkdirSync(archived, { recursive: true });
execFileSync('tar', ['-x', '-C', archived], { input: execFileSync('git', ['archive', sha], { maxBuffer: 64 * 1024 * 1024 }) });
if (!existsSync(resolve(archived, 'node_modules'))) symlinkSync(resolve('node_modules'), resolve(archived, 'node_modules'), 'dir');
// Both renderers receive exactly the same current, frozen test inputs and diagnostic API.
for (const file of ['scripts/render-profile-fixture.ts', 'scripts/render-profile-input.ts', 'scripts/coast-gallery-fixtures.ts', 'scripts/coastFeatureFixture.ts', 'test/fixtures/populated-40.json', 'src/render/profile.ts']) {
  mkdirSync(resolve(archived, file, '..'), { recursive: true }); cpSync(file, resolve(archived, file));
}
}
const bundles = {};
for (const [version, root] of [['before', archived], ['after', resolve('.')]]) {
  bundles[version] = buildSync({ entryPoints: [resolve(root, 'scripts/render-profile-fixture.ts')], bundle: true, write: false, format: 'iife', globalName: `${version}Api`, loader: { '.woff2': 'dataurl' } }).outputFiles[0].text;
}
const browser = await launchBrowser(), records = [];
try {
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await serveBuild(context, 'dist', { '/before.js': bundles.before, '/after.js': bundles.after });
  const page = await context.newPage();
  await page.goto('http://render.test/blank');
  await page.addScriptTag({ url: 'http://render.test/before.js' });
  await page.addScriptTag({ url: 'http://render.test/after.js' });
  const names = await page.evaluate(() => ['populated', 'feature', ...afterApi.coastGallery().map(f => f.name)]);
  const only = arg('--only', '').split(',').filter(Boolean);
  if (only.some(name => !names.includes(name))) throw Error('Unknown fixture in --only');
  for (const name of names.filter(name => !only.length || only.includes(name))) for (const edited of [false, true]) {
    const result = await page.evaluate(async ({ name, edited }) => {
      const map = name === 'populated' || name === 'feature' ? afterApi.fixture(name) : afterApi.coastGallery().find(f => f.name === name).map;
      if (edited) {
        const base = map.layers.base.data;
        const hex = base.findIndex((v, i) => (v === 'Land' || v === 'Coastal Land') && (base[i - 1] === 'Sea' || base[i + 1] === 'Sea'));
        if (hex < 0) throw Error(`No exposed hex in ${name}`);
        map.layers.base = { ...map.layers.base, data: [...base] };
        map.layers.base.data[hex] = 'Sea';
      }
      const opts = afterApi.options();
      if (name !== 'populated') { opts.labels = false; opts.visible = { base: true }; opts.riverNames = opts.rangeNames = opts.seaNames = opts.landNames = false; }
      await beforeApi.loadLettering(opts.style.knobs.lettering); await afterApi.loadLettering(opts.style.knobs.lettering); await document.fonts.ready;
      const scenes = {}, timings = {};
      const order = name.length % 2 ? [['after', afterApi], ['before', beforeApi]] : [['before', beforeApi], ['after', afterApi]];
      for (const [key, api] of order) {
        const start = performance.now(); scenes[key] = api.buildStaticScene(structuredClone(map), opts); timings[key] = performance.now() - start;
      }
      const identicalScene = JSON.stringify(scenes.before) === JSON.stringify(scenes.after);
      const coastPrims = prims => prims.flatMap(p => p.kind === 'group' ? coastPrims(p.prims)
        : p.kind === 'path' && p.stroke === opts.style.palette.coast ? [p] : []);
      const coast = coastPrims(scenes.after.prims);
      const passage = map.layers.base.data.findIndex(v => v === 'Strait' || v === 'Isthmus');
      const shapeHex = Object.keys(map.hexShapes ?? {})[0];
      const feature = passage >= 0 ? passage : shapeHex === undefined ? -1 : Number(shapeHex);
      const focus = feature >= 0
        ? ['M', opts.size * Math.sqrt(3) * (feature % map.cols + .5 * (Math.floor(feature / map.cols) & 1)) + opts.size * Math.sqrt(3) / 2, opts.size * (1.5 * Math.floor(feature / map.cols) + 1)]
        : coast.find(p => p.d.length > 10)?.d.find(c => c[0] === 'L' || c[0] === 'M');
      const images = [];
      for (const dpr of [1, 2]) for (const zoom of ['fit', 1, 4]) for (const mode of ['full', 'coast']) for (const compositor of ['worker', 'export']) {
        const outputs = {}, pixels = {}, width = 1000 * dpr, height = 800 * dpr;
        for (const [key, api] of [['before', beforeApi], ['after', afterApi]]) {
          const scene = mode === 'full' ? scenes[key] : { ...scenes[key], background: '#fff', prims: coastPrims(scenes[key].prims) };
          const canvas = compositor === 'worker' ? new OffscreenCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height }), ctx = canvas.getContext('2d');
          const scale = zoom === 'fit' ? Math.min(1000 / scene.width, 800 / scene.height) : zoom;
          ctx.scale(dpr, dpr); ctx.fillStyle = scene.background; ctx.fillRect(0, 0, 1000, 800);
          if (zoom !== 'fit' && focus) ctx.translate(500 - focus[1] * scale, 400 - focus[2] * scale);
          ctx.scale(scale, scale); api.drawScene(ctx, scene, undefined, compositor === 'worker');
          pixels[key] = ctx.getImageData(0, 0, width, height).data;
          const bytes = new Uint8Array(await (await (compositor === 'worker' ? canvas.convertToBlob({ type: 'image/png' }) : new Promise(r => canvas.toBlob(r, 'image/png')))).arrayBuffer());
          let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          outputs[key] = btoa(binary);
        }
        let changed = 0, maxChannelDelta = 0, coastInkPixels = 0;
        const diff = new OffscreenCanvas(width, height), dc = diff.getContext('2d'), data = dc.createImageData(width, height);
        for (let i = 0; i < pixels.before.length; i += 4) {
          if (mode === 'coast' && (pixels.before[i] !== 255 || pixels.before[i+1] !== 255 || pixels.before[i+2] !== 255)) coastInkPixels++;
          let hit = false;
          for (let c = 0; c < 4; c++) { const delta = Math.abs(pixels.before[i+c] - pixels.after[i+c]); if (delta) hit = true; maxChannelDelta = Math.max(maxChannelDelta, delta); }
          if (hit) { changed++; data.data[i] = 255; data.data[i+3] = 255; }
        }
        dc.putImageData(data, 0, 0);
        const diffBytes = new Uint8Array(await (await diff.convertToBlob()).arrayBuffer()); let binary = '';
        for (let i = 0; i < diffBytes.length; i += 8192) binary += String.fromCharCode(...diffBytes.subarray(i,i+8192));
        images.push({ mode, compositor, zoom, dpr, changedPixels: changed, maxChannelDelta, coastInkPixels, before: outputs.before, after: outputs.after, diff: btoa(binary) });
      }
      return { name, edited, focusHex: feature, identicalScene, timings, compromises: scenes.after.compromises ?? [], images };
    }, { name, edited });
    for (const image of result.images) {
      const file = `${name}${edited ? '-edited' : ''}-${image.mode}-${image.compositor}-${image.zoom}-dpr${image.dpr}`;
      for (const version of ['before', 'after', 'diff']) { writeFileSync(resolve(output, `${file}-${version}.png`), Buffer.from(image[version], 'base64')); delete image[version]; }
    }
    records.push(result);
    console.log(JSON.stringify({ name, edited, identicalScene: result.identicalScene, maxChangedPixels: Math.max(...result.images.map(i => i.changedPixels)) }));
  }
  await context.close();
} finally { await browser.close(); }
const report = { baseline: sha, fixtureSha256: createHash('sha256').update(readFileSync('test/fixtures/populated-40.json')).digest('hex'), records };
writeFileSync(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
if (records.some(r => !r.identicalScene || r.images.some(i => i.changedPixels || (i.mode === 'coast' && i.coastInkPixels === 0)))) throw Error('Coast geometry or same-compositor pixels changed');
