/**
 * Load the coast feature map into the production app and measure how long it takes to appear and
 * how long the page stops answering meanwhile (main-thread long tasks; how late a 50 ms timer runs).
 *
 *   npm run build && node --import tsx scripts/make-feature-map.ts 30
 *   npm install --prefix work --no-audit --no-fund puppeteer-core
 *   node scripts/render-app-build-responsiveness.mjs dist after
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
const puppeteer = (await import(pathToFileURL(resolve('work/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js')).href)).default;
const root = resolve(process.argv[2] ?? 'dist');
const map = JSON.parse(readFileSync('work/feature-map.json', 'utf8'));
const server = createServer((req, res) => {
  if (req.url === '/blank') { res.setHeader('Content-Type', 'text/html'); res.end('<html><body></body></html>'); return; }
  const path = resolve(root, decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\//, '') || 'index.html');
  try { const data = readFileSync(path); res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[extname(path)] || 'application/octet-stream'); res.end(data); } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await puppeteer.launch({ executablePath: '/opt/pw-browsers/chromium', pipe: true, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.goto(url + '/blank');
  await page.evaluate(async (map) => {
    localStorage.setItem('fantasyhexmap.prefs', JSON.stringify({ defaultsVersion: 2, offline: true, labels: true, mapStyle: { preset: 'parchment', overrides: { coast: 'smooth' } } }));
    await new Promise((resolve, reject) => { const req = indexedDB.open('fantasyhexmap', 2); req.onupgradeneeded = () => { const db = req.result; db.createObjectStore('maps'); db.createObjectStore('saves', { keyPath: 'id' }); }; req.onsuccess = () => { const db = req.result, tx = db.transaction('maps', 'readwrite'); tx.objectStore('maps').put(map, 'current'); tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = reject; }; req.onerror = reject; });
  }, map);
  await page.evaluateOnNewDocument(() => {
    window.tasks = [];
    new PerformanceObserver(list => window.tasks.push(...list.getEntries().map(e => ({ at: e.startTime, ms: e.duration })))).observe({ type: 'longtask', buffered: true });
    // How late a 50 ms heartbeat runs: what a click or key would wait for.
    window.lateness = [];
    let last = performance.now();
    setInterval(() => { const now = performance.now(); window.lateness.push(now - last - 50); last = now; }, 50);
  });
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForSelector('.mapwrap canvas');
  // Drawn: the map canvas has land colour somewhere (not just the blank sea).
  await page.waitForFunction(() => {
    const c = document.querySelector('.mapwrap canvas'); if (!c) return false;
    const ctx = c.getContext('2d'); const { width, height } = c; if (!width) return false;
    const data = ctx.getImageData(0, 0, width, height).data; const seen = new Set();
    for (let i = 0; i < data.length; i += 4 * 997) seen.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
    return seen.size > 6;
  }, { timeout: 300000, polling: 250 });
  const drawnMs = Date.now() - t0;
  await new Promise(r => setTimeout(r, 1500));
  const report = await page.evaluate(() => ({
    longestTaskMs: Math.round(Math.max(0, ...window.tasks.map(t => t.ms))),
    longTasksOver1s: window.tasks.filter(t => t.ms > 1000).length,
    worstInputWaitMs: Math.round(Math.max(0, ...window.lateness)),
  }));
  await page.screenshot({ path: `work/app-${process.argv[3] ?? 'shot'}.png` });
  console.log(JSON.stringify({ dist: process.argv[2], drawnMs, ...report }));
} finally { await browser.close(); await new Promise(r => server.close(r)); }
