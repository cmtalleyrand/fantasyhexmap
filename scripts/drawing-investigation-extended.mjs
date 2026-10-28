/** Area fidelity, dense placement, and review images beyond the small regression set. */
import { buildSync } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';
const arg=(k,d)=>process.argv.includes(k)?process.argv[process.argv.indexOf(k)+1]:d;
const output=resolve(arg('--output','work/hypotheses/extended'));mkdirSync(output,{recursive:true});
const source=resolve(arg('--source','.'));
const selection={only:arg('--only',''),preset:arg('--preset',''),seed:arg('--seed',''),share:arg('--share','')};
if(selection.only&&!['coverage','islands','enclosed-seas'].includes(selection.only))throw Error('Unknown --only group');
if(selection.preset&&!['classic','parchment','atlas'].includes(selection.preset))throw Error('Unknown --preset');
if(selection.seed&&!/^coverage-[0-9]$/.test(selection.seed))throw Error('Unknown coverage --seed');
if(selection.share&&![5,10,20,50,90].includes(Number(selection.share)))throw Error('Unknown coverage --share');
if(selection.only&&selection.only!=='coverage'&&(selection.preset||selection.seed||selection.share))throw Error('Coverage selectors require --only coverage');
console.log('Selection (empty means full coverage):',selection);
const bundle=buildSync({stdin:{contents:`export * from ${JSON.stringify(resolve(source,'scripts/drawing-investigation-fixtures.ts'))}; export { createMapState } from ${JSON.stringify(resolve(source,'shared/layers.ts'))}; export { loadLettering } from ${JSON.stringify(resolve(source,'src/render/fontFiles.ts'))};`,resolveDir:resolve('.'),loader:'ts'},bundle:true,write:false,format:'iife',globalName:'api',loader:{'.woff2':'dataurl'}}).outputFiles[0].text;
const browser=await launchBrowser();
try{
 const context=await browser.newContext();await serveBuild(context,'.',{'/api.js':bundle});const page=await context.newPage();await page.goto('http://render.test/blank');await page.addScriptTag({url:'http://render.test/api.js'});
 await page.evaluate(async()=>{await api.loadLettering(api.options().style.knobs.lettering);await document.fonts.ready;});
 const coverage=[];
 for(const preset of ['classic','parchment','atlas']) {
  if((selection.only&&selection.only!=='coverage')||(selection.preset&&selection.preset!==preset))continue;
  const records=await page.evaluate(({preset,selection})=>{
   const records=[];
   for(let n=0;n<10;n++)for(const share of [5,10,20,50,90]){
    if((selection.seed&&selection.seed!==`coverage-${n}`)||(selection.share&&Number(selection.share)!==share))continue;
    const map=api.coastMap(share,`coverage-${n}`),o=api.options(preset,'none');o.visible={...o.visible,elevation:false,vegetation:false,polities:false,cities:false,rivers:false};o.labels=false;o.seaNames=false;o.riverNames=false;
    o.style={...o.style,knobs:{...o.style.knobs,water:'flat',ice:'flat'},palette:{...o.style.palette,sea:'#000000',lake:'#000000',land:'#ffffff',coastalLand:'#ffffff',island:'#ffffff',coast:'#ffffff'}};
    const scene=api.buildScene(map,o),canvas=document.createElement('canvas');canvas.width=Math.ceil(scene.width*4);canvas.height=Math.ceil(scene.height*4);
    const ctx=canvas.getContext('2d');ctx.fillStyle='#000';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.scale(4,4);api.drawScene(ctx,scene);
    const image=ctx.getImageData(0,0,canvas.width,canvas.height),c=api.hexCenter(2,2,40);let count=0,dry=0;
    for(let y=c.y-40;y<c.y+40;y+=.25)for(let x=c.x-40;x<c.x+40;x+=.25){const h=api.pixelToOffset(x,y,40);if(h.col!==2||h.row!==2)continue;count++;dry+=image.data[(Math.floor(y*4)*canvas.width+Math.floor(x*4))*4]/255;}
    records.push({preset,seed:map.id,share,shown:100*dry/count,notices:scene.compromises??[]});
   }return records;
  },{preset,selection});coverage.push(...records);console.log(preset,records.length);
 }
 const seedIslands=selection.only&&selection.only!=='islands'?{runs:0,failures:[],skipped:true}:await page.evaluate(()=>{
  const failures=[];let notices=0,drawn=0;
  for(let n=0;n<200;n++){
   const map=api.createMapState('Island sweep',3,3);map.id=`island-${n}`;map.layers.base.data=Array(9).fill('Sea');map.layers.base.data[4]='Islands';map.hexShapes={'4':{type:'Islands',land:10,irregular:'Fractured'}};map.islandSpecs={'4':{large:1,small:2}};map.layers.elevation.data=Array(9).fill(null);map.layers.elevation.data[4]='Mountains';
   const o=api.options(),scene=api.buildScene(map,o);notices+=scene.compromises?.length??0;drawn+=(api.symbolsOf(scene)??[]).length;
   o.visible.elevation=false;o.labels=false;o.style={...o.style,knobs:{...o.style.knobs,water:'flat'},palette:{...o.style.palette,sea:'#000000',land:'#fff',island:'#fff',coast:'#fff'}};
   const flat=api.buildScene(map,o),c=document.createElement('canvas');c.width=Math.ceil(flat.width*4);c.height=Math.ceil(flat.height*4);const ctx=c.getContext('2d');ctx.fillStyle='#000';ctx.fillRect(0,0,c.width,c.height);ctx.scale(4,4);api.drawScene(ctx,flat);const data=ctx.getImageData(0,0,c.width,c.height).data;
   for(const s of api.symbolsOf(scene)??[])for(const p of s.points){const k=(Math.floor(p.y*4)*c.width+Math.floor(p.x*4))*4;if(data[k]===0){failures.push({seed:map.id,point:p});break;}}
  }return{runs:200,failures,notices,drawn};
 });
 const enclosedSeas=selection.only&&selection.only!=='enclosed-seas'?{runs:0,failures:[],skipped:true}:await page.evaluate(()=>{
  const failures=[];let runs=0;
  for(const preset of ['classic','parchment','atlas'])for(let n=0;n<200;n++){
   const nested=n%2===1,span=nested?7:5,map=api.createMapState('Enclosed sea sweep',span,span);map.id=`enclosed-sea-${n}`;
   map.layers.base.data=Array(span*span).fill('Land');
   if(nested){for(let r=1;r<6;r++)for(let c=1;c<6;c++)map.layers.base.data[r*span+c]='Sea';map.layers.base.data[24]='Land';}
   else map.layers.base.data[12]='Sea';
   const o=api.options(preset,'none');o.visible={...o.visible,elevation:false,vegetation:false,polities:false,cities:false,rivers:false};o.labels=false;o.seaNames=false;
   o.style={...o.style,knobs:{...o.style.knobs,water:'flat',grain:false,grid:'none'},palette:{...o.style.palette,sea:'#000000',land:'#ffffff',coastalLand:'#ffffff',coast:'#ffffff'}};
   const scene=api.buildScene(map,o),canvas=document.createElement('canvas');canvas.width=Math.ceil(scene.width);canvas.height=Math.ceil(scene.height);
   const ctx=canvas.getContext('2d');ctx.fillStyle=scene.background;ctx.fillRect(0,0,canvas.width,canvas.height);api.drawScene(ctx,scene);
   const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
   for(let i=0;i<span*span;i++){
    const p=api.hexCenter(i%span,Math.floor(i/span),o.size),value=pixels[(Math.floor(p.y)*canvas.width+Math.floor(p.x))*4],wanted=map.layers.base.data[i]==='Land'?255:0;
    if(value!==wanted){failures.push({preset,seed:map.id,nested,hex:i,wanted,painted:value});break;}
   }
   runs++;
  }
  return{runs,failures};
 });
 const summary=Array.from(new Set(coverage.map(r=>r.preset))).map(preset=>{const rows=coverage.filter(r=>r.preset===preset),errors=rows.map(r=>Math.abs(r.shown-r.share)).sort((a,b)=>a-b);return{preset,cases:rows.length,medianErrorPP:errors[Math.floor(errors.length/2)],maxErrorPP:errors.at(-1),worst:rows.reduce((a,b)=>Math.abs(a.shown-a.share)>Math.abs(b.shown-b.share)?a:b)}});
 writeFileSync(resolve(output,'results.json'),JSON.stringify({selection,coverage,summary,seedIslands,enclosedSeas},null,2));console.log(JSON.stringify({summary,seedIslands,enclosedSeas},null,2));
 if(selection.only==='coverage'&&!coverage.length)throw Error('No coverage cases selected');
 if(process.argv.includes('--check')){
  // Every case over the 5-point land-share tolerance, then the groups that failed.
  const overShare=coverage.filter(r=>Math.abs(r.shown-r.share)>5);
  for(const r of overShare)console.error(`coverage over tolerance: ${r.preset} ${r.seed}: ${r.share}% asked, ${r.shown.toFixed(1)}% drawn`);
  for(const f of seedIslands.failures)console.error(`island symbol over water: ${f.seed} at ${f.point.x.toFixed(1)},${f.point.y.toFixed(1)}`);
  for(const f of enclosedSeas.failures)console.error(`enclosed sea painted wrong: ${f.preset} ${f.seed} hex ${f.hex}: wanted ${f.wanted}, painted ${f.painted}`);
  const failed=[seedIslands.failures.length&&'islands',enclosedSeas.failures.length&&'enclosed seas',overShare.length&&'coverage'].filter(Boolean);
  if(failed.length)throw Error(`Drawing sweep failed: ${failed.join(', ')}`);
 }
 await context.close();
}finally{await browser.close();}
