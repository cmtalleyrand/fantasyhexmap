/** Render the same sixteen diagnostic inputs used by the passage regressions. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { lakeStraitFixture, LAKE_STRAIT_CASES } from '../test/fixtures/lakeStrait.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import { sceneToSvg } from '../src/render/svg.ts';
import { resolveStyle } from '../src/render/styles.ts';
import { areaCoverage } from '../src/render/footprint.ts';
import { pathPolylines } from '../src/render/ice.ts';
import { hexCorners, hexCenter } from '../shared/hex.ts';
import { CHANNEL_WIDTH_PERCENT } from '../shared/types.ts';
const out = process.argv[2] ?? 'work/lake-strait-review';
const version = process.argv[3] ?? 'Revised renderer';
mkdirSync(out, { recursive: true });
const style = resolveStyle({ preset: 'parchment', overrides: { grid: 'none' } });
const sides = ['E', 'SE', 'SW', 'W', 'NW', 'NE'];
let html = `<!doctype html><meta charset="utf-8"><title>Lake straits: 16 representative cases</title>
<style>body{margin:20px;font:14px Arial;background:#172027;color:#eee}h1{font-size:24px;margin:0 0 10px}.grid{display:grid;grid-template-columns:repeat(4,248px);gap:16px}section{width:248px}h2{font-size:14px;min-height:32px;font-weight:500;margin:0 0 6px}svg{width:248px;height:242px;display:block}section p{font-size:12px;min-height:28px;margin:6px 0;color:#c5cdd1}.note{color:#f3c773;font-size:14px;margin-bottom:20px}</style>
<h1>Lake straits: 16 representative cases — ${version}</h1><p>Widths: Very narrow 5%, Narrow 15%, Normal 30%, Wide 50%. Junction: Middle, E, SE, SW, W, NW, NE.</p>
<p>Irregularity: Smooth, Wavy, Ragged, Fractured. Land share: Natural, or 0–100% in steps of 5%.</p>
<p class="note">One fixed diagnostic layout and seed, not your original saved map. Same inputs in both versions. Yellow: selected hex.</p><div class="grid">`;
const examples = process.argv.includes('--irregularity')
  ? (['Smooth', 'Wavy', 'Ragged', 'Fractured'] as const).map(irregular => ({ width: 'Narrow' as const, irregular, side: undefined, land: undefined }))
  : LAKE_STRAIT_CASES;
if (process.argv.includes('--irregularity')) html = html
  .replace('Lake straits: 16 representative cases —', 'Lake straits: irregularity comparison —')
  .replace('One fixed diagnostic layout and seed, not your original saved map. Same inputs in both versions. Yellow: selected hex.',
    'Same diagnostic map, seed, width and junction. Surrounding lake held Smooth; only the selected strait changes. Yellow: selected hex.');
for (const [index, example] of examples.entries()) {
  const map = lakeStraitFixture(example), size = 30;
  // Hold the surrounding lake fixed: only the selected strait's irregularity
  // changes in this comparison, so its own detail must carry the difference.
  if (process.argv.includes('--irregularity')) map.defaultLakeIrregularity = 'Smooth';
  const scene = buildScene(map, { size, visible: defaultVisibility(), labels: false, style, selection: [24] });
  const label = `${index + 1}. ${example.width} ${CHANNEL_WIDTH_PERCENT[example.width]}% · ${example.side === undefined ? 'Middle' : sides[example.side]}`;
  const detail = `${example.land === undefined ? 'Natural land' : `${example.land}% land`} · ${example.irregular}`;
  const c = hexCenter(3, 3, size);
  const svg = sceneToSvg(scene, `${label}; ${detail}`)
    .replace(/viewBox="[^"]*"/, `viewBox="${c.x - 90} ${c.y - 90} 180 180"`)
    .replace(/width="[^"]*" height="[^"]*"/, 'width="248" height="242"')
    .replace(/id="([^"]*)"/g, `id="case${index}-$1"`).replace(/url\(#([^)]*)\)/g, `url(#case${index}-$1)`);
  // Measure both versions independently: the original renderer's own
  // compromise reports are part of the bug and cannot be used as evidence.
  const rings = scene.prims.flatMap(p => p.kind === 'path' && p.fill === style.palette.lake ? pathPolylines(p.d, 12) : []);
  const page = [{ x: -size, y: -size }, { x: 500, y: -size }, { x: 500, y: 500 }, { x: -size, y: 500 }];
  const ink = Math.max(.8, size * style.palette.coastWidth * style.knobs.lineWeight) / 2;
  const share = areaCoverage([page, ...rings], { evenOdd: true, stroke: { rings, reach: ink } })(hexCorners(3, 3, size), 192) / (1.5 * Math.sqrt(3) * size * size);
  const note = example.land !== undefined && Math.abs(share - example.land / 100) > .01
    ? `${Math.round(share * 100)}% land drawn instead of ${example.land}%` : '';
  html += `<section><h2>${label}<br>${detail}</h2>${svg}<p>${note ?? ''}</p></section>`;
}
writeFileSync(`${out}/gallery.html`, html + '</div>');
console.log(`${out}/gallery.html`);
