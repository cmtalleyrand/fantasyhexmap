import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = 'work/part34-browser', read = path => JSON.parse(readFileSync(path, 'utf8'));
const metric = values => {
  const a = [...values].sort((a,b)=>a-b);
  return a.length ? { median: a[Math.floor(a.length / 2)], p95: a[Math.ceil(a.length * .95) - 1], max: a.at(-1) } : null;
};
const phases = ['scene.symbols', 'scene.polityLabels', 'scene.featureLabels'];
const construction = read(`${root}/${existsSync(`${root}/construction-final/results.json`) ? 'construction-final' : 'construction'}/results.json`);
const report = { browser: construction.browser, fixtureSha256: createHash('sha256').update(readFileSync('test/fixtures/populated-40.json')).digest('hex'),
  source: {}, production: {}, construction: {}, pixels: {} };
for (const file of ['src/render/scene.ts', 'src/render/coast.ts', 'src/render/cache.ts', 'src/render/placementCache.ts', 'src/render/fontFiles.ts', 'scripts/render-edit-fixtures.ts']) {
  const hash = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
  report.source[file] = { before: hash(`work/part34-baseline/${file}`), after: hash(file) };
}
for (const scenario of ['populated', 'components', 'opacity']) {
  report.production[scenario] = {};
  for (const version of ['before', 'after']) {
    const r = read(`${root}/${version}-${scenario}/results.json`);
    report.production[scenario][version] = { fixtureSha256: r.fixtureSha256, opening: r.opening, edits: r.edits, gates: r.gates,
      navigationTested: r.navigation.length > 0, errors: r.pageErrors,
      openings: r.openings.map(o => ({ run: o.run, cache: o.cache, firstNonblankMs: o.firstNonblankMs, sharpMs: o.sharpMs, layers: o.layers, labels: o.labels })),
      editSamples: r.editSamples.map(e => ({ edit: e.edit, sharpMs: e.sharpMs, input: metric(e.inputs.map(i=>i.duration)),
        frames: metric(e.gaps.map(g=>g.duration)), longTasks: e.tasks.length, builds: e.builds.length })),
      input: metric(r.editSamples.flatMap(e=>e.inputs.map(i=>i.duration))), frames: metric(r.editSamples.flatMap(e=>e.gaps.map(g=>g.duration))),
      navigation: r.navigation.map(n=>({ mobile: n.mobile, moved: n.moved, input: metric(n.inputs.map(i=>i.duration)), frames: metric(n.gaps.map(g=>g.duration)), longTasks: n.tasks.length })) };
  }
  if (scenario !== 'opacity') report.production[scenario].burst = read(`${root}/after-${scenario}/burst.json`);
}
for (const scenario of [...new Set(construction.records.map(r=>r.scenario))]) {
  report.construction[scenario] = {};
  for (const version of ['before', 'after']) {
    const rows = construction.records.filter(r=>r.scenario === scenario && r.version === version);
    report.construction[scenario][version] = { total: metric(rows.map(r=>r.ms)),
      symbolAndLabelPhases: metric(rows.map(r=>r.profile.timings.filter(t=>phases.includes(t.name)).reduce((n,t)=>n+t.duration,0))),
      samples: rows.map(r=>({ run: r.run, ms: r.ms, counters: r.profile.counters })) };
  }
}
const pixelReports = { incremental: read(`${root}/incremental/results.json`), baseline: read(`${root}/baseline-pixels/results.json`) };
const worker = read(`${root}/profiled-opacity/results.json`);
report.workerPlacement = worker.editSamples.flatMap(e=>e.builds).map(b=>({
  coastAndSymbolInputsReused: (b.profile?.counters['coast.cacheHit'] ?? 0) > 0 && !(b.profile?.counters['symbols.revalidatedFits'] ?? 0),
  counters: b.profile?.counters }));
const eligibleWorker = report.workerPlacement.filter(b=>b.coastAndSymbolInputsReused);
if (!eligibleWorker.length || eligibleWorker.some(b => !b.counters ||
  (b.counters['placement.searches'] ?? 0) || (b.counters['symbols.searches'] ?? 0) ||
  (b.counters['placement.cacheHits'] ?? 0) < 6 || !(b.counters['symbols.cacheHits'] > 0))) throw Error('The actual worker did not reuse eligible placements');
for (const [name, r] of Object.entries(pixelReports)) report.pixels[name] = { cases: r.records.length,
  comparisons: r.records.reduce((n,r)=>n+r.images.length,0), identicalScenes: r.records.every(r=>r.identicalScene),
  changedPixels: r.records.reduce((n,r)=>n+r.images.reduce((n,i)=>n+i.changedPixels,0),0),
  nonemptyFitCoastMasks: r.records.every(r=>r.images.filter(i=>i.mode === 'coast' && i.zoom === 'fit').every(i=>i.coastInkPixels > 0)) };
writeFileSync('docs/render-browser-parts-3-4-results.json', JSON.stringify(report, null, 2));
writeFileSync('docs/render-coast-browser-parts-3-4-results.json', JSON.stringify(pixelReports, null, 2));
copyFileSync('work/part34-coast-geometry/results.json', 'docs/render-coast-geometry-parts-3-4-results.json');
copyFileSync(`${root}/baseline-pixels/strait-share-Fractured-edited-coast-worker-4-dpr2-after.png`, 'docs/render-incremental-strait-4x-dpr2.png');
console.log(JSON.stringify({ production: Object.fromEntries(Object.entries(report.production).map(([k,r])=>[k, { before: r.before.edits, after: r.after.edits }])), pixels: report.pixels }, null, 2));
