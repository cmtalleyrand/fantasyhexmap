/** Reproducible browser evidence; no server or app-time auditing cost. */
import { build } from 'esbuild';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';
const arg = (key, fallback) => process.argv.includes(key) ? process.argv[process.argv.indexOf(key)+1] : fallback;
const output = resolve(arg('--output','work/drawing-investigation'));
mkdirSync(output,{ recursive:true });
const source=resolve(arg('--source','.'));
const fixture=readFileSync('scripts/drawing-investigation-fixtures.ts','utf8').replace(/(['"])\.\.\/(src|shared)\/([^'"]+)\1/g,(_,q,dir,file)=>JSON.stringify(resolve(source,dir,file)));
const contents = fixture + `\nexport { loadLettering } from ${JSON.stringify(resolve(source,'src/render/fontFiles.ts'))}; export { fixture as performanceFixture, options as performanceOptions } from './scripts/render-profile-input.ts';`;
// Review-only alternatives never modify production source or its tests.
const proposal=arg('--proposal','');
const plugins=proposal?[{name:'review-only',setup(b){b.onLoad({filter:/src\/render\/(labels|symbols)\.ts$/},({path})=>{
 let contents=readFileSync(path,'utf8');
 if(proposal==='symbols'&&path.endsWith('/symbols.ts'))contents=contents.replace('FIT_SCALES = [1, 0.85, 0.72, 0.6, 0.5, 0.42, 0.35, 0.3]','FIT_SCALES = [1, 0.85, 0.72, 0.6, 0.5]');
 if(proposal==='labels'&&path.endsWith('/labels.ts')) {
  contents=contents.replace('const centres = owned.map((i) => hexCenter(i % cols, Math.floor(i / cols), size));',`let shifted = false; const groundSamples: Point[] = [];
    const centres = owned.map(i => {
      const c = hexCenter(i % cols, Math.floor(i / cols), size);
      if (!input.land || input.land(c)) { groundSamples.push({x:c.x-size,y:c.y-size},{x:c.x+size,y:c.y+size}); return c; }
      const dry: Point[] = [];
      for(let y=c.y-size;y<=c.y+size;y+=size/8)for(let x=c.x-size;x<=c.x+size;x+=size/8){const h=pixelToOffset(x,y,size);if(h.col===i%cols&&h.row===Math.floor(i/cols)&&input.land({x,y}))dry.push({x,y});}
      if(!dry.length)return c; shifted=true;groundSamples.push(...dry);
      const mean=dry.reduce((a,p)=>({x:a.x+p.x/dry.length,y:a.y+p.y/dry.length}),{x:0,y:0});
      return dry.reduce((a,p)=>Math.hypot(p.x-mean.x,p.y-mean.y)<Math.hypot(a.x-mean.x,a.y-mean.y)?p:a);
    });`);
  contents=contents.replace('for (const c of centres) {\n      minX', 'for (const c of shifted ? groundSamples : centres) {\n      minX');
  contents=contents.replace('const reach = size;', 'const reach = shifted ? size / 8 : size;');
 }
 return{contents,loader:'ts'};
});}}]:[];
const bundle = (await build({ stdin: { contents, resolveDir: resolve('.'), loader:'ts' }, bundle:true,write:false,format:'iife',globalName:'api',loader:{'.woff2':'dataurl'},plugins })).outputFiles[0].text;
const browser = await launchBrowser();
try {
 const context = await browser.newContext({ viewport:{width:900,height:700} });
 await serveBuild(context,'.',{'/api.js':bundle});
 const page = await context.newPage(); await page.goto('http://render.test/blank'); await page.addScriptTag({url:'http://render.test/api.js'});
 await page.evaluate(async()=>{ await api.loadLettering(api.options().style.knobs.lettering); await document.fonts.ready; });
 const results=[];
 const count=await page.evaluate(()=>api.cases().length);
 for(let index=0;index<count;index++) {
  const result=await page.evaluate(index=>{
   const {name,map,opts}=api.cases()[index];
   const scene=api.buildScene(map,opts), land=api.landTestOf(scene);
   const flatOpts={...opts,labels:false,riverNames:false,seaNames:false,visible:{...opts.visible,elevation:false,vegetation:false,polities:false,cities:false,rivers:false},style:{...opts.style,palette:{...opts.style.palette,sea:'#000000',lake:'#000000',seaIce:'#000000',land:'#ffffff',coastalLand:'#ffffff',island:'#ffffff',ice:'#ffffff',coast:'#ffffff'},knobs:{...opts.style.knobs,water:'flat',grain:false,grid:'none',ice:'flat'}}};
   const flat=api.buildScene(map,flatOpts), scale=2;
   const canvas=document.createElement('canvas');canvas.width=Math.ceil(flat.width*scale);canvas.height=Math.ceil(flat.height*scale);
   const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.scale(scale,scale);ctx.fillStyle=flat.background;ctx.fillRect(0,0,flat.width,flat.height);api.drawScene(ctx,flat);
   const image=ctx.getImageData(0,0,canvas.width,canvas.height);
   const landPixel=(x,y)=>{const k=(Math.floor(y*scale)*canvas.width+Math.floor(x*scale))*4;return image.data[k]/255;};
   const waterAt=(x,y)=>landPixel(x,y)===0;
   let seaDisagreements=0,symbolWet=0,shelfWet=0,riverNameWet=0,waterNameDry=0; const samples=[];
   for(let y=4;y<flat.height-4;y+=2)for(let x=4;x<flat.width-4;x+=2){
    if(waterAt(x,y)&&land({x,y})){seaDisagreements++;if(samples.length<8)samples.push({x,y});}
   }
   for(const s of api.symbolsOf(scene)??[])for(const p of s.points)if(waterAt(p.x,p.y))symbolWet++;
   for(const text of api.textPrims(scene.prims).filter(p=>p.tag?.kind==='river'||p.tag?.kind==='water')){
    for(const b of api.textBoxes(text)){
     const nx=Math.max(2,Math.ceil(b.halfW)),ny=Math.max(2,Math.ceil(b.halfH)),c=Math.cos(b.rotation),s=Math.sin(b.rotation);
     for(let ix=0;ix<=nx;ix++)for(let iy=0;iy<=ny;iy++){
      const u=(2*ix/nx-1)*b.halfW,v=(2*iy/ny-1)*b.halfH,x=b.cx+u*c-v*s,y=b.cy+u*s+v*c;
      if(text.tag.kind==='river'&&waterAt(x,y))riverNameWet++;
      if(text.tag.kind==='water'&&landPixel(x,y)===1)waterNameDry++;
     }
    }
   }
   if(name==='glacier') {
    const shelf=p=>p.kind==='path'&&p.strokeWidth===opts.size*.46;
    const contains=ps=>ps.some(p=>shelf(p)||(p.kind==='group'&&contains(p.prims)));
    const groups=scene.prims.filter(p=>p.kind==='group'&&contains(p.prims));
    const probe=document.createElement('canvas');probe.width=canvas.width;probe.height=canvas.height;
    const pc=probe.getContext('2d');pc.scale(scale,scale);api.drawScene(pc,{...scene,prims:groups});
    const data=pc.getImageData(0,0,probe.width,probe.height).data;
    for(let k=0;k<data.length;k+=4)if(data[k+3]>200&&image.data[k]===0)shelfWet++;
   }
   const areas=[];
   for(const [hex,shape]of Object.entries(map.hexShapes??{})){
    const i=Number(hex),c=api.hexCenter(i%map.cols,Math.floor(i/map.cols),opts.size);let total=0,dry=0,shown=0;
    for(let y=c.y-opts.size;y<c.y+opts.size;y+=.5)for(let x=c.x-opts.size;x<c.x+opts.size;x+=.5){
     const at=api.pixelToOffset(x,y,opts.size);if(at.col!==i%map.cols||at.row!==Math.floor(i/map.cols))continue;
     total++;if(land({x,y}))dry++;shown+=landPixel(x,y);
    }areas.push({hex:i,set:shape.land,geometryPercent:100*dry/total,paintedNonSeaPercent:100*shown/total});
   }
   const texts=api.textPrims(scene.prims).filter(p=>p.tag).map(p=>({text:p.text,at:p.at,size:p.size,tag:p.tag}));
   return{name,svg:api.sceneToSvg(scene,name),mask:canvas.toDataURL().split(',')[1],seaDisagreements,samples,symbolWet,shelfWet,riverNameWet,waterNameDry,areas,texts,compromises:scene.compromises??[],audit:api.auditScene(map,scene,opts.size)};
  },index);
  writeFileSync(resolve(output,`${result.name}.svg`),result.svg);
  writeFileSync(resolve(output,`${result.name}-mask.png`),Buffer.from(result.mask,'base64')); delete result.mask;
  await page.setContent(result.svg);await page.locator('svg').screenshot({path:resolve(output,`${result.name}.png`)});
  if(['coast-20','glacier','strait-very-narrow'].includes(result.name)){
   await page.locator('svg').evaluate(el=>{el.style.width=`${el.viewBox.baseVal.width*4}px`;el.style.height=`${el.viewBox.baseVal.height*4}px`;});
   await page.locator('svg').screenshot({path:resolve(output,`${result.name}-4x.png`)});
  }
  delete result.svg;results.push(result);console.log(JSON.stringify({name:result.name,seaDisagreements:result.seaDisagreements,symbolWet:result.symbolWet,areas:result.areas}));
 }
 const sweep=await page.evaluate(()=>{
  const river=api.windingRiver(),failures=[];
  for(let n=0;n<400;n++){const seed=`s${n}`,course=api.riverCourse(river,20,seed,{wander:'gentle'}),m=api.riverMetrics(course.centreline);if(m.outside||m.maxTurn>=60)failures.push({seed,...m});}
  return{runs:400,failures};
 });
 const performance=await page.evaluate(()=>{
  const map=api.performanceFixture(),opts=api.performanceOptions(),timings=[];
  for(let run=0;run<8;run++){
   const o={...opts,polityOpacity:run%2?.55:.35};
   api.beginRenderProfile();const start=globalThis.performance.now();api.buildScene(map,o);const ms=globalThis.performance.now()-start;timings.push({run,ms,profile:api.endRenderProfile()});
  }return timings;
 });
 writeFileSync(resolve(output,'results.json'),JSON.stringify({browser:browser.version(),results,sweep,performance},null,2));
 console.log(JSON.stringify({riverSweep:sweep,performance:performance.map(r=>({run:r.run,ms:r.ms,counters:r.profile.counters}))}));
 if(process.argv.includes('--check') && (sweep.failures.length || results.some(r=>r.symbolWet||r.shelfWet||r.seaDisagreements||r.riverNameWet||r.waterNameDry))) throw Error('Finished-picture land check or 400-seed river rule failed');
 await context.close();
}finally{await browser.close();}
