/** Reproduce single-edge coast comparisons against a git-archived baseline. */
import assert from 'node:assert/strict';
import { sceneImage, verifySceneImages } from './scene-image-comparison.mjs';
import { buildSync } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';
const arg = (name, fallback) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : fallback;
const baseline = resolve(arg('--baseline', 'work/coast-concentration/baseline'));
const output = resolve(arg('--output', 'work/coast-concentration'));
const baselineCommit = execFileSync('git', ['rev-parse', arg('--baseline-ref', 'origin/main')], { encoding: 'utf8' }).trim();
mkdirSync(output, { recursive: true });
const bundles = {};
for (const [version, root] of [['before', baseline], ['after', resolve('.')]]) {
  const entry = `export { buildScene, defaultVisibility } from ${JSON.stringify(resolve(root, 'src/render/scene.ts'))};
    export { resolveStyle, NEW_USER_STYLE_CHOICE } from ${JSON.stringify(resolve(root, 'src/render/styles.ts'))};
    export { sceneToSvg } from ${JSON.stringify(resolve(root, 'src/render/svg.ts'))};
    export { createMapState } from ${JSON.stringify(resolve(root, 'shared/layers.ts'))};
    export { hexShapeFor } from ${JSON.stringify(resolve(root, 'shared/types.ts'))};
    export { hexCenter, hexCorners } from ${JSON.stringify(resolve(root, 'shared/hex.ts'))};
    export { coastEdges, surfaceMap } from ${JSON.stringify(resolve(root, 'src/render/coast.ts'))};
    export { shapeCoast, polyArea, areaCoverage } from ${JSON.stringify(resolve(root, 'src/render/footprint.ts'))};
    export { pathPolylines } from ${JSON.stringify(resolve(root, 'src/render/ice.ts'))};`;
  bundles[`/${version}.js`] = buildSync({ stdin: { contents: entry, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, format: 'iife', globalName: `${version}Api`, loader: { '.woff2': 'dataurl' } }).outputFiles[0].text;
}
const browser = await launchBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 1300, height: 1200 }, deviceScaleFactor: 1 });
  await serveBuild(context, '.', bundles);
  const page = await context.newPage();
  await page.goto('http://render.test/blank');
  for (const version of ['before', 'after']) await page.addScriptTag({ url: `http://render.test/${version}.js` });
  const records = await page.evaluate(() => {
    const records = [], cols = 5, rows = 5, size = 30, hex = 12;
    const base = Array.from({ length: cols * rows }, (_, i) =>
      i % cols === 0 || i % cols === cols - 1 || i < cols || i >= cols * (rows - 1) ? 'Sea' : 'Land');
    base[hex] = 'Coastal Land'; base[hex + 1] = 'Sea';
    for (const share of [0.5, 0.8]) for (const strength of [0, 50, 100]) for (const side of [1, 5]) for (const version of ['before', 'after']) {
      const api = version === 'before' ? beforeApi : afterApi;
      const corners = api.hexCorners(2, 2, size), centre = api.hexCenter(2, 2, size), full = api.polyArea(corners);
      const target = { kind: 'inset', share, concentrationSide: side, concentration: strength };
      const shaped = api.shapeCoast(api.coastEdges(base, cols, rows, size), api.surfaceMap(base, cols, rows), size, new Map([[hex, target]]));
      const land = shaped.land.get(hex) ?? [];
      const map = api.createMapState('Single coast concentration', cols, rows);
      map.id = 'single-coast-concentration-evidence'; map.layers.base.data = base.slice();
      map.hexShapes = { [hex]: { type: 'Coastal Land', land: share * 100, concentrationSide: side, concentration: strength } };
      const style = api.resolveStyle(api.NEW_USER_STYLE_CHOICE);
      const scene = api.buildScene(map, { size, visible: { ...api.defaultVisibility(), base: true }, labels: false, style, cache: 'off' });
      const coast = [];
      const gather = prims => { for (const p of prims) { if (p.kind === 'group') gather(p.prims); else if (p.kind === 'path' && p.stroke === style.palette.coast) coast.push(p); } };
      gather(scene.prims);
      const rings = coast.flatMap(p => api.pathPolylines(p.d, 8));
      const ink = Math.max(...coast.map(p => p.strokeWidth ?? 0)) / 2;
      const coverage = api.areaCoverage(rings, { evenOdd: true, stroke: { rings, reach: ink } });
      const mid = e => ({ x: (corners[e].x + corners[(e + 1) % 6].x) / 2, y: (corners[e].y + corners[(e + 1) % 6].y) / 2 });
      const southernHalf = [mid(0), corners[1], corners[2], corners[3], mid(3)];
      let svg = api.sceneToSvg(scene, 'Single coast concentration');
      svg = svg.replace(/<svg\b[^>]*>/, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${centre.x - 43} ${centre.y - 40} 86 80" width="258" height="240">`);
      svg = svg.replace('</svg>', `<polygon points="${corners.map(p => `${p.x},${p.y}`).join(' ')}" fill="none" stroke="#617580" stroke-width="0.35" stroke-dasharray="1.5 1"/></svg>`);
      records.push({ version, share, strength, side, preset: style.preset, knobs: style.knobs, irregularity: api.hexShapeFor('Coastal Land', map.hexShapes[hex], map.defaultIrregularity).irregular, polygonShare: land.reduce((sum, p) => sum + api.polyArea(p), 0) / full,
        renderedShare: coverage(corners, 256) / full, southernHalfShare: coverage(southernHalf, 256) / full,
        compromises: scene.compromises ?? [], svg, land });
    }
    return records;
  });
  const metrics = records.map(({ svg, land, ...r }) => r);
  for (const r of metrics) assert.ok(Math.abs(r.polygonShare - r.share) < 1e-6, `Polygon area: ${JSON.stringify(r)}`);
  const get = (version, share, strength, side) => records.find(r => r.version === version && r.share === share && r.strength === strength && r.side === side);
  for (const r of metrics) assert.ok(Math.abs(r.renderedShare - r.share) < 0.01, `Rendered area: ${JSON.stringify(r)}`);
  for (const share of [0.5, 0.8]) {
    const before = get('before', share, 0, 1);
    for (const strength of [50, 100]) for (const side of [1, 5]) {
      assert.ok(get('before', share, strength, side).land.flat().every((p, i) => Math.hypot(p.x - before.land.flat()[i].x, p.y - before.land.flat()[i].y) < 1e-4), 'Baseline polygon should reproduce concentration cancellation');
    }
    for (const side of [1, 5]) assert.ok(Math.abs(get('after', share, 0, side).southernHalfShare - before.southernHalfShare) < 1e-4, 'Zero concentration should retain the existing coast');
    for (const strength of [50, 100]) {
      assert.ok(get('after', share, strength, 1).southernHalfShare > get('after', share, 0, 1).southernHalfShare + 0.005, 'Concentration should preserve more land towards SE');
      assert.ok(get('after', share, strength, 5).southernHalfShare < get('after', share, 0, 5).southernHalfShare - 0.005, 'Concentration should preserve more land towards NE');
    }
  }
  const comparisons = [];
  for (const share of [0.5, 0.8]) for (const version of ['before', 'after']) {
    const south = get(version, share, 100, 1), north = get(version, share, 100, 5);
    comparisons.push({ version, requestedLandPercent: share * 100,
      towardSELandPercent: south.renderedShare * 100, towardNELandPercent: north.renderedShare * 100,
      southernHalfRedistributionPercentagePoints: (south.southernHalfShare - north.southernHalfShare) * 100 });
  }
  const style = `<style>*{box-sizing:border-box}body{margin:0;background:#f5f3ed;color:#233640;font-family:Arial,sans-serif}.sheet{width:1240px;padding:30px}h1{font-size:26px;margin:0 0 8px}.sub{font-size:15px;color:#59686e;margin-bottom:22px}.grid{display:grid;grid-template-columns:120px repeat(4,1fr);gap:12px}.head{font-size:15px;font-weight:bold;text-align:center;padding:8px}.row{display:flex;flex-direction:column;justify-content:center;font-size:18px}.row small{font-size:13px;color:#647078;margin-top:5px}.card{background:white;border:1px solid #dddcd7;}.card img{display:block;width:100%;height:240px}.metric{font-size:13px;text-align:center;padding:9px;border-top:1px solid #eee}.foot{font-size:13px;color:#59686e;margin-top:18px;line-height:1.5}</style>`;
  for (const share of [0.5, 0.8]) {
    let html = `${style}<div class="sheet"><h1>Single-edge coast · ${share * 100}% land</h1><div class="sub">App defaults: Parchment preset, Ragged coast, no style overrides. Same map, seed and land target. Dashed outline marks the edited hex.</div><div class="grid"><div></div>`;
    for (const label of ['Before · towards SE', 'After · towards SE', 'Before · towards NE', 'After · towards NE']) html += `<div class="head">${label}</div>`;
    for (const strength of [0, 50, 100]) {
      html += `<div class="row">${strength}%<small>concentration</small></div>`;
      for (const [version, side] of [['before', 1], ['after', 1], ['before', 5], ['after', 5]]) {
        const r = get(version, share, strength, side);
        html += `<div class="card">${sceneImage(r.svg, `${version}, ${share * 100}% land, ${strength}% concentration, side ${side}`)}<div class="metric">${(r.renderedShare * 100).toFixed(2)}% coast area</div></div>`;
      }
    }
    html += `</div><div class="foot">Before: current main before this fix. After: endpoint-biased cutting with an area solve. Full scene renderer with default textures, grid, spline fitting and coastline ink.<br>Directions are existing hex sides 1 (SE) and 5 (NE). Both have the same facing relative to the single east coast.</div></div>`;
    await page.setContent(html);
    await page.locator('.card img').evaluateAll(images => Promise.all(images.map(image => image.decode())));
    await verifySceneImages(page);
    await page.locator('.sheet').screenshot({ path: resolve(output, `comparison-${share * 100}.png`) });
    writeFileSync(resolve(output, `comparison-${share * 100}.html`), html);
  }
  writeFileSync(resolve(output, 'results.json'), JSON.stringify({ baselineCommit, browser: browser.version(), imageIsolation: { panels: 24, check: 'Each panel screenshot is byte-identical to its standalone render at the same pixel position.' }, scope: '5x5 enclosed land fixture; center coastal hex has one sea-facing edge (east). App new-user defaults: Parchment preset with no overrides; inherited Ragged coastal irregularity. Identical baseline/candidate inputs. Rendered coverage includes coastline ink; directional redistribution compares southern-half land as a fraction of the whole hex.', comparisons, metrics }, null, 2));
  console.log(JSON.stringify(comparisons, null, 2));
  await context.close();
} finally { await browser.close(); }
