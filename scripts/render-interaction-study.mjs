/**
 * User-facing interaction latency through the production worker and ScenePainter
 * scheduling policy: what a person waits for, not scene construction alone.
 *
 *   node scripts/render-interaction-study.mjs [--source DIR] [--span 50] [--edits 8]
 *     [--interval 400] [--zoom fit|1|2] [--output work/interaction-study]
 *
 * Scenarios, each in a fresh worker after one cold build:
 *   cold         the first build: time to the first frame (a stand-in while the coast
 *                is fitted, DECISIONS §78) and to the exact frame.
 *   land-edit    a mainland hex turned to sea, refitting the coast: first and exact frame.
 *   edit-paced   unique ownership edits issued every --interval ms; time from the
 *                edit to its sharp frame (or to the frame that superseded it).
 *   pan-after-edit   one edit, then a pan 50 ms after its sharp frame; time from
 *                the pan to its sharp frame (an overview still painting is in the way).
 * Run --source against an archived checkout to compare policies on the same fixture.
 * Diagnostic only: headless software raster, synthetic fixture, no React scheduling.
 */
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';

const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const root = resolve(arg('--source', '.')), output = resolve(arg('--output', 'work/interaction-study'));
const settings = { span: Number(arg('--span', '50')), edits: Number(arg('--edits', '8')),
  interval: Number(arg('--interval', '400')), zoom: arg('--zoom', 'fit') };
mkdirSync(output, { recursive: true });
const bundle = entry => buildSync({ entryPoints: [entry], bundle: true, write: false,
  format: 'iife', globalName: 'api', loader: { '.woff2': 'dataurl' } }).outputFiles[0].text;
