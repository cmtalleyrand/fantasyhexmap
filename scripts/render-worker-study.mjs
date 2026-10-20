/** Production worker study. Keep --memory diagnostics separate from timing runs. */
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';

const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const root = resolve(arg('--source', '.')), output = resolve(arg('--output', 'work/worker-study'));
const memory = process.argv.includes('--memory');
mkdirSync(output, { recursive: true });
const bundle = entry => buildSync({ entryPoints: [entry], bundle: true, write: false,
  format: 'iife', globalName: 'api', loader: { '.woff2': 'dataurl' } }).outputFiles[0].text;
const browser = await launchBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await serveBuild(context, '.', {
    '/fixture.js': bundle('scripts/render-all-layers-fixture.ts'),
    '/paint.worker.js': bundle(resolve(root, 'src/render/paint.worker.ts')),
  });
  const page = await context.newPage();
  await page.goto('http://render.test/blank');
  await page.addScriptTag({ url: 'http://render.test/fixture.js' });
  const heaps = [], cdp = memory ? await context.newCDPSession(page) : null;
  let workerSession, requestId = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Worker CDP timeout: ${method}`)); }, 15000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    cdp.send('Target.sendMessageToTarget', { sessionId: workerSession, message: JSON.stringify({ id, method, params }) }).catch(reject);
  });
  if (cdp) {
    cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
      if (targetInfo.type === 'worker') workerSession = sessionId;
    });
    cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
      const data = JSON.parse(message), waiting = pending.get(data.id);
      if (waiting) { pending.delete(data.id); data.error ? waiting.reject(Error(data.error.message)) : waiting.resolve(data.result); }
    });
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,disabled-by-default-v8.gc,blink.user_timing', transferMode: 'ReturnAsStream' });
    await page.exposeFunction('workerHeap', async step => {
      if (!workerSession) throw Error('Production worker CDP session missing');
      const before = await send('Runtime.getHeapUsage');
      await send('HeapProfiler.collectGarbage');
      const retained = await send('Runtime.getHeapUsage');
      heaps.push({ step, before, retained });
    });
  }
  const result = await page.evaluate(async ({ span, edits, memory }) => {
    const map = api.fixture('worker-study', span), options = api.options();
    const worker = new Worker('/paint.worker.js');
    const canvas = document.createElement('canvas'); canvas.width = 1400; canvas.height = 900;
    document.body.append(canvas);
    const ctx = canvas.getContext('bitmaprenderer');
    let version = 0, reply, fail;
    worker.onmessage = ({ data }) => reply(data);
    worker.onerror = error => fail?.(Error(error.message));
    const call = data => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Production worker timed out')), 120000);
      fail = error => { clearTimeout(timer); reject(error); };
      reply = value => { clearTimeout(timer); value.error ? reject(Error(value.error)) : resolve(value); };
      worker.postMessage(data);
    });
    const records = [];
    const buildPaint = async (scenario, edit) => {
      version++;
      const start = performance.now();
      const build = await call({ type: 'build', version, id: version, map, options, profile: true });
      const built = performance.now();
      const scale = Math.min(1400 / build.metadata.width, 900 / build.metadata.height);
      const paint = await call({ type: 'paint', version, id: version, view: { x: 0, y: 0, scale },
        size: { width: 1400, height: 900 }, dpr: 1, profile: true });
      ctx.transferFromImageBitmap(paint.bitmap);
      const bitmapReady = performance.now();
      // Drain the overview before issuing the next build, as production does.
      const overviewDone = paint.complete ? Promise.resolve() : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Overview timed out')), 120000);
        fail = error => { clearTimeout(timer); reject(error); };
        reply = data => { data.overview?.bitmap.close(); clearTimeout(timer); data.error ? reject(Error(data.error)) : resolve(); };
      });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const displayed = performance.now();
      await overviewDone;
      records.push({ scenario, edit, buildRoundtripMs: built-start, bitmapReadyMs: bitmapReady-start, sharpMs: displayed-start,
        workerBuildMs: build.timings.buildMs, workerPaintMs: paint.timings.paintMs,
        polityLabelsMs: build.profile.timings.filter(t => t.name === 'scene.polityLabels').reduce((sum,t) => sum+t.duration,0),
        profile: build.profile });
      if (memory && (edit < 0 || (edit + 1) % 8 === 0)) await window.workerHeap(`${scenario}/${edit}`);
    };
    await buildPaint('cold', -1);
    await buildPaint('warm', -1);
    const p = map.layers.polities.data;
    const editable = p.owner.flatMap((owner, i) => owner && map.layers.base.data[i] === 'Land' ? [i] : []);
    if (editable.length < edits || p.polities.length < 2) throw Error('Insufficient unique ownership edits');
    for (let edit = 0; edit < edits; edit++) {
      const index = editable[edit], owner = [...map.layers.polities.data.owner];
      owner[index] = p.polities.find(polity => polity.id !== owner[index]).id;
      map.layers.polities = { ...map.layers.polities, data: { ...p, owner } };
      await buildPaint('ownership', edit);
    }
    const image = canvas.toDataURL('image/png').split(',')[1];
    worker.terminate();
    return { cols: map.cols, rows: map.rows, uniqueEdits: edits, records, image };
  }, { span: Number(arg('--span', '50')), edits: Number(arg('--edits', '32')), memory });
  writeFileSync(resolve(output, 'finished.png'), Buffer.from(result.image, 'base64')); delete result.image;
  if (cdp) {
    const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
    await cdp.send('Tracing.end');
    const { stream } = await complete; let trace = '';
    for (;;) { const part = await cdp.send('IO.read', { handle: stream }); trace += part.data; if (part.eof) break; }
    await cdp.send('IO.close', { handle: stream });
    writeFileSync(resolve(output, 'trace.json.gz'), gzipSync(trace));
    await cdp.detach();
  }
  const summary = {};
  for (const scenario of ['cold', 'warm', 'ownership']) {
    summary[scenario] = {};
    for (const metric of ['buildRoundtripMs', 'bitmapReadyMs', 'sharpMs', 'workerBuildMs', 'workerPaintMs', 'polityLabelsMs']) {
      const values = result.records.filter(r => r.scenario === scenario).map(r => r[metric]).sort((a,b) => a-b);
      summary[scenario][metric] = { n: values.length, median: values[Math.floor(values.length/2)], p95: values[Math.ceil(values.length*.95)-1] };
    }
  }
  const report = { browser: browser.version(), source: root, memory, limits: 'Synthetic all-layer fixture; one worker lifetime; production build/paint worker and bitmap transfer, without React inspector/input scheduling. Includes profile counters. sharpMs waits two animation frames after copying the bitmap. Memory mode forces GC outside build/paint samples; do not use its timings as benchmark evidence.', ...result, summary, heaps };
  writeFileSync(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ memory, summary, heaps }, null, 2));
  await context.close();
} finally { await browser.close(); }
