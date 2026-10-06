/** Stress native navigation, frame cadence and final sharp paint on a populated 40×40 map. */
import {workerProbe} from './browser-worker-plugin.mjs';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
const puppeteer=(await import(pathToFileURL(resolve('work/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js')).href)).default;
const argument = name => process.argv[process.argv.indexOf(name) + 1];
const rasterThreads=process.argv.includes('--raster-threads')?Number(argument('--raster-threads')):1;
const cpuStat=()=>{try{return Object.fromEntries(readFileSync('/sys/fs/cgroup/cpu.stat','utf8').trim().split('\n').map(line=>{const [key,value]=line.split(' ');return [key,Number(value)]}))}catch{return null}};
const root=resolve(process.argv.includes('--dist') ? argument('--dist') : 'dist');
const server=createServer((req,res)=>{
 if(req.url==='/blank'){res.setHeader('Content-Type','text/html');res.end('<html><body></body></html>');return}
 const path=resolve(root,decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\//,'')||'index.html');
 if(!path.startsWith(root+'/')){res.writeHead(403);res.end();return}
 try{const data=readFileSync(path);res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.json':'application/json'})[extname(path)]||'application/octet-stream');res.end(data)}catch{res.writeHead(404);res.end()}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
const browser=await puppeteer.launch({executablePath:'/usr/bin/chromium',pipe:true,headless:true,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage',`--num-raster-threads=${rasterThreads}`]});
try{
 const page=await browser.newPage();await page.setViewport({width:1400,height:900,deviceScaleFactor:process.argv.includes('--dpr2')?2:1});await page.goto(url+'/blank');
 await page.addScriptTag({path:resolve('work/all-layers-after.js')});
 await page.evaluate(async()=>{
  const map=afterApi.fixture('all-layer-performance0');
  localStorage.setItem('fantasyhexmap.prefs',JSON.stringify({defaultsVersion:2,offline:true,labels:true,riverNames:true,rangeNames:true,seaNames:true,landNames:true,mapStyle:{preset:'parchment',overrides:{coast:'smooth'}}}));
  await new Promise((resolve,reject)=>{const req=indexedDB.open('fantasyhexmap',2);req.onupgradeneeded=()=>{const db=req.result;db.createObjectStore('maps');db.createObjectStore('saves',{keyPath:'id'})};req.onsuccess=()=>{const db=req.result,tx=db.transaction('maps','readwrite');tx.objectStore('maps').put(map,'current');tx.oncomplete=()=>{db.close();resolve()};tx.onerror=reject};req.onerror=reject});
 });
 await page.evaluateOnNewDocument(workerProbe);
 await page.evaluateOnNewDocument(()=>{
  window.paintCounts={fill:0,stroke:0,copy:0};window.tasks=[];window.inputFrames=[];window.nextFrames=[];window.pendingInputs=[];
  for(const name of ['wheel','pointermove'])document.addEventListener(name,event=>{if(window.watching&&(name==='wheel'||event.buttons))window.pendingInputs.push(performance.now())},{capture:true,passive:true});
  const copy=CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage=function(...args){
   const result=copy.apply(this,args);
   if(this.canvas.isConnected&&window.pendingInputs.length){const times=window.pendingInputs.splice(0);requestAnimationFrame(()=>{if(window.watching)window.nextFrames.push(...times.map(t=>performance.now()-t));requestAnimationFrame(()=>{if(window.watching)window.inputFrames.push(...times.map(t=>performance.now()-t))})})}
   return result;
  };
  new PerformanceObserver(list=>window.tasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:true});
  for(const [method,key]of [['fill','fill'],['stroke','stroke'],['drawImage','copy']]){const fn=CanvasRenderingContext2D.prototype[method];CanvasRenderingContext2D.prototype[method]=function(...args){window.paintCounts[key]++;return fn.apply(this,args)}}
 });
 await page.goto(url);await page.waitForSelector('.mapwrap canvas');
 await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>setTimeout(r,800))});
 const buttons=await page.$$('button[aria-label^="Show "][aria-label$=" on the map"]');
 for(const button of buttons){await button.click();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))}
 await page.evaluate(()=>new Promise(r=>setTimeout(r,800)));
 if(!process.argv.includes('--baseline'))await page.waitForFunction(()=>window.workerPaints>0&&window.workerJobs===0&&performance.now()-window.lastWorkerPaint>300,{timeout:30000});
 const box=await (await page.$('.mapwrap canvas')).boundingBox();
 const centre={x:box.x+box.width/2,y:box.y+box.height/2};
 await page.mouse.move(centre.x,centre.y);
 const cpuBefore=cpuStat();
 const cases=[];
 const begin=async()=>page.evaluate(()=>{
  window.paintCounts={fill:0,stroke:0,copy:0};window.tasks=[];window.gaps=[];window.inputFrames=[];window.nextFrames=[];window.pendingInputs=[];window.workerDurations=[];window.lastNavigationInput=performance.now();
  let last=performance.now();window.watching=true;
  const frame=t=>{window.gaps.push(t-last);last=t;if(window.watching)requestAnimationFrame(frame)};requestAnimationFrame(frame);
 });
 const finish=async(name,frames)=>{
  if(!process.argv.includes('--baseline'))await page.waitForFunction(()=>window.workerJobs===0&&window.sharpFramesPending===0&&performance.now()-window.lastWorkerPaint>200,{timeout:30000});
  const result=await page.evaluate((name,frames)=>{window.watching=false;return {name,frames,nextFrameMaxMs:window.nextFrames.length?Math.max(...window.nextFrames):null,inputFrameSamples:window.inputFrames.length,inputFrameMaxMs:window.inputFrames.length?Math.max(...window.inputFrames):null,medianMs:[...frames].sort((a,b)=>a-b)[Math.floor(frames.length/2)],maxMs:Math.max(...frames),maxFrameGapMs:Math.max(...window.gaps),paints:{...window.paintCounts},longTasks:[...window.tasks],workerPaintMaxMs:window.workerDurations.length?Math.max(...window.workerDurations):null,sharpAfterLastInputMs:window.lastSharpFrame?Math.max(0,window.lastSharpFrame-window.lastNavigationInput):null}},name,frames);
  cases.push(result);console.log(JSON.stringify(result));
 };
 const wheel=async(name,delta,count,pause)=>{
  await begin();const frames=[];
  for(let i=0;i<count;i++){
   await page.evaluate(()=>{window.lastNavigationInput=performance.now()});const t=performance.now();await page.mouse.wheel({deltaY:delta});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));frames.push(performance.now()-t);
   if(pause)await page.evaluate(ms=>new Promise(r=>setTimeout(r,ms)),pause);
  }
  await page.evaluate(()=>new Promise(r=>setTimeout(r,700)));await finish(name,frames);
 };
 await wheel('large continuous zoom',-120,16,0);
 await wheel('paused zoom out',160,6,240);
 await wheel('paused zoom in',-160,6,240);
 await begin();const pan=[];
 for(let i=0;i<8;i++){
  await page.mouse.move(centre.x-180,centre.y);await page.mouse.down({button:'right'});
  await page.evaluate(()=>{window.lastNavigationInput=performance.now()});const t=performance.now();await page.mouse.move(centre.x+180,centre.y,{steps:2});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));pan.push(performance.now()-t);await page.mouse.up({button:'right'});
  await page.evaluate(()=>new Promise(r=>setTimeout(r,240)));
 }
 await page.evaluate(()=>new Promise(r=>setTimeout(r,700)));await finish('pan across cached-window boundaries',pan);
 const cpuAfter=cpuStat();
 const report={rasterThreads,cpuThrottledMs:cpuBefore&&cpuAfter?(cpuAfter.throttled_usec-cpuBefore.throttled_usec)/1000:null,size:40,populatedLayers:8,activatedLayers:1+buttons.length,dpr:await page.evaluate(()=>devicePixelRatio),cases};
 writeFileSync(process.argv.includes('--dpr2')?'work/render-navigation-stress-dpr2.json':'work/render-navigation-stress-dpr1.json',JSON.stringify(report,null,2));
 if(process.argv.includes('--check')&&cases.some(c=>c.nextFrameMaxMs===null||c.nextFrameMaxMs>=33||c.maxMs>=1000||c.maxFrameGapMs>33.5||c.paints.fill>100||c.sharpAfterLastInputMs===null||c.sharpAfterLastInputMs>=1000))throw Error('Navigation exceeds the 33 ms input-frame or one-second sharp-image budget');
}finally{await browser.close();await new Promise(r=>server.close(r))}
