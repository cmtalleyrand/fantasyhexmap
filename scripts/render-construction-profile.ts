/** Node-only construction diagnostic. Browser opening/transfer timings use the separate app runner. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { fixture, options } from './render-profile-input.ts';
const arg = (name: string, fallback: string) => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1]! : fallback;
const root = resolve(arg('--root', '.')), output = resolve(arg('--output', 'work/render-construction'));
if (!process.argv.includes('--sample')) {
  mkdirSync(output, { recursive: true });
  const samples = [];
  for (let run = 0; run < Number(arg('--runs', '10')); run++) {
    const samplePath = resolve(output, `sample-${run}.json`), fd = openSync(samplePath, 'w');
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--sample', '--root', root,
      '--kind', arg('--kind', 'populated'), '--edits', run === 0 ? arg('--edits', '20') : '0', ...(process.argv.includes('--profile') ? ['--profile'] : [])], { stdio: ['ignore', fd, 'inherit'] });
    try { await new Promise<void>((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(`Sample exited ${code}`))); }); } finally { closeSync(fd); }
    const sample = JSON.parse(readFileSync(samplePath, 'utf8'));
    samples.push(sample);
    console.log(JSON.stringify({ run, coldMs: sample.cold.ms, editMs: sample.edits.map((e: {ms: number}) => e.ms) }));
  }
  const q = (values: number[]) => { const a = [...values].sort((a,b) => a-b); return a.length ? { median: a[Math.floor(a.length / 2)], p95: a[Math.ceil(a.length * .95) - 1], max: a.at(-1) } : null; };
  const report = { root, runtime: process.version, kind: arg('--kind', 'populated'),
    fixtureSha256: createHash('sha256').update(readFileSync('test/fixtures/populated-40.json')).digest('hex'),
    cold: q(samples.map(s => s.cold.ms)), edits: q(samples.flatMap(s => s.edits.map((e: {ms: number}) => e.ms))), samples };
  writeFileSync(resolve(output, 'results.json'), JSON.stringify(report, null, 2));
} else {
  const { buildStaticScene } = await import(pathToFileURL(resolve(root, 'src/render/scene.ts')).href);
  const profiling = process.argv.includes('--profile');
  const profileApi = profiling ? await import(pathToFileURL(resolve(root, 'src/render/profile.ts')).href) : null;
  const map = fixture(arg('--kind', 'populated')), opts = options();
  if (arg('--kind', 'populated') !== 'populated') { opts.labels = false; opts.visible = { base: true } as typeof opts.visible; }
  const run = () => {
    profileApi?.beginRenderProfile(); const start = performance.now();
    const scene = buildStaticScene(map, opts), ms = performance.now() - start;
    const profile = profileApi?.endRenderProfile();
    // Serialization is outside the construction timer.
    const json = JSON.stringify(scene);
    return { ms, hash: createHash('sha256').update(json).digest('hex'), sceneBytes: Buffer.byteLength(json), compromises: scene.compromises ?? [], ...(profile ? { profile } : {}) };
  };
  const cold = run(), edits = [];
  const original = [...map.layers.base.data!];
  const hex = original.findIndex((value, i) => value === 'Land' && (original[i-1] === 'Sea' || original[i+1] === 'Sea'));
  if (hex < 0) throw Error('Fixture has no exposed mainland hex');
  for (let i = 0; i < Number(arg('--edits', '20')); i++) {
    map.layers.base = { ...map.layers.base, data: [...original] };
    map.layers.base.data![hex] = i % 2 ? original[hex]! : 'Land';
    edits.push({ hex, ...run() });
  }
  console.log(JSON.stringify({ cold, edits }));
}
