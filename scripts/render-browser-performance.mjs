/** Browser geometry and interaction regression checks; see docs/render-performance.md. */
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildSync} from 'esbuild';
const argument = name => process.argv[process.argv.indexOf(name)+1];
const ref=process.argv.includes('--baseline')?argument('--baseline'):'origin/main';
const root=resolve('.');
const sha=execFileSync('git',['rev-parse','--verify',`${ref}^{commit}`],{encoding:'utf8'}).trim();
const archived=resolve('work',`performance-baseline-${sha}`);
mkdirSync(archived,{recursive:true});
execFileSync('tar',['-x','-C',archived],{input:execFileSync('git',['archive',sha],{maxBuffer:64*1024*1024})});
try{symlinkSync(resolve('node_modules'),resolve(archived,'node_modules'),'dir');}catch(error){if(error.code!=='EEXIST')throw error;}
const directory=resolve('work/browser-performance');mkdirSync(directory,{recursive:true});
const fixture=readFileSync('scripts/render-browser-fixture.tsx','utf8');
const files={};
for(const [version,source] of [['before',archived],['after',root]]){
 const contents=fixture.replace(/(['"])\.\.\/(src|shared)\/([^'"]+)\1/g,(_,quote,folder,file)=>JSON.stringify(resolve(source,folder,file)));
 const outfile=resolve(directory,`${version}.js`);files[version]=outfile;
 buildSync({stdin:{contents,sourcefile:'fixture.tsx',resolveDir:root,loader:'tsx'},bundle:true,format:'iife',globalName:version==='before'?'beforeApi':'afterApi',jsx:'automatic',loader:{'.woff2':'dataurl'},outfile});
}
let puppeteer;
try{puppeteer=(await import('puppeteer-core')).default;}catch{puppeteer=(await import(pathToFileURL(resolve('work/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js')).href)).default;}
const executablePath=process.argv.includes('--chromium')?argument('--chromium'):'/usr/bin/chromium';
const browser=await puppeteer.launch({executablePath,pipe:true,headless:true,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'],userDataDir:resolve(directory,'profile')});
const results=[],images=[];
try{
 const page=await browser.newPage(); await page.setContent('<html><body></body></html>');
 await page.addScriptTag({path:files.before}); await page.addScriptTag({path:files.after});
 const sceneResults=await page.evaluate(()=>{
  const result=[];
  for(const layout of ['continent','archipelago','lakes']) {
   const n=30;
   const make=(api)=>{const map=api.createMapState('Perf',n,n);map.id='performance-fixture';map.layers.base.data=Array.from({length:n*n},(_,i)=>{const x=i%n,y=Math.floor(i/n); return layout==='continent'?(x<n/2+Math.sin(y/3)*3?'Coastal Land':'Sea'):layout==='archipelago'?((x%8<4&&y%8<4)?'Coastal Land':'Sea'):((x%8<4&&y%8<4)?'Lake':'Coastal Land');});return map;};
   const options=api=>({size:26,visible:api.defaultVisibility(),labels:false,style:api.resolveStyle({preset:'parchment',overrides:{coast:'smooth'}})});
   const run=api=>{const t=performance.now(),scene=api.buildScene(make(api),options(api));return {scene,ms:performance.now()-t};};
   const before=run(beforeApi),after=run(afterApi);
   const canvas=()=>{const c=document.createElement('canvas');c.width=800;c.height=600;return c;};
   const a=canvas(),b=canvas();
   const draw=(api,c,scene)=>{const ctx=c.getContext('2d');ctx.setTransform(.5,0,0,.5,0,0);ctx.clearRect(0,0,1600,1200);ctx.fillStyle=scene.background;ctx.fillRect(0,0,scene.width,scene.height);api.drawScene(ctx,scene);ctx.getImageData(0,0,1,1);};
   draw(beforeApi,a,before.scene);draw(afterApi,b,after.scene);
   const pa=a.getContext('2d').getImageData(0,0,800,600).data,pb=b.getContext('2d').getImageData(0,0,800,600).data;
   let differences=0;for(let i=0;i<pa.length;i++) if(pa[i]!==pb[i])differences++;
   const dest=canvas(),ctx=dest.getContext('2d');const t=performance.now();for(let i=0;i<20;i++){ctx.drawImage(b,0,0);ctx.getImageData(0,0,1,1);}const copyMs=(performance.now()-t)/20;
   result.push({layout,n,beforeBuildMs:before.ms,afterBuildMs:after.ms,identicalScene:JSON.stringify(before.scene)===JSON.stringify(after.scene),pixelDifferences:differences,hoverCopyMs:copyMs});
  }return result;
 });
 await page.close();
 if(sceneResults.some(r=>!r.identicalScene || r.pixelDifferences!==0)) throw Error('Scene or pixels differ from baseline');
 for(const version of ['before','after']) {
  const page=await browser.newPage();await page.setViewport({width:900,height:750,deviceScaleFactor:1});
  await page.setContent('<html><head><style>.mapwrap{width:800px;height:600px;position:relative}.maphud{position:absolute;bottom:0}canvas{display:block}</style></head><body><div id="root"></div></body></html>');
  await page.evaluate(()=>{window.counts={stroke:0,copy:0};for(const [method,counter] of [['stroke','stroke'],['drawImage','copy']]){const original=CanvasRenderingContext2D.prototype[method];CanvasRenderingContext2D.prototype[method]=function(...args){window.counts[counter]++;return original.apply(this,args);};}});
  await page.addScriptTag({path:files[version]});await page.evaluate(v=>{window.cleanup=(v==='before'?beforeApi:afterApi).mount();},version);
  await page.waitForSelector('canvas');await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));});
  await new Promise(r=>setTimeout(r,500));
  const initial=await page.evaluate(()=>({image:document.querySelector('canvas').toDataURL(),counts:{...window.counts}}));
  await page.evaluate(()=>window.counts={stroke:0,copy:0});
  images.push(initial.image);
  const moves=[];
  for(let i=0;i<15;i++) {const t=performance.now();await page.mouse.move(100+i*35,150+(i%3)*35);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));moves.push(performance.now()-t);}
  const hover=await page.evaluate(()=>({...window.counts}));
  await page.evaluate(()=>window.counts={stroke:0,copy:0});
  await page.mouse.click(220,150);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const selection=await page.evaluate(()=>({...window.counts}));
  await page.evaluate(()=>window.counts={stroke:0,copy:0});
  await page.click('[aria-label="Zoom in"]');await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const zoom=await page.evaluate(()=>({counts:{...window.counts},changed:document.querySelector('canvas').toDataURL()}));
  results.push({version,initialHash:createHash('sha256').update(initial.image).digest('hex'),hover,hoverMedianMs:moves.sort((a,b)=>a-b)[7],zoomRedrew:zoom.changed!==initial.image,zoomStrokes:zoom.counts.stroke,selection});
  await page.close();
 }
 console.log(results);
 const comparisonPage=await browser.newPage();
 const pixels=await comparisonPage.evaluate(async images=>{
   const data=await Promise.all(images.map(async url=>{const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return ctx.getImageData(0,0,canvas.width,canvas.height).data;}));
   let differingPixels=0,maxChannelDelta=0;
   for(let i=0;i<data[0].length;i+=4){let differs=false;for(let k=0;k<4;k++){const d=Math.abs(data[0][i+k]-data[1][i+k]);maxChannelDelta=Math.max(maxChannelDelta,d);if(d)differs=true;}if(differs)differingPixels++;}
   return {differingPixels,maxChannelDelta,totalPixels:data[0].length/4};
 },images);
 if(pixels.maxChannelDelta>1 || pixels.differingPixels>pixels.totalPixels*0.0001)throw Error(`Viewport mismatch beyond raster rounding: ${JSON.stringify(pixels)}`);
 if(results[1].hover.stroke>=results[0].hover.stroke/10)throw Error('Hover did not eliminate full scene repainting');
 if(results[1].selection.stroke>=20 || results[1].selection.copy<1)throw Error('Selection did not reuse viewport');
 if(!results[1].zoomRedrew||results[1].zoomStrokes<10)throw Error('Zoom failed to invalidate cached viewport');
 const report={baseline:sha,sceneResults,interactions:results,viewportPixels:pixels};
 writeFileSync('work/render-browser-performance.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}finally{await browser.close();}
