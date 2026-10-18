/** Prepare baseline/current browser fixtures without installing a browser driver. */
import { build } from 'esbuild';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { browserWorkerPlugin } from './browser-worker-plugin.mjs';
const baseline = resolve(process.argv[2] || 'work/baseline');
mkdirSync('work/comparison', { recursive: true });
for (const [label, source] of [['before', baseline], ['after', resolve('.')]]) {
  const contents = readFileSync('scripts/render-browser-fixture.tsx', 'utf8')
    .replace(/(['"])\.\.\/(src|shared)\/([^'"]+)\1/g, (_, _q, dir, file) => JSON.stringify(resolve(source, dir, file)))
    + `\nexport { fixture, options } from ${JSON.stringify(resolve('scripts/render-all-layers-fixture.ts'))};`
    + `\nexport { loadLettering } from ${JSON.stringify(resolve(source, 'src/render/fontFiles.ts'))};`;
  await build({ stdin: { contents, sourcefile: 'fixture.tsx', resolveDir: resolve('scripts'), loader: 'tsx' },
    bundle: true, format: 'iife', globalName: `${label}Api`, jsx: 'automatic', loader: { '.woff2': 'dataurl' },
    plugins: [browserWorkerPlugin()], outfile: `work/comparison/${label}.js` });
}
