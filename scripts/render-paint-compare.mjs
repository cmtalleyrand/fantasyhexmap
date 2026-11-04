/**
 * Paired production-worker paint review (T2 B2), using one common ScenePainter
 * harness and the same ownership edits. Excludes React scheduling.
 * npm run perf:paint-compare -- --base /path/to/base --root . [--pairs 30]
 * Images at fit, 1x and 2x are saved beside the samples; closeups focus a realm edge.
 * --thin applies the current paint-only alternative to a source tree predating B2.
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { statistics } from './perf-compare.ts';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';
import { bandThinningTrial } from './render-band-thinning-trial.mjs';
import { visibleChange } from './visible-change.mjs';

const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const base = resolve(arg('--base', '.')), root = resolve(arg('--root', '.'));
const pairs = Number(arg('--pairs', '30')), span = Number(arg('--span', '50'));
if (!Number.isSafeInteger(pairs) || pairs < 1 || !Number.isSafeInteger(span) || span < 12) throw Error('Invalid pair count or span');
const zoom = arg('--zoom', 'fit');
if (!['fit', '1', '2'].includes(zoom)) throw Error('--zoom must be fit, 1 or 2');
const trial = process.argv.includes('--thin');
const output = resolve(arg('--output', `work/paint-compare/${new Date().toISOString().replace(/[:.]/g, '-')}`));
mkdirSync(output, { recursive: true });
const bundle = async (source, entry, plugins = []) => (await build({ entryPoints: [resolve(source, entry)], bundle: true,
  write: false, format: 'iife', globalName: 'api', loader: { '.woff2': 'dataurl' }, plugins })).outputFiles[0].text;
const assets = {
  '/base-worker.js': await bundle(base, 'src/render/paint.worker.ts'),
  '/new-worker.js': await bundle(root, 'src/render/paint.worker.ts', trial ? [bandThinningTrial()] : []),
  '/page.js': (await build({ stdin: { contents: `export { ScenePainter } from ${JSON.stringify(resolve(root, 'src/render/scenePainter.ts'))};
export { hexCenter, neighbourOf } from ${JSON.stringify(resolve(root, 'shared/hex.ts'))};
export { fixture, options } from ${JSON.stringify(resolve('scripts/render-all-layers-fixture.ts'))};`, resolveDir: resolve('.'), loader: 'ts' },
    bundle: true, write: false, format: 'iife', globalName: 'api', loader: { '.woff2': 'dataurl' } })).outputFiles[0].text,
};
const browser = await launchBrowser();
const report = { base, root, trial, pairs, span, zoom, browser: browser.version(), samples: [], images: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await serveBuild(context, '.', assets);
  const tab = await context.newPage();
  await tab.goto('http://render.test/blank'); await tab.addScriptTag({ url: 'http://render.test/page.js' });
  await tab.addScriptTag({ content: `window.visibleChange = ${visibleChange}` });
  await tab.exposeFunction('saveSample', sample => {
    report.samples.push(sample);
    writeFileSync(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
    if (sample.phase === 'measured') console.log(`${sample.tree} pair ${sample.pair}: paint ${sample.paintMs.toFixed(1)} ms, sharp frame ${sample.sharpMs.toFixed(1)} ms`);
  });
  const result = await tab.evaluate(async ({ pairs, span, zoom }) => {
    const size = { width: 1400, height: 900 }, options = api.options();
    const initial = api.fixture('interaction-study', span);
    const cells = initial.layers.polities.data.owner.flatMap((owner, i) => owner && initial.layers.base.data[i] === 'Land' ? [i] : []);
    const owners = initial.layers.polities.data.owner;
    const focusHex = cells.find(i => Array.from({ length: 6 }, (_, edge) => api.neighbourOf(i % initial.cols, Math.floor(i / initial.cols), edge)).some(n => {
      if (n.col < 0 || n.row < 0 || n.col >= initial.cols || n.row >= initial.rows) return false;
      const other = n.row * initial.cols + n.col;
      return owners[other] && owners[other] !== owners[i] && initial.layers.base.data[other] === 'Land';
    })) ?? cells[0];
    if (focusHex === undefined) throw Error('Fixture has no owned land');
    const focus = api.hexCenter(focusHex % initial.cols, Math.floor(focusHex / initial.cols), options.size);
    const makeSession = tree => {
      const worker = new Worker('/' + tree + '-worker.js');
      let pending = null, metadata, paintMs = 0, buildMs = 0;
      worker.addEventListener('message', ({ data }) => {
        if (data.timings?.paintMs !== undefined) paintMs = data.timings.paintMs;
        if (data.timings?.buildMs !== undefined) buildMs = data.timings.buildMs;
      });
      const complete = () => {
        if (!pending?.painted || !pending.overview) return;
        const done = pending; pending = null; clearTimeout(done.timer); done.resolve(done.result);
      };
      const painter = new api.ScenePainter({
        built: (_scene, m) => { metadata = m; },
        painted: (_scene, _frame, bitmap) => {
          if (pending) {
            const sharpMs = performance.now() - pending.start;
            const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
            canvas.getContext('2d').drawImage(bitmap, 0, 0);
            pending.result = { sharpMs, paintMs, buildMs, canvas };
            pending.painted = true;
          }
          bitmap.close(); complete();
        },
        overview: (_scene, image) => { image.bitmap.close(); if (pending) pending.overview = true; complete(); },
        failed: () => { if (pending) { clearTimeout(pending.timer); pending.reject(Error(tree + ' worker failed')); pending = null; } },
      }, worker);
      let map = structuredClone(initial);
      const view = (z, closeup) => {
        if (!metadata) return { x: 0, y: 0, scale: .5 };
        const scale = z === 'fit' ? Math.min(size.width / metadata.width, size.height / metadata.height) : Number(z);
        return closeup && z !== 'fit' ? { x: size.width / 2 - focus.x * scale, y: size.height / 2 - focus.y * scale, scale }
          : { x: (size.width - metadata.width * scale) / 2, y: (size.height - metadata.height * scale) / 2, scale };
      };
      const show = (z, build = true, closeup = false) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending = null; reject(Error(tree + ' frame timed out')); }, 120_000);
        pending = { start: performance.now(), resolve, reject, timer, overview: !build };
        if (build) painter.setMap(map, options, { width: 0, height: 0, background: '#fff', prims: [] });
        setTimeout(() => painter.paint({ size, dpr: 1, view: view(z, closeup) }), 0);
      });
      return { tree, show, dispose: () => painter.dispose(), edit: n => {
        const p = map.layers.polities.data, owner = [...p.owner], hex = cells[n % cells.length];
        owner[hex] = p.polities.find(polity => polity.id !== owner[hex]).id;
        map = { ...map, layers: { ...map.layers, polities: { ...map.layers.polities, data: { ...p, owner } } } };
      } };
    };
    const sessions = { base: makeSession('base'), new: makeSession('new') };
    try {
      for (const session of Object.values(sessions)) await session.show('fit');
      const take = async (tree, phase, pair, edit) => {
        sessions[tree].edit(edit);
        const { canvas, ...sample } = await sessions[tree].show(zoom);
        await window.saveSample({ tree, phase, pair, ...sample });
      };
      for (let n = 0; n < 2; n++) for (const tree of ['base', 'new']) await take(tree, 'warmup', n + 1, n);
      for (let pair = 1; pair <= pairs; pair++) {
        for (const tree of pair % 2 ? ['base', 'new'] : ['new', 'base']) await take(tree, 'measured', pair, pair + 1);
      }
      const images = [];
      const encode = async canvas => {
        const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
        let text = ''; for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return btoa(text);
      };
      for (const z of ['fit', '1', '2']) {
        const before = (await sessions.base.show(z, false, true)).canvas, after = (await sessions.new.show(z, false, true)).canvas;
        const pixels = c => c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const difference = window.visibleChange(pixels(before), pixels(after), before.width, before.height);
        images.push({ zoom: z, focusHex: z === 'fit' ? null : focusHex, ...difference, before: await encode(before), after: await encode(after) });
      }
      return images;
    } finally { for (const session of Object.values(sessions)) session.dispose(); }
  }, { pairs, span, zoom });
  for (const image of result) {
    for (const version of ['before', 'after']) {
      writeFileSync(resolve(output, `${image.zoom}-${version}.png`), Buffer.from(image[version], 'base64')); delete image[version];
    }
    report.images.push(image);
  }
  const measured = report.samples.filter(s => s.phase === 'measured');
  for (const key of ['paintMs', 'sharpMs']) report[key] = statistics(
    measured.filter(s => s.tree === 'base').map(s => s[key]), measured.filter(s => s.tree === 'new').map(s => s[key]));
  console.log(JSON.stringify({ paint: report.paintMs, sharpFrame: report.sharpMs, images: report.images }, null, 2));
  if (report.images.some(i => i.visible)) throw Error('Band thinning changed the picture visibly');
} catch (error) {
  report.error = String(error); throw error;
} finally {
  writeFileSync(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
  await browser.close();
  console.log(`Full samples and pictures: ${output}`);
}
