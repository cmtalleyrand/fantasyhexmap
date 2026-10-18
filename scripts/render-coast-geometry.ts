/** Full-scene equivalence without a browser. Pixel checks remain a separate browser gate. */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, options, coastGallery } from './render-profile-input.ts';
const arg = (name: string, fallback: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback;
if (!process.argv.includes('--reference')) throw Error('Pass --reference <baseline checkout>');
const before = await import(pathToFileURL(resolve(arg('--reference', '.'), 'src/render/scene.ts')).href);
const after = await import('../src/render/scene.ts');
const records = [];
for (const { name, map } of [{ name: 'populated', map: fixture() }, { name: 'feature', map: fixture('feature') }, ...coastGallery()]) {
  const opts = options();
  if (name !== 'populated') { opts.labels = false; opts.visible = { base: true } as typeof opts.visible; }
  const initial = [...map.layers.base.data!];
  const hex = initial.findIndex((value, i) => (value === 'Land' || value === 'Coastal Land') && (initial[i-1] === 'Sea' || initial[i+1] === 'Sea'));
  for (const edit of [false, true]) {
    if (edit && hex >= 0) { map.layers.base = { ...map.layers.base, data: [...initial] }; map.layers.base.data![hex] = 'Sea'; }
    const a = JSON.stringify(before.buildStaticScene(structuredClone(map), opts));
    const b = JSON.stringify(after.buildStaticScene(structuredClone(map), opts));
    const identical = a === b;
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    records.push({ name, edit, identical, before: hash(a), after: hash(b) });
    if (!identical) throw Error(`Geometry changed: ${name}, edit=${edit}`);
  }
  console.log(`${name}: initial and edited scenes identical`);
}
const output = resolve(arg('--output', 'work/render-coast-geometry'));
mkdirSync(output, { recursive: true });
writeFileSync(resolve(output, 'results.json'), JSON.stringify(records, null, 2));
