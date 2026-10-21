/** Compare the same lake with Land versus Coastal Land in its six neighbouring hexes. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser } from './browser-runtime.mjs';
import { verifySceneImages } from './scene-image-comparison.mjs';
const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const root = resolve(arg('--output', 'work/coast-concentration'));
const share = Number(arg('--land', '40'));
const inputs = ['land', 'coastal-land'].map(dir => {
  const html = readFileSync(resolve(root, dir, `lake-comparison-${share}.html`), 'utf8');
  const images = [...html.matchAll(/<img\b[^>]*src="([^"]+)"/g)].map(m => m[1]);
  assert.equal(images.length, 6);
  return { images, results: JSON.parse(readFileSync(resolve(root, dir, 'lake-results.json'), 'utf8')) };
});
let html = `<style>*{box-sizing:border-box}body{margin:0;background:#f5f3ed;color:#233640;font:15px Arial}.sheet{width:800px;padding:24px}h1{font-size:24px;line-height:30px;margin:0 0 12px}.sub{line-height:22px;margin-bottom:18px}.grid{display:grid;grid-template-columns:120px 300px 300px;gap:12px;line-height:18px}.row{align-self:center}.card img{display:block;width:300px;height:300px}.metric{text-align:center;background:white;padding:8px}.foot{line-height:1.5;margin-top:16px}</style><div class="sheet"><h1>Lake shore: Land vs Coastal Land</h1><div class="sub">${share}% land target in the lake hex. Same seed, Parchment defaults and eastward concentration.<br>Only the six adjacent hexes change type. Both inherit Ragged lake shores.</div><div class="grid"><div></div><b>Neighbours: Land</b><b>Neighbours: Coastal Land</b>`;
for (let i = 0; i < 3; i++) {
  const strength = i * 50;
  html += `<div class="row">${strength}%<br>concentration</div>`;
  for (const input of inputs) {
    const record = input.results.records.find(r => r.share === share / 100 && r.strength === strength && r.side === 0);
    html += `<div class="card"><img src="${input.images[i * 2]}"><div class="metric">${(record.renderedShare * 100).toFixed(2)}% coast area</div></div>`;
  }
}
html += `<div class="foot" style="grid-column:1/-1">Coastal Land also requests 80% land in each adjacent hex. The default coastline irregularity stays Ragged.<br>The broader Coastal Land fixture fails 29 of 54 area checks; these unretouched panels show the selected eastward cases.</div></div></div>`;
const browser = await launchBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 850, height: 1400 }, deviceScaleFactor: 1 });
  const page = await context.newPage(); await page.setContent(html);
  await page.locator('img').evaluateAll(images => Promise.all(images.map(i => i.decode())));
  await verifySceneImages(page);
  await page.locator('.sheet').screenshot({ path: resolve(root, `lake-neighbour-comparison-${share}.png`) });
  writeFileSync(resolve(root, `lake-neighbour-comparison-${share}.html`), html);
  await context.close();
} finally { await browser.close(); }
