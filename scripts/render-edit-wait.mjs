/**
 * What a person waits for after an edit, split into its parts (performance plan, Group 1, step 3.1).
 *
 *   node scripts/render-edit-wait.mjs [--runs 3] [--span 50] [--zoom fit|1|2] [--output DIR]
 *
 * Through the production worker and ScenePainter, on the all-layer interaction map: one cold
 * build, then ten edits of four kinds applied in sequence, each waited out (sharp frame and
 * overview) before the next. For each edit: input to sharp frame; the worker's build, and the
 * coast fit within it (from the build's phase profile); the worker's paint; and the rest
 * (structured-clone transfer both ways, scheduling and the bitmap hand-back). Repeated --runs
 * times in fresh workers; the report gives each edit's median. Diagnostic only: headless
 * software raster, no React.
 */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';

const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const runs = Number(arg('--runs', '3')), span = Number(arg('--span', '50')), zoom = arg('--zoom', 'fit');
const output = resolve(arg('--output', `work/edit-wait/${new Date().toISOString().replace(/[:.]/g, '-')}`));
mkdirSync(output, { recursive: true });
const bundle = async (options) => (await build({ bundle: true, write: false, format: 'iife', globalName: 'api',
  loader: { '.woff2': 'dataurl' }, ...options })).outputFiles[0].text;
const assets = {
  '/worker.js': await bundle({ entryPoints: [resolve('src/render/paint.worker.ts')] }),
  '/page.js': await bundle({ stdin: { contents: `export { ScenePainter } from ${JSON.stringify(resolve('src/render/scenePainter.ts'))};
export { neighbourOf, inBounds } from ${JSON.stringify(resolve('shared/hex.ts'))};
export { isCategoryLand, isCategoryWater } from ${JSON.stringify(resolve('shared/hexCategories.ts'))};
export { fixture, options } from ${JSON.stringify(resolve('scripts/render-all-layers-fixture.ts'))};`, resolveDir: resolve('.'), loader: 'ts' } }),
};

