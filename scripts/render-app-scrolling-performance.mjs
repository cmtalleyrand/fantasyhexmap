/** Exercise scrolling in the production app, with the full populated map loaded from IndexedDB. */
import {workerProbe} from './browser-worker-plugin.mjs';
import {createServer} from 'node:http';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {pathToFileURL} from 'node:url';
const puppeteer=(await import(pathToFileURL(resolve('work/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js')).href)).default;
const root=resolve('dist');
const server=createServer((req,res)=>{
 if(req.url==='/blank'){res.setHeader('Content-Type','text/html');res.end('<html><body></body></html>');return}
 const path=resolve(root,decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\//,'')||'index.html');
 if(!path.startsWith(root+'/')){res.writeHead(403);res.end();return}
 try{const data=readFileSync(path);res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.json':'application/json'})[extname(path)]||'application/octet-stream');res.end(data)}catch{res.writeHead(404);res.end()}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
const browser=await puppeteer.launch({executablePath:'/usr/bin/chromium',pipe:true,headless:true,args:['--no-sandbox','--disable-gpu','--disable-dev-shm-usage']});
try{
 const page=await browser.newPage();await page.setViewport({width:1400,height:900});await page.goto(url+'/blank');
 await page.addScriptTag({path:resolve('work/all-layers-after.js')});
 await page.evaluate(async()=>{
  const map=afterApi.fixture('all-layer-performance0');
  localStorage.setItem('fantasyhexmap.prefs',JSON.stringify({defaultsVersion:2,offline:true,labels:true,riverNames:true,rangeNames:true,seaNames:true,landNames:true,mapStyle:{preset:'parchment',overrides:{coast:'smooth'}}}));
  await new Promise((resolve,reject)=>{const req=indexedDB.open('fantasyhexmap',2);req.onupgradeneeded=()=>{const db=req.result;db.createObjectStore('maps');db.createObjectStore('saves',{keyPath:'id'})};req.onsuccess=()=>{const db=req.result,tx=db.transaction('maps','readwrite');tx.objectStore('maps').put(map,'current');tx.oncomplete=()=>{db.close();resolve()};tx.onerror=reject};req.onerror=reject});
 });
 await page.evaluateOnNewDocument(workerProbe);
 await page.evaluateOnNewDocument(()=>{
  window.paintCounts={fill:0,stroke:0,copy:0};window.tasks=[];
  new PerformanceObserver(list=>window.tasks.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:true});
  for(const [method,key]of [['fill','fill'],['stroke','stroke'],['drawImage','copy']]){const fn=CanvasRenderingContext2D.prototype[method];CanvasRenderingContext2D.prototype[method]=function(...args){window.paintCounts[key]++;return fn.apply(this,args)}}
 });
 await page.goto(url);await page.waitForSelector('.mapwrap canvas');
 await page.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>setTimeout(r,800))});
 const buttons=await page.$$('button[aria-label^="Show "][aria-label$=" on the map"]');
 for(const button of buttons){await button.click();await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))}
 await page.evaluate(()=>new Promise(r=>setTimeout(r,800)));
 await page.waitForFunction(()=>window.workerPaints>0&&window.workerJobs===0&&window.sharpFramesPending===0&&performance.now()-window.lastWorkerPaint>300,{timeout:30000});
 const measure=async selector=>{
  const box=await (await page.$(selector)).boundingBox();await page.mouse.move(box.x+Math.min(100,box.width/2),box.y+Math.min(120,box.height/2));
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  await page.evaluate(()=>{window.paintCounts={fill:0,stroke:0,copy:0};window.tasks=[]});
  const frames=[];for(let i=0;i<20;i++){const t=performance.now();await page.mouse.wheel({deltaY:30});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));frames.push(performance.now()-t)}
  return page.evaluate((selector,frames)=>({selector,scrollTop:document.querySelector(selector).scrollTop,paints:{...window.paintCounts},longTasks:[...window.tasks],medianMs:frames.sort((a,b)=>a-b)[10],maxMs:Math.max(...frames)}),selector,frames);
 };
 const desktop=await measure('.sidebar');
 await page.setViewport({width:500,height:800});await page.evaluate(()=>new Promise(r=>setTimeout(r,800)));
 await page.waitForFunction(()=>window.workerJobs===0&&window.sharpFramesPending===0&&performance.now()-window.lastWorkerPaint>300,{timeout:30000});
 await page.mouse.move(480,750);await page.evaluate(()=>{window.paintCounts={fill:0,stroke:0,copy:0};window.tasks=[]});
 const frames=[];for(let i=0;i<20;i++){const t=performance.now();await page.mouse.wheel({deltaY:25});await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));frames.push(performance.now()-t)}
 const mobile=await page.evaluate(frames=>({y:window.scrollY,paints:{...window.paintCounts},longTasks:[...window.tasks],medianMs:frames.sort((a,b)=>a-b)[10],maxMs:Math.max(...frames)}),frames);
 const report={size:40,populatedLayers:8,activatedLayers:1+buttons.length,desktop,mobile};
 writeFileSync('work/render-app-scrolling-performance.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
 if(report.activatedLayers!==8)throw Error('The app did not activate all eight layers');
 if(!desktop.scrollTop||!mobile.y)throw Error('App scroll tests did not scroll');
 if(desktop.paints.fill||desktop.paints.copy||mobile.paints.fill||mobile.paints.copy)throw Error('An unchanged map redraws when scrolling');
 if(desktop.maxMs>=1000||mobile.maxMs>=1000)throw Error('App scrolling exceeds 1 second');
}finally{await browser.close();await new Promise(r=>server.close(r))}
