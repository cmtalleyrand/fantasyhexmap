/** Pixel regressions and paired construction/paint timings for coastal donor fills. */
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';
const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback;
const source = resolve(arg('--source', '.')), output = resolve(arg('--output', 'work/coast-paint'));
mkdirSync(output, { recursive: true });
const code = buildSync({ stdin: { contents: `
export { buildScene, defaultVisibility } from ${JSON.stringify(resolve(source, 'src/render/scene.ts'))};
export { resolveStyle } from ${JSON.stringify(resolve(source, 'src/render/styles.ts'))};
export { drawScene } from ${JSON.stringify(resolve(source, 'src/render/canvas.ts'))};
export { sceneToSvg } from ${JSON.stringify(resolve(source, 'src/render/svg.ts'))};
export { createMapState } from './shared/layers.ts';
export { hexCorners } from './shared/hex.ts';
export { fixture, options } from './scripts/render-profile-input.ts';
`, resolveDir: resolve('.'), loader: 'ts' }, bundle: true, write: false, format: 'iife', globalName: 'api', loader: { '.woff2': 'dataurl' } }).outputFiles[0].text;
const browser = await launchBrowser();
try {
  const context = await browser.newContext();
  await serveBuild(context, '.', { '/api.js': code });
  const page = await context.newPage(); await page.goto('http://render.test/blank'); await page.addScriptTag({ url: 'http://render.test/api.js' });
  const results = [];
  for (const layout of arg('--layouts', 'peninsula,island,strait').split(',')) for (const irregular of arg('--irregularities', 'Wavy,Ragged,Fractured').split(',')) for (const mode of ['wash', 'tint']) {
    const result = await page.evaluate(async ({ layout, irregular, mode }) => {
      const map = api.createMapState('Coast paint regression', 7, 7); map.id = 'coast-seams'; map.defaultIrregularity = irregular;
      map.layers.base.data = Array.from({ length: 49 }, (_, i) => layout === 'island' ? ([16,17,23,24,30,31].includes(i) ? 'Land' : 'Sea') : layout === 'strait' ? (i % 7 === 3 ? 'Sea' : 'Land') : i % 7 < 3 ? 'Land' : 'Sea');
      map.layers.base.data[24] = layout === 'strait' ? 'Strait' : 'Coastal Land';
      map.hexShapes = { '24': { type: map.layers.base.data[24], land: 70 } };
      map.layers.polities.data = { polities: [{ id: 'a', name: 'A', colour: '#776140' }], owner: map.layers.base.data.map(b => b === 'Sea' ? null : 'a') };
      const size = 40, opts = { size, uniformLand: true, visible: { ...api.defaultVisibility(), polities: true }, labels: false,
        style: api.resolveStyle({ preset: 'parchment', overrides: { grain: false, grid: 'none', water: 'flat', polityStyle: mode } }) };
      const scene = api.buildScene(map, opts), scale = 4;
      const bandWidth = size * (mode === 'wash' ? .6 : .32) * 2;
      const hasBand = p => p.kind === 'group' ? p.prims.some(hasBand) : p.kind === 'path' && p.strokeWidth === bandWidth;
      const bands = scene.prims.filter(p => p.kind === 'group' && p.clip && hasBand(p));
      if (!bands.length) throw Error('Missing polity band');
      const render = s => {
        const c = document.createElement('canvas'); c.width = Math.ceil(scene.width * scale); c.height = Math.ceil(scene.height * scale);
        const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.scale(scale, scale); ctx.fillStyle = s.background; ctx.fillRect(0, 0, scene.width, scene.height); api.drawScene(ctx, s, undefined, true);
        return { canvas: c, pixels: ctx.getImageData(0, 0, c.width, c.height).data };
      };
      // One realm owns every land cell. Its band must equal the complete shore
      // stroke clipped only to the FINAL land, regardless of the source patches.
      const referenceScene = { ...scene, prims: scene.prims.map(p => bands.includes(p) ? { ...p, clip: undefined } : p) };
      const actual = render(scene), reference = render(referenceScene);
      const findLandClip = ps => { for (const p of ps) if (p.kind === 'group') { if (p.clipRule === 'evenodd' && p.clip) return p.clip; const d = findLandClip(p.prims); if (d) return d; } };
      const clip = findLandClip(scene.prims);
      const mask = render({ ...scene, background: '#000', prims: [{ kind: 'path', d: clip, fill: '#fff', fillRule: 'evenodd' }] });
      const sourceMask = render({ ...scene, background: '#000', prims: map.layers.base.data.flatMap((b, i) => b === 'Sea' || b === 'Strait' ? [] : [{ kind: 'polygon', points: api.hexCorners(i % 7, Math.floor(i / 7), size), fill: '#fff' }]) });
      const interior = i => [-2, 0, 2].every(dy => [-2, 0, 2].every(dx => mask.pixels[i + (dy * actual.canvas.width + dx) * 4] === 255));
      let bandGaps = 0, maxBandDelta = 0;
      for (let y = size * scale * 2; y < actual.canvas.height - size * scale * 2; y++) for (let x = size * scale * 2; x < actual.canvas.width - size * scale * 2; x++) {
        const i = (y * actual.canvas.width + x) * 4;
        if (!interior(i)) continue;
        const delta = Math.max(...[0, 1, 2].map(c => Math.abs(actual.pixels[i + c] - reference.pixels[i + c])));
        if (delta > 3) bandGaps++;
        maxBandDelta = Math.max(maxBandDelta, delta);
      }
      // Remove the bands to isolate the translucent donor surface. The new
      // ground beyond the source land hexes must be one uniform tint.
      const surfaceScene = { ...scene, prims: scene.prims.filter(p => !bands.includes(p) && !(p.kind === 'path' && p.stroke === opts.style.palette.coast)) };
      const surface = render(surfaceScene);
      // A dry source-cell centre supplies the independent uniform-colour reference.
      const landCell = map.layers.base.data.findIndex(b => b === 'Land');
      const centre = api.hexCorners(landCell % 7, Math.floor(landCell / 7), size).reduce((p, q) => ({ x: p.x + q.x / 6, y: p.y + q.y / 6 }), { x: 0, y: 0 });
      const sample = (Math.floor(centre.y * scale) * surface.canvas.width + Math.floor(centre.x * scale)) * 4;
      const expected = Array.from(surface.pixels.slice(sample, sample + 3));
      let tintSeams = 0, maxTintDelta = 0;
      if (mode === 'tint') for (let y = size * scale * 2; y < surface.canvas.height - size * scale * 2; y++) for (let x = Math.ceil(size * Math.sqrt(3) * 3.05 * scale); x < surface.canvas.width - 4; x++) {
        const i = (y * surface.canvas.width + x) * 4;
        if (!interior(i) || sourceMask.pixels[i] !== 0) continue;
        const delta = Math.max(...expected.map((v, c) => Math.abs(v - surface.pixels[i + c])));
        if (delta > 3) tintSeams++;
        maxTintDelta = Math.max(maxTintDelta, delta);
      }
      // Exercise SVG too: its clip winding/coordinate rounding is independent of Canvas.
      const svgRender = async s => {
        const img = new Image(); img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(api.sceneToSvg(s, 'Coast paint')))); await img.decode();
        const c = document.createElement('canvas'); c.width = actual.canvas.width; c.height = actual.canvas.height;
        const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, c.width, c.height);
        return { canvas: c, pixels: ctx.getImageData(0, 0, c.width, c.height).data };
      };
      const svgActual = await svgRender(scene), svgReference = await svgRender(referenceScene), svgSurface = await svgRender(surfaceScene);
      let svgBandGaps = 0, svgTintSeams = 0;
      const svgExpected = Array.from(svgSurface.pixels.slice(sample, sample + 3));
      for (let y = size * scale * 2; y < actual.canvas.height - size * scale * 2; y++) for (let x = size * scale * 2; x < actual.canvas.width - size * scale * 2; x++) {
        const i = (y * actual.canvas.width + x) * 4;
        if (!interior(i)) continue;
        if (Math.max(...[0, 1, 2].map(c => Math.abs(svgActual.pixels[i + c] - svgReference.pixels[i + c]))) > 3) svgBandGaps++;
        if (mode === 'tint' && sourceMask.pixels[i] === 0 && Math.max(...svgExpected.map((v, c) => Math.abs(v - svgSurface.pixels[i + c]))) > 3) svgTintSeams++;
      }
      return { layout, irregular, mode, bandGaps, maxBandDelta, tintSeams, maxTintDelta, svgBandGaps, svgTintSeams, surface: surface.canvas.toDataURL().split(',')[1], canvas: actual.canvas.toDataURL().split(',')[1], svg: svgActual.canvas.toDataURL().split(',')[1] };
    }, { layout, irregular, mode });
    for (const type of ['canvas', 'svg', 'surface']) { writeFileSync(resolve(output, `${layout}-${irregular}-${mode}-${type}.png`), Buffer.from(result[type], 'base64')); delete result[type]; }
    results.push(result); console.log(JSON.stringify(result));
  }
  writeFileSync(resolve(output, 'pixels.json'), JSON.stringify(results, null, 2) + '\n');
  if (process.argv.includes('--check') && results.some(r => r.bandGaps || r.tintSeams || r.svgBandGaps || r.svgTintSeams)) throw Error('Coastal paint pixel regression');
  await context.close();
} finally { await browser.close(); }
