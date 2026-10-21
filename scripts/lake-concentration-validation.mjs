/** Actual-default lake concentration, coverage, fill/outline and image isolation checks. */
import assert from 'node:assert/strict';
import { sceneImage, verifySceneImages } from './scene-image-comparison.mjs';
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';
const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const output = resolve(arg('--output', 'work/coast-concentration'));
const surrounding = arg('--surrounding', 'Land');
assert.ok(['Land', 'Coastal Land'].includes(surrounding), 'Use Land or Coastal Land for --surrounding');
mkdirSync(output, { recursive: true });
const contents = `export { buildScene, defaultVisibility } from './src/render/scene.ts';
export { resolveStyle, NEW_USER_STYLE_CHOICE } from './src/render/styles.ts';
export { sceneToSvg } from './src/render/svg.ts';
export { createMapState } from './shared/layers.ts';
export { hexCenter, hexCorners, neighbourOf } from './shared/hex.ts';
export { areaCoverage, polyArea } from './src/render/footprint.ts';
export { pathPolylines } from './src/render/ice.ts';`;
const bundle = buildSync({ stdin: { contents, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, write: false,
  format: 'iife', globalName: 'api', loader: { '.woff2': 'dataurl' } }).outputFiles[0].text;
const browser = await launchBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 850, height: 1250 }, deviceScaleFactor: 1 });
  await serveBuild(context, '.', { '/api.js': bundle });
  const page = await context.newPage(); await page.goto('http://render.test/blank'); await page.addScriptTag({ url: 'http://render.test/api.js' });
  const records = await page.evaluate(surrounding => {
    const records = [], size = 30, h = 12, style = api.resolveStyle(api.NEW_USER_STYLE_CHOICE);
    const corners = api.hexCorners(2, 2, size), centre = api.hexCenter(2, 2, size), full = api.polyArea(corners);
    const eastHalf = [corners[5], corners[0], corners[1], corners[2]];
    for (const share of [0.2, 0.4, 0.8]) for (const strength of [0, 50, 100]) for (let side = 0; side < 6; side++) {
      const map = api.createMapState('Lake concentration defaults', 5, 5);
      map.id = 'lake-concentration-evidence'; map.layers.base.data = Array(25).fill('Land'); map.layers.base.data[h] = 'Lake';
      for (let edge = 0; edge < 6; edge++) {
        const n = api.neighbourOf(2, 2, edge);
        map.layers.base.data[n.row * 5 + n.col] = surrounding;
      }
      map.hexShapes = { [h]: { type: 'Lake', land: share * 100, concentrationSide: side, concentration: strength } };
      const scene = api.buildScene(map, { size, style, visible: api.defaultVisibility(), labels: false, cache: 'off' });
      const fills = [], strokes = [];
      const gather = ps => { for (const p of ps) { if (p.kind === 'group') gather(p.prims); else if (p.kind === 'path') {
        if (p.fill === style.palette.lake) fills.push(p);
        if (p.stroke === style.palette.coast) strokes.push(p);
      } } };
      gather(scene.prims);
      const lake = fills.flatMap(p => p.d), shore = strokes.flatMap(p => p.d);
      const rings = api.pathPolylines(lake, 12), ink = Math.max(...strokes.map(p => p.strokeWidth)) / 2;
      const frame = [{ x: -30, y: -30 }, { x: 350, y: -30 }, { x: 350, y: 350 }, { x: -30, y: 350 }];
      const coverage = api.areaCoverage([frame, ...rings], { evenOdd: true, stroke: { rings: api.pathPolylines(shore, 12), reach: ink } });
      let svg = api.sceneToSvg(scene, 'Lake concentration defaults');
      svg = svg.replace(/<svg\b[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${centre.x - 40} ${centre.y - 40} 80 80" width="300" height="300">`);
      svg = svg.replace('</svg>', `<polygon points="${corners.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#617580" stroke-width="0.35" stroke-dasharray="1.5 1"/></svg>`);
      records.push({ surrounding, share, strength, side, renderedShare: coverage(corners, 256) / full, eastHalfShare: coverage(eastHalf, 256) / full,
        sameFillAndShore: JSON.stringify(lake) === JSON.stringify(shore), compromises: scene.compromises ?? [], svg });
    }
    return records;
  }, surrounding);
  writeFileSync(resolve(output, 'lake-results.json'), JSON.stringify({ scope: `54 actual-default Parchment scenes; single central Lake surrounded by ${surrounding}; inherited Ragged lake irregularity; coverage includes shoreline ink.`, records: records.map(({ svg, ...r }) => r) }, null, 2));
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  for (const r of records) {
    check(r.sameFillAndShore, `Lake fill/outline mismatch: ${JSON.stringify({ ...r, svg: undefined })}`);
    check(Math.abs(r.renderedShare - r.share) < 0.01, `Lake area error: ${JSON.stringify({ ...r, svg: undefined })}`);
  }
  for (const share of [0.2, 0.4, 0.8]) {
    const get = (strength, side) => records.find(r => r.share === share && r.strength === strength && r.side === side);
    for (let side = 1; side < 6; side++) check(Math.abs(get(0, side).eastHalfShare - get(0, 0).eastHalfShare) < 1e-6, 'Zero concentration must ignore side');
    for (const strength of [50, 100]) check(get(strength, 0).eastHalfShare > get(strength, 3).eastHalfShare + 0.01, 'Lake land must redistribute towards the selected side');
  }
  for (const share of [0.2, 0.4, 0.8]) {
    let html = `<style>*{box-sizing:border-box}body{margin:0;background:#f5f3ed;font:15px Arial;color:#233640}.sheet{width:800px;padding:24px}h1{font-size:25px}.grid{display:grid;grid-template-columns:120px 300px 300px;gap:12px}.row{align-self:center}.card img{display:block;width:300px;height:300px}.metric{text-align:center;background:white;padding:8px}.sub{line-height:1.5;margin-bottom:20px}</style><div class="sheet"><h1>Lake · ${share * 100}% land · actual defaults</h1><div class="sub">Parchment preset, inherited Ragged lake shore, no style overrides. Surrounding hexes: ${surrounding}.<br>Columns change concentration direction; rows change its strength.</div><div class="grid"><div></div><b>Land towards east</b><b>Land towards west</b>`;
    for (const strength of [0, 50, 100]) {
      html += `<div class="row">${strength}%<br>concentration</div>`;
      for (const side of [0, 3]) {
        const r = records.find(r => r.share === share && r.strength === strength && r.side === side);
        html += `<div class="card">${sceneImage(r.svg, `Lake, ${share * 100}% land, ${strength}% concentration, side ${side}`)}<div class="metric">${(r.renderedShare * 100).toFixed(2)}% coast area</div></div>`;
      }
    }
    html += '</div></div>';
    await page.setContent(html); await page.locator('img').evaluateAll(images => Promise.all(images.map(i => i.decode())));
    await verifySceneImages(page);
    await page.locator('.sheet').screenshot({ path: resolve(output, `lake-comparison-${share * 100}.png`) });
    writeFileSync(resolve(output, `lake-comparison-${share * 100}.html`), html);
  }
  writeFileSync(resolve(output, 'lake-results.json'), JSON.stringify({ scope: `54 actual-default Parchment scenes; single central Lake with six ${surrounding} neighbours; inherited Ragged lake irregularity; coverage includes shoreline ink.`, failures, records: records.map(({ svg, ...r }) => r) }, null, 2));
  console.log(JSON.stringify({ surrounding, failures: failures.length, verifiedStandalonePanels: 18, scenes: records.length, maxAreaErrorPercentagePoints: Math.max(...records.map(r => Math.abs(r.renderedShare - r.share) * 100)), fillAndShoreMatch: records.every(r => r.sameFillAndShore) }));
  await context.close();
  assert.equal(failures.length, 0, `${failures.length} lake validation failures; images and diagnostics saved to ${output}. First failure: ${failures[0]}`);
} finally { await browser.close(); }
