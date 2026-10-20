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
 const pages={},contexts=[],isolates={};
 for(const version of ['before','after']){
  const context=await browser.newContext();contexts.push(context);
  await serveBuild(context,'.',bundles);
  const page=await context.newPage();await page.goto('http://render.test/blank');
  await page.addScriptTag({url:`http://render.test/${version}.js`});
  await page.evaluate(async version=>{
   window.api=window[`${version}Api`];window.opts=api.options();
   await api.loadLettering(opts.style.knobs.lettering);await document.fonts.ready;
  },version);
  const cdp=await context.newCDPSession(page);
  isolates[version]=(await cdp.send('Runtime.getIsolateId')).id;await cdp.detach();
  pages[version]=page;
 }
 if(isolates.before===isolates.after)throw Error('Performance versions share a JavaScript heap');
 // Keep records in Node: one renderer must not collect the other renderer's
 // temporary objects or retain the benchmark's entire profile history.
 const results=[];
 for(const scenario of scenarios){
  for(const version of ['before','after'])await pages[version].evaluate(()=>{
   window.base=api.fixture('populated');window.map=structuredClone(base);
  });
  const count=Number(arg(scenario==='cold'?'--cold-runs':'--runs',scenario==='cold'?'5':'20'));
  for(let run=0;run<count;run++)for(const version of(run%2?['after','before']:['before','after'])){
   const record=await pages[version].evaluate(({scenario,run})=>{
    if(scenario==='cold')map.id=`cold-${run}`;
    if(scenario==='ownership'){
     const p=map.layers.polities.data,owner=[...p.owner],hex=owner.findIndex((o,i)=>o&&map.layers.base.data[i]==='Land');
     owner[hex]=run%2?p.polities[0].id:p.polities.at(-1).id;map.layers.polities={...map.layers.polities,data:{...p,owner}};
    }
    if(scenario==='shore'){
     const data=[...map.layers.base.data],hex=base.layers.base.data.findIndex((v,i)=>v==='Land'&&base.layers.base.data[i+1]==='Sea');
     data[hex]=run%2?'Land':'Coastal Land';map.layers.base={...map.layers.base,data};
    }
    api.beginRenderProfile();const start=performance.now();
    const scene=api.buildStaticScene(map,{...opts,polityOpacity:run%2?.55:.35});
    const ms=performance.now()-start,profile=api.endRenderProfile();
    return{scenario,run,ms,profile,symbolCount:api.symbolsOf(scene)?.length??0};
   },{scenario,run});
   results.push({...record,version});
  }
 }
 const summary=[];
 for(const scenario of scenarios)for(const version of ['before','after']){
  const rows=results.filter(r=>r.scenario===scenario&&r.version===version&&(scenario==='cold'||r.run>1));
  const values=rows.map(r=>r.ms).sort((a,b)=>a-b);
  summary.push({scenario,version,n:values.length,median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1]});
 }
 writeFileSync(resolve(output,'results.json'),JSON.stringify({browser:browser.version(),baseline:arg('--baseline','work/hypotheses/baseline'),isolation:'Separate browser contexts and JavaScript isolates; profile records retained in Node',isolates,scenarios,summary,records:results},null,2));console.log(JSON.stringify(summary,null,2));
 if(process.argv.includes('--check'))for(const scenario of scenarios){
  const before=summary.find(r=>r.scenario===scenario&&r.version==='before');
  const after=summary.find(r=>r.scenario===scenario&&r.version==='after');
  for(const metric of ['median','p95'])if(after[metric]>before[metric]*(scenario==='cold'?1.1:1))throw Error(`${scenario} ${metric} regressed: ${before[metric]} -> ${after[metric]}`);
 }
 for(const context of contexts)await context.close();
}finally{await browser.close();}