const browser = await launchBrowser();
const report = { runs, span, zoom, browser: browser.version(), samples: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await serveBuild(context, '.', assets);
  const tab = await context.newPage();
  await tab.goto('http://render.test/blank');
  await tab.addScriptTag({ url: 'http://render.test/page.js' });
  report.samples = await tab.evaluate(async ({ runs, span, zoom }) => {
    const size = { width: 1400, height: 900 };
    const initial = api.fixture('interaction-study', span), options = api.options();
    const { cols, rows } = initial, base = initial.layers.base.data;
    const around = i => [0, 1, 2, 3, 4, 5].flatMap(e => {
      const n = api.neighbourOf(i % cols, Math.floor(i / cols), e);
      return api.inBounds(cols, rows, n.col, n.row) ? [n.row * cols + n.col] : [];
    });
    const cityAt = new Set(initial.layers.cities.data.cities.map(c => c.row * cols + c.col));
    const rivers = new Set(initial.layers.rivers.data.rivers.flatMap(r => r.segments.map(s => s.row * cols + s.col)));
    const plain = i => base[i] === 'Land' && !cityAt.has(i) && !rivers.has(i);
    const coastal = base.flatMap((v, i) => plain(i) && around(i).some(j => base[j] === 'Sea') ? [i] : []);
    const inland = base.flatMap((v, i) => plain(i) && around(i).length === 6 && around(i).every(j => base[j] === 'Land') ? [i] : []);
    const offshore = base.flatMap((v, i) => v === 'Sea' && around(i).some(j => base[j] === 'Land') && around(i).filter(j => base[j] === 'Sea').length >= 4 ? [i] : []);
    const owner = initial.layers.polities.data.owner;
    const border = inland.filter(i => owner[i] && around(i).some(j => owner[j] && owner[j] !== owner[i]));
    const pick = (list, k) => list[Math.floor(list.length * k)];
    // Ten edits, spread over the map; each changes the map left by the one before.
    const layer = (map, id, data) => ({ ...map, layers: { ...map.layers, [id]: { ...map.layers[id], data } } });
    const edits = [
      { kind: 'coast: land to sea', apply: m => { const i = pick(coastal, .2), d = [...m.layers.base.data]; d[i] = 'Sea'; return layer(m, 'base', d); } },
      { kind: 'coast: sea to land', apply: m => { const i = pick(offshore, .6), d = [...m.layers.base.data]; d[i] = 'Land'; return layer(m, 'base', d); } },
      { kind: 'coast: land share 60%', apply: m => { const i = pick(coastal, .8); return { ...m, hexShapes: { ...m.hexShapes, [i]: { type: 'Land', land: 60 } } }; } },
      { kind: 'inland: vegetation', apply: m => { const i = pick(inland, .3), d = [...m.layers.vegetation.data]; d[i] = d[i] === 'Prairie' ? 'Deciduous Forest' : 'Prairie'; return layer(m, 'vegetation', d); } },
      { kind: 'inland: elevation', apply: m => { const i = pick(inland, .5), d = [...m.layers.elevation.data]; d[i] = d[i] === 'Mountains' ? 'Hills' : 'Mountains'; return layer(m, 'elevation', d); } },
      { kind: 'inland: land to lake', apply: m => { const i = pick(inland, .7), d = [...m.layers.base.data]; d[i] = 'Lake'; return layer(m, 'base', d); } },
      { kind: 'ownership', apply: m => { const p = m.layers.polities.data, o = [...p.owner], i = pick(border, .25); o[i] = o[around(i).find(j => o[j] && o[j] !== o[i])]; return layer(m, 'polities', { ...p, owner: o }); } },
      { kind: 'ownership', apply: m => { const p = m.layers.polities.data, o = [...p.owner], i = pick(border, .75); o[i] = o[around(i).find(j => o[j] && o[j] !== o[i])]; return layer(m, 'polities', { ...p, owner: o }); } },
      { kind: 'city: add', apply: m => { const c = m.layers.cities.data, i = pick(inland, .4), from = c.cities[0];
        return layer(m, 'cities', { ...c, cities: [...c.cities, { ...from, id: 'city_wait_added', name: 'Waitford', col: i % cols, row: Math.floor(i / cols), onRiver: false, riverId: null, coastal: false, coastalEdges: [] }] }); } },
      { kind: 'city: remove', apply: m => { const c = m.layers.cities.data; return layer(m, 'cities', { ...c, cities: c.cities.slice(1) }); } },
    ];
    const out = [];
    for (let run = 0; run < runs; run++) {
      const worker = new Worker('/worker.js');
      let timings = {}, profile = null, metadata = null, pending = null;
      worker.addEventListener('message', ({ data }) => {
        if (data.timings?.buildMs !== undefined) { timings.buildMs = data.timings.buildMs; profile = data.profile ?? null; }
        if (data.timings?.paintMs !== undefined) timings.paintMs = data.timings.paintMs;
      });
      const complete = () => { if (pending?.painted && pending.overview) { const p = pending; pending = null; clearTimeout(p.timer); p.resolve(p.result); } };
      const painter = new api.ScenePainter({
        built: (_s, m) => { metadata = m; },
        painted: (_s, _f, bitmap) => { bitmap.close(); if (pending && !pending.painted) { pending.result.sharpMs = performance.now() - pending.start; pending.painted = true; } complete(); },
        overview: (_s, image) => { image.bitmap.close(); if (pending) pending.overview = true; complete(); },
        failed: () => { if (pending) { clearTimeout(pending.timer); pending.reject(Error('worker failed')); pending = null; } },
      }, worker);
      const view = () => {
        if (!metadata) return { x: 0, y: 0, scale: .5 };
        const scale = zoom === 'fit' ? Math.min(size.width / metadata.width, size.height / metadata.height) : Number(zoom);
        return { x: (size.width - metadata.width * scale) / 2, y: (size.height - metadata.height * scale) / 2, scale };
      };
      const show = map => new Promise((resolve, reject) => {
        timings = {}; profile = null;
        const timer = setTimeout(() => { pending = null; reject(Error('frame timed out')); }, 120_000);
        pending = { start: performance.now(), resolve, reject, timer, overview: false, result: {} };
        painter.setMap(map, options, { width: 0, height: 0, background: '#fff', prims: [] }, true);
        setTimeout(() => painter.paint({ size, dpr: 1, view: view() }), 0);
      }).then(result => {
        const phase = name => (profile?.timings ?? []).filter(t => t.name === name).reduce((s, t) => s + t.duration, 0);
        return { ...result, buildMs: timings.buildMs, paintMs: timings.paintMs, coastMs: phase('scene.coast'), fitMs: phase('coast.fit'),
          compromises: metadata?.compromises?.length ?? 0 };
      });
      let map = structuredClone(initial);
      const cold = await show(map);
      out.push({ run, edit: -1, kind: 'cold build', ...cold });
      await show(map); // settle at the requested zoom before timing edits
      for (const [k, edit] of edits.entries()) {
        map = edit.apply(map);
        out.push({ run, edit: k, kind: edit.kind, ...(await show(map)) });
      }
      painter.dispose();
    }
    return out;
  }, { runs, span, zoom });
} finally {
  await browser.close();
}
const median = values => { const a = values.filter(Number.isFinite).sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : NaN; };
const rows = [...new Set(report.samples.map(s => s.edit))].map(edit => {
  const group = report.samples.filter(s => s.edit === edit), m = key => median(group.map(s => s[key]));
  const sharp = m('sharpMs'), build = m('buildMs'), paint = m('paintMs');
  return { edit, kind: group[0].kind, sharpMs: sharp, buildMs: build, coastMs: m('coastMs'), fitMs: m('fitMs'), paintMs: paint, restMs: sharp - build - paint };
});
report.medians = rows;
writeFileSync(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
const f = v => Number.isFinite(v) ? v.toFixed(0).padStart(6) : '     –';
console.log(`${'#'.padStart(3)}  ${'edit'.padEnd(24)} ${'sharp'.padStart(6)} ${'build'.padStart(6)} ${'coast'.padStart(6)} ${'fit'.padStart(6)} ${'paint'.padStart(6)} ${'rest'.padStart(6)}  (ms, median of ${runs})`);
for (const r of rows) console.log(`${String(r.edit).padStart(3)}  ${r.kind.padEnd(24)} ${f(r.sharpMs)} ${f(r.buildMs)} ${f(r.coastMs)} ${f(r.fitMs)} ${f(r.paintMs)} ${f(r.restMs)}`);
console.log(`Samples: ${resolve(output, 'results.json')}`);
