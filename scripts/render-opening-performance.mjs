/** Production opening/edit timings. No synthetic build replaces the app's worker path. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';
import { openingProbe } from './render-opening-probe.mjs';
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const output = resolve(arg('--output', 'work/render-opening'));
mkdirSync(output, { recursive: true });
const mapText = readFileSync(arg('--fixture', 'test/fixtures/populated-40.json'), 'utf8'), map = JSON.parse(mapText);
const browser = await launchBrowser(), browserVersion = browser.version();
const openings = [], edits = [], navigation = [], pageErrors = [];
const profiled = process.argv.includes('--profile');
const exerciseEdits = !profiled || process.argv.includes('--profile-edits');
const metrics = entries => {
  const a = [...entries].sort((a,b) => a-b);
  return a.length ? { median: a[Math.floor(a.length / 2)], p95: a[Math.ceil(a.length * .95) - 1], max: a.at(-1) } : null;
};
const settle = page => page.waitForFunction(() => {
  const s = window.renderProbe, last = s.displays.at(-1);
  return last?.build?.id === s.latestBuild?.id && last.build.worker === s.latestBuild.worker && !s.pending && performance.now() - last.displayed > 250;
}, null, { timeout: 90000 });
// Chromium's worker targets use nested CDP sessions. Keep profiling separate from timing runs.
async function workerProfiler(page) {
  const cdp = await page.context().newCDPSession(page), sessions = new Map(), pending = new Map();
  let id = 0;
  const send = (sessionId, method) => new Promise((resolve, reject) => {
    const request = ++id;
    const timer = setTimeout(() => { pending.delete(request); reject(Error(`Worker profiling timed out: ${method}`)); }, 15000);
    pending.set(request, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: request, method }) }).catch(reject);
  });
  cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
    const data = JSON.parse(message), p = pending.get(data.id);
    if (p) { pending.delete(data.id); data.error ? p.reject(new Error(data.error.message)) : p.resolve(data.result); }
  });
  cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
    if (targetInfo.type !== 'worker') { void send(sessionId, 'Runtime.runIfWaitingForDebugger'); return; }
    const started = (async () => { await send(sessionId, 'Profiler.enable'); await send(sessionId, 'Profiler.start'); await send(sessionId, 'Runtime.runIfWaitingForDebugger'); })();
    sessions.set(sessionId, { url: targetInfo.url, started });
  });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false });
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8,blink.user_timing,loading,disabled-by-default-v8.cpu_profiler', transferMode: 'ReturnAsStream' });
  return async () => {
    for (const [sessionId, session] of sessions) {
      await session.started;
      const { profile } = await send(sessionId, 'Profiler.stop');
      writeFileSync(resolve(output, `${session.url.includes('build.worker') ? 'build' : 'paint'}-${sessionId}.cpuprofile`), JSON.stringify(profile));
    }
    const complete = new Promise(r => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.end');
    const { stream } = await complete; let trace = '';
    for (;;) { const part = await cdp.send('IO.read', { handle: stream }); trace += part.data; if (part.eof) break; }
    await cdp.send('IO.close', { handle: stream });
    writeFileSync(resolve(output, 'browser-trace.json'), trace);
    await cdp.detach();
  };
}
try {
  for (let run = 0; run < Number(arg('--runs', profiled ? '1' : '10')); run++) {
    // A new context supplies a cold browser cache, storage and workers. Warm reopen is explicit.
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: Number(arg('--dpr', '1')) });
    await serveBuild(context, resolve(arg('--dist', 'dist')));
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto('http://render.test/blank');
    await page.evaluate(async map => {
      localStorage.setItem('fhm.mode', 'manual');
      localStorage.setItem('fantasyhexmap.prefs', JSON.stringify({ defaultsVersion: 2, offline: true, labels: true, riverNames: true, rangeNames: true, seaNames: true, landNames: true, mapStyle: { preset: 'parchment', overrides: { coast: 'smooth' } } }));
      await new Promise((resolve, reject) => { const req = indexedDB.open('fantasyhexmap', 2);
        req.onupgradeneeded = () => { req.result.createObjectStore('maps'); req.result.createObjectStore('saves', { keyPath: 'id' }); };
        req.onsuccess = () => { const db = req.result, tx = db.transaction('maps','readwrite'); tx.objectStore('maps').put(map,'current'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = reject; }; req.onerror = reject;
      });
    }, map);
    await page.addInitScript(openingProbe);
    const stopProfile = profiled ? await workerProfiler(page) : null;
    const passes = !profiled && process.argv.includes('--warm') ? 2 : 1;
    for (let pass = 0; pass < passes; pass++) {
      const query = new URLSearchParams();
      if (profiled) query.set('renderProfile', '');
      if (process.argv.includes('--full')) query.set('renderFull', '');
      await page.goto(`http://render.test/?${query}`);
      await page.locator('.mapwrap canvas').first().waitFor();
      // The normal app starts with Base only. Enable all other layers before measuring
      // current sharp completion; retain every intervening build/queued request in the report.
      const buttons = page.locator('button[aria-label^="Show "][aria-label$=" on the map"]');
      while (await buttons.count()) await buttons.first().click();
      await settle(page);
      const record = await page.evaluate(({ run, pass }) => {
        const s = window.renderProbe;
        const clean = { ...s }; delete clean.lastScene; delete clean.lastMap; delete clean.lastOptions;
        return { run, cache: pass ? 'warm-reopen' : 'cold', ...clean, firstNonblankMs: s.displays[0].displayed,
          sharpMs: s.displays.at(-1).displayed, layers: Object.values(s.lastOptions.visible).filter(Boolean).length, labels: s.lastOptions.labels,
          scenePayload: s.lastScene?.prims ? 'full-scene' : 'metadata',
          sceneBytes: new TextEncoder().encode(JSON.stringify(s.lastScene)).length, mapBytes: new TextEncoder().encode(JSON.stringify(s.lastMap)).length };
      }, { run, pass });
      openings.push(record);
      console.log(JSON.stringify({ run, cache: record.cache, firstNonblankMs: record.firstNonblankMs, sharpMs: record.sharpMs }));
    }
    await page.screenshot({ path: resolve(output, `opening-${run}.png`) });
    if (stopProfile) await stopProfile();
    if (exerciseEdits && run === 0 && process.argv.includes('--opacity')) {
      for (let edit = 0; edit < Number(arg('--edits', '20')); edit++) {
        await page.locator('.settings-btn').click();
        await page.getByRole('tab', { name: 'Display', exact: true }).click();
        const slider = page.getByRole('slider', { name: 'Polity layer opacity', exact: true });
        await slider.press(edit % 2 ? 'ArrowRight' : 'ArrowLeft');
        const start = await page.evaluate(() => performance.now());
        await page.getByRole('button', { name: 'save', exact: true }).click();
        await page.waitForFunction(start => window.renderProbe.posts.some(b => b.type === 'build' && b.start >= start), start, { timeout: 90000 });
        await settle(page);
        edits.push(await page.evaluate(({ start, edit }) => {
          const s = window.renderProbe, last = s.displays.at(-1);
          if (s.lastOptions.polityOpacity !== (edit % 2 ? 1 : .95)) throw Error('Opacity did not reach worker');
          return { edit, sharpMs: last.displayed - start, builds: s.builds.filter(b => b.start >= start),
            inputs: s.inputs.filter(e => e.start >= start), gaps: s.gaps.filter(e => e.at >= start), tasks: s.tasks.filter(e => e.start >= start) };
        }, { start, edit }));
        console.log(JSON.stringify({ edit, kind: 'opacity', sharpMs: edits.at(-1).sharpMs }));
      }
    } else if (exerciseEdits && run === 0) {
      const canvas = page.locator('.mapwrap canvas').first(), box = await canvas.boundingBox();
      const selection = await page.evaluate(shore => {
        const s = window.renderProbe, map = s.lastMap, base = map.layers.base.data;
        // An exposed mainland hex near the map centre, changed by the actual inspector.
        const index = base.findIndex((v, i) => (shore ? v === 'Coastal Land' : v === 'Land') && (shore || i > map.cols * 10 && i < map.cols * 30) && (base[i - 1] === 'Sea' || base[i + 1] === 'Sea'));
        if (index < 0) throw Error('Fixture has no exposed land hex');
        const col = index % map.cols, row = Math.floor(index / map.cols), frame = s.lastFrame;
        return { index, x: frame.view.x + Math.sqrt(3) * 26 * (col + .5 * (row & 1)) * frame.view.scale + Math.sqrt(3) * 13 * frame.view.scale,
          y: frame.view.y + (1.5 * row + 1) * 26 * frame.view.scale };
      }, process.argv.includes('--shore'));
      await page.mouse.click(box.x + selection.x, box.y + selection.y);
      const apply = page.getByRole('button', { name: 'Apply to 1 selected', exact: true });
      await apply.waitFor();
      const select = page.locator('select').filter({ has: page.locator('option[value="Coastal Land"]') }).first();
      for (let edit = 0; edit < Number(arg('--edits', '20')); edit++) {
        const value = process.argv.includes('--shore') ? (edit % 2 ? 'Coastal Land' : 'Sea') : (edit % 2 ? 'Land' : 'Coastal Land');
        await select.selectOption(value);
        const start = await page.evaluate(() => performance.now());
        await apply.click();
        await page.waitForFunction(start => window.renderProbe.posts.some(b => b.type === 'build' && b.start >= start), start, { timeout: 90000 });
        // Exercise input while construction is in flight.
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.wheel(0, edit % 2 ? 15 : -15);
        await settle(page);
        edits.push(await page.evaluate(({ start, edit, index, wanted }) => {
          const s = window.renderProbe, last = s.displays.at(-1), value = s.lastMap.layers.base.data[index];
          if (value !== wanted) throw Error('The edit did not reach the build worker');
          return { edit, index, value, sharpMs: last.displayed - start, builds: s.builds.filter(b => b.start >= start),
            inputs: s.inputs.filter(e => e.start >= start), gaps: s.gaps.filter(e => e.at >= start), tasks: s.tasks.filter(e => e.start >= start) };
        }, { start, edit, index: selection.index, wanted: value }));
        console.log(JSON.stringify({ edit, kind: process.argv.includes('--shore') ? 'shore' : 'land-share', sharpMs: edits.at(-1).sharpMs }));
      }
      if (process.argv.includes('--burst')) {
        for (const value of ['Sea', 'Land', 'Sea', 'Coastal Land', 'Land']) {
          await select.selectOption(value); await apply.click();
        }
        await settle(page);
        const latest = await page.evaluate(index => ({ value: window.renderProbe.lastMap.layers.base.data[index],
          displayed: window.renderProbe.displays.at(-1).build, latest: window.renderProbe.latestBuild }), selection.index);
        if (latest.value !== 'Land' || latest.displayed.id !== latest.latest.id || latest.displayed.worker !== latest.latest.worker) throw Error('Rapid edits displayed a stale state');
        writeFileSync(resolve(output, 'burst.json'), JSON.stringify(latest, null, 2));
      }
      // Native settled navigation, sidebar and mobile scrolling also record responsiveness.
      for (const mobile of [false, true]) {
        await page.setViewportSize(mobile ? { width: 500, height: 800 } : { width: 1400, height: 450 });
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
        await settle(page);
        const target = mobile ? page.locator('body') : page.locator('.sidebar').first(), bounds = await target.boundingBox();
        await page.mouse.move(bounds.x + Math.min(100, bounds.width / 2), Math.min(700, bounds.y + 120));
        const start = await page.evaluate(() => performance.now()), before = await target.evaluate(e => ({ scrollTop: e.scrollTop, pageY: window.scrollY }));
        for (let i = 0; i < 10; i++) { await page.mouse.wheel(0, 40); await page.evaluate(() => new Promise(r => requestAnimationFrame(r))); }
        await settle(page);
        const after = await target.evaluate(e => ({ scrollTop: e.scrollTop, pageY: window.scrollY }));
        navigation.push(await page.evaluate(({ mobile, start, before, after }) => { const s = window.renderProbe; return { mobile, viewport: { width: innerWidth, height: innerHeight }, before, after, moved: mobile ? after.pageY !== before.pageY : after.scrollTop !== before.scrollTop, inputs: s.inputs.filter(e => e.start >= start), gaps: s.gaps.filter(e => e.at >= start), tasks: s.tasks.filter(e => e.start >= start) }; }, { mobile, start, before, after }));
      }
      await page.screenshot({ path: resolve(output, 'edited-mobile.png') });
    }
    await context.close();
  }
} finally { await browser.close(); }
const report = { fixtureSha256: createHash('sha256').update(mapText).digest('hex'), profiled, forcedFull: process.argv.includes('--full'), editKind: process.argv.includes('--opacity') ? 'opacity' : process.argv.includes('--shore') ? 'shore' : 'land-share',
  browser: browserVersion, rasterThreads: 1, runs: openings.length,
  opening: metrics(openings.filter(r => r.cache === 'cold').map(r => r.sharpMs)), edits: metrics(edits.map(r => r.sharpMs)), openings, editSamples: edits, navigation, pageErrors };
report.gates = { coldOpeningUnder1000ms: openings.filter(r => r.cache === 'cold').every(r => r.sharpMs < 1000), editInputUnder33ms: edits.every(r => r.inputs.every(e => e.duration <= 33)), editCadenceUnder33_5ms: edits.every(r => r.gaps.every(e => e.duration <= 33.5)), nativeScrollingMoved: navigation.every(r => r.moved) };
writeFileSync(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
if (pageErrors.length) throw Error(`Browser page errors: ${pageErrors.join('; ')}`);
if (navigation.some(r => !r.moved)) throw Error('Native scrolling did not move its target');
if (openings.some(r => r.errors.length || r.layers !== 8 || !r.labels)) throw Error('Opening failed or fixture layers missing');
if (process.argv.includes('--check') && !profiled) {
  if (openings.some(r => r.sharpMs >= 1000)) throw Error('Cold opening exceeds 1000 ms');
  if (edits.some(r => r.inputs.some(e => e.duration > 33) || r.gaps.some(e => e.duration > 33.5))) throw Error('Editing responsiveness gate failed');
}
