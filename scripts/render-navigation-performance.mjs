/** Compare populated-map navigation against the map-bounds PR; no geometry changes allowed. */
import {execFileSync} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,symlinkSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildSync} from 'esbuild';
const argument=name=>process.argv[process.argv.indexOf(name)+1];
const ref=process.argv.includes('--baseline')?argument('--baseline'):'8acfcc0';
const root=resolve('.'),sha=execFileSync('git',['rev-parse','--verify',`${ref}^{commit}`],{encoding:'utf8'}).trim();
const archive=resolve('work',`performance-baseline-${sha}`);mkdirSync(archive,{recursive:true});
execFileSync('tar',['-x','-C',archive],{input:execFileSync('git',['archive',sha],{maxBuffer:64*1024*1024})});
try{symlinkSync(resolve('node_modules'),resolve(archive,'node_modules'),'dir')}catch(e){if(e.code!=='EEXIST')throw e}
const directory=resolve('work/navigation-performance');mkdirSync(directory,{recursive:true});
const files={};
for(const [version,source]of [['before',archive],['after',root]]){
 let contents=readFileSync('scripts/render-browser-fixture.tsx','utf8').replace(/(['"])\.\.\/(src|shared)\/([^'"]+)\1/g,(_,quote,folder,file)=>JSON.stringify(resolve(source,folder,file)));
 contents+=`\nexport { loadLettering } from ${JSON.stringify(resolve(source,'src/render/fontFiles.ts'))};`;
 if(version==='after')contents+=`\nexport { SceneRaster } from ${JSON.stringify(resolve(root,'src/render/raster.ts'))};`;
 files[version]=resolve(directory,`${version}.js`);
 buildSync({stdin:{contents,resolveDir:resolve('scripts'),loader:'tsx'},bundle:true,jsx:'automatic',format:'iife',globalName:'api',loader:{'.woff2':'dataurl'},outfile:files[version]});
}
const puppeteer=(await import(pathToFileURL(resolve('work/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js')).href)).default;
const browser=await puppeteer.launch({executablePath:'/usr/bin/chromium',pipe:true,headless:true,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
const results=[];
try{
 for(const version of ['before','after']){
  const page=await browser.newPage();await page.setViewport({width:1200,height:800,deviceScaleFactor:1});
  await page.setContent('<style>body{margin:0;height:1600px}.mapwrap{position:relative;width:800px;height:600px;overflow:hidden}.maphud,.mapzoom{position:absolute;bottom:0}.mapzoom{right:0}#sidebar{position:absolute;left:820px;top:0;width:300px;height:600px;overflow:auto}canvas{display:block}</style><div id="root"></div><div id="sidebar"></div>');
  await page.evaluate(()=>{document.querySelector('#sidebar').innerHTML=Array.from({length:300},(_,i)=>`<p>Sidebar item ${i}</p>`).join('');window.counts={stroke:0,fill:0,copy:0};for(const [method,key]of [['stroke','stroke'],['fill','fill'],['drawImage','copy']]){const fn=CanvasRenderingContext2D.prototype[method];CanvasRenderingContext2D.prototype[method]=function(...args){window.counts[key]++;return fn.apply(this,args)}}});
  await page.addScriptTag({path:files[version]});await page.evaluate(async()=>{await api.loadLettering(api.resolveStyle({preset:'parchment',overrides:{coast:'smooth'}}).knobs.lettering);api.mount(true)});
  await page.waitForSelector('canvas');await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>setTimeout(r,700));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))});
  const initial=await page.evaluate(()=>document.querySelector('canvas').toDataURL());
  const rasterChecks=version==='after'?await page.evaluate(()=>{
    const scene={width:4500,height:3900,background:'#fff',prims:[]},view={scale:4,x:-1000.25,y:-800.5},viewport={width:800,height:600};
    const image=new api.SceneRaster(scene,view,viewport,2);
    return {pixels:image.canvas.width*image.canvas.height,coversView:image.covers(view,viewport),coversSmallPan:image.covers({...view,x:view.x+20},viewport),coversDistantPan:image.covers({...view,x:view.x-2000},viewport),sharp:image.sharpAt(view)};
  }):undefined;

  const resize=await page.evaluate(async()=>{window.counts={stroke:0,fill:0,copy:0};const frames=[],wrap=document.querySelector('.mapwrap');for(let i=0;i<20;i++){const t=performance.now();wrap.style.height=`${600+(i%2)*5}px`;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));frames.push(performance.now()-t)}wrap.style.height='600px';return {counts:{...window.counts},medianMs:frames.sort((a,b)=>a-b)[10],maxMs:Math.max(...frames)}});
  await page.evaluate(()=>new Promise(r=>setTimeout(r,700)));

  const wheel=await page.evaluate(async()=>{
   window.counts={stroke:0,fill:0,copy:0};const canvas=document.querySelector('canvas'),frames=[];
   for(let i=0;i<20;i++){const t=performance.now();canvas.dispatchEvent(new WheelEvent('wheel',{bubbles:true,clientX:400,clientY:300,deltaY:-5}));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));frames.push(performance.now()-t)}
   return {counts:{...window.counts},frames,medianMs:[...frames].sort((a,b)=>a-b)[10],maxMs:Math.max(...frames)};
  });
  await page.evaluate(()=>new Promise(r=>setTimeout(r,700)));
  await page.mouse.move(350,300);await page.mouse.down({button:'right'});await page.evaluate(()=>{window.counts={stroke:0,fill:0,copy:0}});
  const panFrames=[];
  for(let i=0;i<20;i++){const t=performance.now();await page.mouse.move(350+i*2,300+i);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));panFrames.push(performance.now()-t)}
  const pan=await page.evaluate(()=>({...window.counts}));await page.mouse.up({button:'right'});
  await page.evaluate(()=>new Promise(r=>setTimeout(r,700)));
  const final=await page.evaluate(()=>document.querySelector('canvas').toDataURL());
  await page.mouse.move(950,200);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const sidebar=await page.evaluate(async()=>{window.counts={stroke:0,fill:0,copy:0};const el=document.querySelector('#sidebar'),t=performance.now();for(let i=0;i<20;i++){el.scrollTop+=12;await new Promise(r=>requestAnimationFrame(r))}return {counts:{...window.counts},scrollTop:el.scrollTop,elapsedMs:performance.now()-t}});
  const pageScroll=await page.evaluate(async()=>{window.counts={stroke:0,fill:0,copy:0};for(let i=0;i<20;i++){window.scrollBy(0,10);await new Promise(r=>requestAnimationFrame(r))}return {counts:{...window.counts},y:window.scrollY}});
  results.push({version,initial,final,rasterChecks,resize,wheel,pan:{counts:pan,medianMs:panFrames.sort((a,b)=>a-b)[10],maxMs:Math.max(...panFrames)},sidebar,pageScroll});console.log(JSON.stringify({...results.at(-1),initial:undefined,final:undefined}));await page.close();
 }
 const page=await browser.newPage();
 const pixels=await page.evaluate(async results=>{
  const read=async url=>{const image=new Image();image.src=url;await image.decode();const c=document.createElement('canvas');c.width=image.width;c.height=image.height;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return ctx.getImageData(0,0,c.width,c.height).data};
  const compare=async key=>{const a=await read(results[0][key]),b=await read(results[1][key]);let changed=0,max=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);if(d)changed++;max=Math.max(max,d)}return {channels:changed,maxDelta:max}};
  return {initial:await compare('initial'),final:await compare('final')};
 },results);await page.close();
 const report={baseline:sha,size:40,allLayers:true,results:results.map(({initial,final,...r})=>r),pixels};writeFileSync('work/render-navigation-performance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 const after=results[1];
 if(after.rasterChecks.pixels>8_000_000||!after.rasterChecks.coversView||!after.rasterChecks.coversSmallPan||after.rasterChecks.coversDistantPan||!after.rasterChecks.sharp)throw Error('Raster bounds, resolution or memory limit failed');
 if(after.wheel.counts.fill>20||after.pan.counts.fill>20||after.resize.counts.fill>20)throw Error('Navigation repainted the scene during the gesture');
 if(after.wheel.maxMs>=1000||after.pan.maxMs>=1000||after.resize.maxMs>=1000)throw Error('40×40 navigation exceeds 1 s');
 if(after.sidebar.counts.copy||after.pageScroll.counts.copy)throw Error('Unchanged map redraws on page/sidebar scrolling');
 if(!after.sidebar.scrollTop||!after.pageScroll.y)throw Error('Scroll test did not scroll');
 if(pixels.initial.maxDelta!==0||pixels.final.maxDelta!==0)throw Error('Settled raster pixels differ from direct painting');
}finally{await browser.close()}
