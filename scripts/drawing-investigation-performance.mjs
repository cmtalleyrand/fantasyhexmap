/** Matched before/after timings, alternating order, using repository fixtures. */
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';
const arg=(k,d)=>process.argv.includes(k)?process.argv[process.argv.indexOf(k)+1]:d;
const output=resolve(arg('--output','work/hypotheses/performance'));mkdirSync(output,{recursive:true});
const scenarios=arg('--scenario','cold,warm,ownership,shore').split(',');
if(scenarios.some(s=>!['cold','warm','ownership','shore'].includes(s)))throw Error('Unknown --scenario');
console.log('Measured scenarios:',scenarios);
const bundles={};
for(const [name,root]of [['before',arg('--baseline','work/hypotheses/baseline')],['after','.']]){
 const contents=`export { fixture, options } from ${JSON.stringify(resolve('scripts/render-profile-input.ts'))};
 export { buildStaticScene, symbolsOf } from ${JSON.stringify(resolve(root,'src/render/scene.ts'))};
 export { loadLettering } from ${JSON.stringify(resolve(root,'src/render/fontFiles.ts'))};
 export { beginRenderProfile, endRenderProfile } from ${JSON.stringify(resolve(root,'src/render/profile.ts'))};`;
 bundles[`/${name}.js`]=buildSync({stdin:{contents,resolveDir:resolve('scripts'),loader:'ts'},bundle:true,write:false,format:'iife',globalName:`${name}Api`,loader:{'.woff2':'dataurl'}}).outputFiles[0].text;
}
const browser=await launchBrowser();
try{
 const context=await browser.newContext();await serveBuild(context,'.',bundles);const page=await context.newPage();await page.goto('http://render.test/blank');
 for(const name of ['before','after'])await page.addScriptTag({url:`http://render.test/${name}.js`});
 const results=await page.evaluate(async({runs,coldRuns,scenarios})=>{
  const opts=afterApi.options();await beforeApi.loadLettering(opts.style.knobs.lettering);await afterApi.loadLettering(opts.style.knobs.lettering);await document.fonts.ready;
  const records=[];
  for(const scenario of scenarios){
   const base=afterApi.fixture('populated'), maps={before:structuredClone(base),after:structuredClone(base)};
   const count=scenario==='cold'?coldRuns:runs;
   for(let run=0;run<count;run++){
    for(const [version,api]of(run%2?[['after',afterApi],['before',beforeApi]]:[['before',beforeApi],['after',afterApi]])){
     const map=maps[version];
     if(scenario==='cold')map.id=`cold-${run}`;
     if(scenario==='ownership'){
      const p=map.layers.polities.data, owner=[...p.owner],hex=owner.findIndex((o,i)=>o&&map.layers.base.data[i]==='Land');
      owner[hex]=run%2?p.polities[0].id:p.polities.at(-1).id;map.layers.polities={...map.layers.polities,data:{...p,owner}};
     }
     if(scenario==='shore'){
      const data=[...map.layers.base.data],hex=base.layers.base.data.findIndex((v,i)=>v==='Land'&&base.layers.base.data[i+1]==='Sea');
      data[hex]=run%2?'Land':'Coastal Land';map.layers.base={...map.layers.base,data};
     }
     api.beginRenderProfile();const start=performance.now();const scene=api.buildStaticScene(map,{...opts,polityOpacity:run%2?.55:.35});const ms=performance.now()-start;
     const profile=api.endRenderProfile();records.push({scenario,version,run,ms,profile,symbolCount:api.symbolsOf(scene)?.length??0});
    }
   }
  }
  return records;
 },{runs:Number(arg('--runs','20')),coldRuns:Number(arg('--cold-runs','5')),scenarios});
 const summary=[];
 for(const scenario of scenarios)for(const version of ['before','after']){
  const rows=results.filter(r=>r.scenario===scenario&&r.version===version&&(scenario==='cold'||r.run>1));
  const values=rows.map(r=>r.ms).sort((a,b)=>a-b);
  summary.push({scenario,version,n:values.length,median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1]});
 }
 writeFileSync(resolve(output,'results.json'),JSON.stringify({browser:browser.version(),baseline:arg('--baseline','work/hypotheses/baseline'),scenarios,summary,records:results},null,2));console.log(JSON.stringify(summary,null,2));
 if(process.argv.includes('--check'))for(const scenario of scenarios){
  const before=summary.find(r=>r.scenario===scenario&&r.version==='before');
  const after=summary.find(r=>r.scenario===scenario&&r.version==='after');
  for(const metric of ['median','p95'])if(after[metric]>before[metric]*(scenario==='cold'?1.1:1))throw Error(`${scenario} ${metric} regressed: ${before[metric]} -> ${after[metric]}`);
 }
 await context.close();
}finally{await browser.close();}
