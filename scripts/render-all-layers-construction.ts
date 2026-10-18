/** Pure Node construction comparison; excludes browser fonts and painting. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fixture, options, buildScene } from './render-all-layers-fixture.ts';
const baseline = await import(pathToFileURL(resolve(process.argv[2] || 'work/baseline','src/render/scene.ts')).href);
const results = [];
for (let run=0;run<3;run++) {
  const map=fixture(`all-layer-performance${run}`), opts=options(), scenes:Record<string,string>={}, times:Record<string,number>={};
  const versions = run%2 ? ['current','baseline'] : ['baseline','current'];
  for (const version of versions) {
    const input=structuredClone(map), start=performance.now();
    const scene=(version==='current'?buildScene:baseline.buildScene)(input,opts);
    times[version]=performance.now()-start;
    scenes[version]=createHash('sha256').update(JSON.stringify(scene)).digest('hex');
  }
  assert.equal(scenes.current,scenes.baseline,`seed ${run}`);
  results.push({run,order:versions,times,hash:scenes.current,identical:true});
  console.log(JSON.stringify(results.at(-1)));
}
writeFileSync('work/all-layers-construction.json',JSON.stringify({baseline:process.argv[3] || 'c6bced3',scope:'Node construction only; no browser font measurement or painting',results},null,2)+'\n');