const worker = bundle(resolve(root, 'src/render/paint.worker.ts'));
// The painter policy under test comes from --source; the fixture from this checkout.
const entry = `export { ScenePainter } from ${JSON.stringify(resolve(root, 'src/render/scenePainter.ts'))};
export { fixture, options } from ${JSON.stringify(resolve('scripts/render-all-layers-fixture.ts'))};`;
const page = buildSync({ stdin: { contents: entry, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, write: false,
  format: 'iife', globalName: 'api', loader: { '.woff2': 'dataurl' } }).outputFiles[0].text;

const browser = await launchBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await serveBuild(context, '.', { '/page.js': page, '/paint.worker.js': worker });
  const tab = await context.newPage();
  await tab.goto('http://render.test/blank');
  await tab.addScriptTag({ url: 'http://render.test/page.js' });
  const result = await tab.evaluate(async ({ span, edits, interval, zoom }) => {
    const size = { width: 1400, height: 900 }, dpr = 1;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const session = async () => {
      const map = api.fixture('interaction-study', span), options = api.options();
      let onPainted = () => {}, onOverview = () => {}, metadata = null, builtScene = null;
      const painter = new api.ScenePainter({
        built: (scene, m) => { metadata = m; builtScene = scene; },
        painted: (scene, frame, bitmap) => { bitmap.close(); onPainted(scene, frame); },
        overview: (scene, image) => { image.bitmap.close(); onOverview(scene); },
        failed: () => { throw Error('worker failed'); },
      }, new Worker('/paint.worker.js'));
      let view;
      // Mirror MapView: a new map is sent, then its current view requested.
      const show = (target, frameView) => new Promise(done => {
        const scene = { width: 0, height: 0, background: '#fff', prims: [] };
        const start = performance.now();
        onPainted = s => { if (s === scene) done(performance.now() - start); };
        painter.setMap(target, options, scene);
        setTimeout(() => painter.paint({ view: frameView(), size, dpr }), 0);
      });
      const fitView = () => view;
      // The first frame, and the first after the exact scene's metadata (later still
      // when a stand-in is painted first).
      const showExact = (target, frameView) => new Promise(done => {
        const scene = { width: 0, height: 0, background: '#fff', prims: [] };
        const start = performance.now();
        let first = null;
        onPainted = s => {
          if (s !== scene) return;
          first ??= performance.now() - start;
          if (builtScene === scene) done({ first, exact: performance.now() - start });
        };
        painter.setMap(target, options, scene);
        setTimeout(() => painter.paint({ view: frameView(), size, dpr }), 0);
      });
      // First build fixes the scene size, from which the requested zoom follows.
      const built = new Promise(r => { onOverview = r; });
      view = { x: 0, y: 0, scale: 0.5 };
      const cold = await showExact(map, fitView);
      await built;
      return { map, options, painter, cold, size: () => metadata, setView: v => { view = v; }, show, showExact, fitView,
        setPainted: f => { onPainted = f; }, setOverview: f => { onOverview = f; } };
    };
    const zoomView = (width, height) => {
      const fit = Math.min(size.width / width, size.height / height);
      const scale = zoom === 'fit' ? fit : Number(zoom);
      return { scale, x: (size.width - width * scale) / 2, y: (size.height - height * scale) / 2 };
    };
    const editable = map => {
      const p = map.layers.polities.data;
      return p.owner.flatMap((owner, i) => owner && map.layers.base.data[i] === 'Land' ? [i] : []);
    };
    const edit = (map, index) => {
      const p = map.layers.polities.data, owner = [...p.owner];
      owner[index] = p.polities.find(polity => polity.id !== owner[index]).id;
      return { ...map, layers: { ...map.layers, polities: { ...map.layers.polities, data: { ...p, owner } } } };
    };
    const records = [];

    { // edit-paced
      const s = await session();
      records.push({ scenario: 'cold', ms: s.cold.first, exactMs: s.cold.exact });
      const { width, height } = s.size();
      s.setView(zoomView(width, height));
      await s.show(s.map, s.fitView); // settle at the requested zoom
      await wait(1500);
      const cells = editable(s.map);
      let map = s.map;
      const pending = new Map();
      s.setPainted(scene => {
        const now = performance.now();
        for (const [key, value] of pending) if (value.order <= scene.order) {
          records.push({ scenario: 'edit-paced', edit: key, ms: now - value.start, superseded: value.order < scene.order });
          pending.delete(key);
        }
      });
      for (let k = 0; k < edits; k++) {
        map = edit(map, cells[k]);
        const scene = { width: 0, height: 0, background: '#fff', prims: [], order: k };
        pending.set(k, { start: performance.now(), order: k });
        s.painter.setMap(map, s.options, scene);
        setTimeout(() => s.painter.paint({ view: s.fitView(), size, dpr }), 0);
        await wait(interval);
      }
      for (let t = 0; pending.size && t < 300; t++) await wait(100);
      s.painter.dispose();
    }
    { // pan-after-edit
      const s = await session();
      const { width, height } = s.size();
      s.setView(zoomView(width, height));
      await s.show(s.map, s.fitView);
      await wait(1500);
      const cells = editable(s.map);
      let map = s.map;
      for (let k = 0; k < edits; k++) {
        map = edit(map, cells[k]);
        const editMs = await s.show(map, s.fitView);
        await wait(50);
        const base = s.fitView();
        const panned = { ...base, x: base.x + (k % 2 ? -60 : 60) };
        s.setView(panned);
        const panMs = await new Promise(done => {
          const start = performance.now();
          s.setPainted((_scene, frame) => { if (frame.view === panned) done(performance.now() - start); });
          s.painter.paint({ view: panned, size, dpr });
        });
        records.push({ scenario: 'pan-after-edit', edit: k, editMs, ms: panMs });
        s.setView(base);
        await wait(interval);
      }
      s.painter.dispose();
    }
    { // land-edit
      const s = await session();
      records.push({ scenario: 'cold', ms: s.cold.first, exactMs: s.cold.exact });
      const { width, height } = s.size();
      s.setView(zoomView(width, height));
      await s.show(s.map, s.fitView);
      await wait(1500);
      const base = s.map.layers.base.data;
      const shore = base.flatMap((v, i) => v === 'Land' && (base[i - 1] === 'Sea' || base[i + 1] === 'Sea') ? [i] : []);
      let map = s.map;
      for (let k = 0; k < Math.min(edits, 3, shore.length); k++) {
        const data = [...map.layers.base.data];
        data[shore[k]] = 'Sea';
        map = { ...map, layers: { ...map.layers, base: { ...map.layers.base, data } } };
        const { first, exact } = await s.showExact(map, s.fitView);
        records.push({ scenario: 'land-edit', edit: k, ms: first, exactMs: exact });
        await wait(interval);
      }
      s.painter.dispose();
    }
    return records;
  }, settings);
  const summary = {};
  const stats = values => { values.sort((a, b) => a - b); return { n: values.length, median: values[Math.floor(values.length / 2)], max: values.at(-1) }; };
  for (const scenario of ['cold', 'land-edit', 'edit-paced', 'pan-after-edit']) {
    const rows = result.filter(r => r.scenario === scenario);
    summary[scenario] = { ...stats(rows.map(r => r.ms)), ...(rows[0]?.exactMs !== undefined ? { exact: stats(rows.map(r => r.exactMs)) } : {}) };
  }
  const report = { settings, source: root, browser: browser.version(), summary, records: result };
  writeFileSync(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ settings, summary }, null, 2));
} finally { await browser.close(); }
