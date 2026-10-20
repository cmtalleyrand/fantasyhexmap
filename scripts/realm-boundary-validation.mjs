/** Adjacent realms must paint to the shared frontier without gaps or spill. */
import {buildSync} from 'esbuild';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {launchBrowser,serveBuild} from './browser-runtime.mjs';
const arg=(k,d)=>process.argv.includes(k)?process.argv[process.argv.indexOf(k)+1]:d;
const source=resolve(arg('--source','.')),out=resolve(arg('--output','work/realm-boundary'));
mkdirSync(out,{recursive:true});
const bundle=buildSync({stdin:{contents:`
export {buildScene,defaultVisibility,landTestOf} from ${JSON.stringify(resolve(source,'src/render/scene.ts'))};
export {drawScene} from ${JSON.stringify(resolve(source,'src/render/canvas.ts'))};
export {sceneToSvg} from ${JSON.stringify(resolve(source,'src/render/svg.ts'))};
export {resolveStyle} from ${JSON.stringify(resolve(source,'src/render/styles.ts'))};
export {pathPolylines} from ${JSON.stringify(resolve(source,'src/render/ice.ts'))};
export {createMapState} from './shared/layers.ts';
export {raggedEdge} from './src/render/coast.ts';
export {hexCorners,hexEdgePoints,neighbourOf,inBounds} from './shared/hex.ts';
`,resolveDir:resolve('.'),loader:'ts'},bundle:true,write:false,format:'iife',globalName:'api',loader:{'.woff2':'dataurl'}}).outputFiles[0].text;
const browser=await launchBrowser();
try{
 const context=await browser.newContext();await serveBuild(context,'.',{'/api.js':bundle});const page=await context.newPage();await page.goto('http://render.test/blank');await page.addScriptTag({url:'http://render.test/api.js'});
 const results=[];
 for(const layout of ['two','triple'])for(const borders of ['straight','ragged','wild'])for(const mode of ['wash','tint','fill']){
  const result=await page.evaluate(async({layout,borders,mode})=>{
   const size=40,map=api.createMapState('Realm boundary',7,7);map.id='realm-frontier-regression';map.defaultIrregularity='Ragged';
   map.layers.base.data=Array.from({length:49},(_,i)=>i%7>=2?'Land':'Sea');
   for(const i of [8,15,22,23])map.layers.base.data[i]='Coastal Land';
   map.hexShapes={'22':{type:'Coastal Land',land:45},'23':{type:'Coastal Land',land:70}};
   const colours={a:'#20a060',b:'#d03020',c:'#b020d0'};
   map.layers.polities.data={polities:Object.entries(colours).map(([id,colour])=>({id,name:id,colour})),owner:map.layers.base.data.map((b,i)=>b==='Sea'?null:layout==='triple'&&i%7>=5?'c':Math.floor(i/7)<3?'a':'b')};
   const opts={size,uniformLand:true,visible:{...api.defaultVisibility(),polities:true},labels:false,style:api.resolveStyle({preset:'parchment',overrides:{polityStyle:mode,polityTone:'vivid',borders,frontier:'solid',water:'flat',grain:false,grid:'none',relief:'none'}})};
   opts.style.palette.land=opts.style.palette.coastalLand='#ffffff';
   const scene=api.buildScene(map,opts),land=api.landTestOf(scene),scale=4;
   const c=document.createElement('canvas');c.width=Math.ceil(scene.width*scale);c.height=Math.ceil(scene.height*scale);const ctx=c.getContext('2d',{willReadFrequently:true});ctx.scale(scale,scale);ctx.fillStyle=scene.background;ctx.fillRect(0,0,scene.width,scene.height);api.drawScene(ctx,scene,undefined,true);
   const png=c.toDataURL().split(',')[1],actual=ctx.getImageData(0,0,c.width,c.height).data;
   const image=new Image();image.src='data:image/svg+xml;base64,'+btoa(unescape(encodeURIComponent(api.sceneToSvg(scene,'Realm frontier'))));await image.decode();
   const sc=document.createElement('canvas');sc.width=c.width;sc.height=c.height;const sx=sc.getContext('2d',{willReadFrequently:true});sx.drawImage(image,0,0,sc.width,sc.height);const svg=sx.getImageData(0,0,sc.width,sc.height).data;
   const alpha=mode==='wash'?.55:mode==='tint'?.75:1;
   const expected={};for(const owner of Object.keys(colours)){const sample=document.createElement('canvas');sample.width=sample.height=1;const s=sample.getContext('2d');s.fillStyle='#fff';s.fillRect(0,0,1,1);s.globalAlpha=alpha;s.fillStyle=colours[owner];s.fillRect(0,0,1,1);expected[owner]=Array.from(s.getImageData(0,0,1,1).data).slice(0,3);}
   const distance=(p,a,b)=>{const dx=b.x-a.x,dy=b.y-a.y,t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy||1)));return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);};
   // Frontier paths live inside the final-land clip.
   const collect=ps=>ps.flatMap(p=>p.kind==='group'?collect(p.prims):p.kind==='path'&&p.stroke===opts.style.palette.frontier?api.pathPolylines(p.d).flatMap(r=>r.slice(1).map((b,i)=>[r[i],b])):[]);
   const sourceEdges=[];
   map.layers.polities.data.owner.forEach((owner,i)=>{if(!owner)return;for(let e=0;e<6;e++){const n=api.neighbourOf(i%7,Math.floor(i/7),e);if(!api.inBounds(7,7,n.col,n.row))continue;const other=map.layers.polities.data.owner[n.row*7+n.col];if(!other||owner>=other)continue;const [a,b]=api.hexEdgePoints(i%7,Math.floor(i/7),e,size);sourceEdges.push({a,b,owner,other});}});
   const edges=collect(scene.prims);let checked=0,canvasErrors=0,svgErrors=0;const samples=[];
   edges.forEach(([a,b],index)=>{const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);if(len<6)return;const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2};const candidates=sourceEdges.map(e=>({...e,d:distance(mid,e.a,e.b)})).sort((a,b)=>a.d-b.d);const source=candidates[0];if(!source||candidates[1]&&candidates[1].d-source.d<2)return;
    for(const t of [.3,.5,.7])for(const side of [-1,1])for(const d of [1.15,2.1]){
     const p={x:a.x+dx*t-dy/len*d*side,y:a.y+dy*t+dx/len*d*side};
     if(![[0,0],[-1,0],[1,0],[0,-1],[0,1]].every(([x,y])=>land({x:p.x+x,y:p.y+y})))continue;
     if(edges.some(([u,v],j)=>j!==index&&distance(p,u,v)<d*1.05))continue;
     const k=(Math.floor(p.y*scale)*c.width+Math.floor(p.x*scale))*4,colour=expected[side===1?source.owner:source.other];checked++;
     const bad=data=>Math.max(...colour.map((v,j)=>Math.abs(v-data[k+j])))>5;
     if(bad(actual)){canvasErrors++;if(samples.length<8)samples.push({p,side,actual:Array.from(actual.slice(k,k+3)),expected:colour});}if(bad(svg))svgErrors++;
    }
   });
   let junctionChecked=0,junctionCanvasErrors=0,junctionSvgErrors=0;
   if(layout==='triple'){
    const vertices=new Map(),regions={};
    map.layers.polities.data.owner.forEach((owner,i)=>{if(!owner)return;regions[owner]??=new Path2D();const corners=api.hexCorners(i%7,Math.floor(i/7),size);
     for(const p of corners){const key=p.x.toFixed(4)+','+p.y.toFixed(4);if(!vertices.has(key))vertices.set(key,{p,owners:new Set()});vertices.get(key).owners.add(owner);}
     const path=regions[owner];path.moveTo(corners[0].x,corners[0].y);
     for(let e=0;e<6;e++){const [a,b]=api.hexEdgePoints(i%7,Math.floor(i/7),e,size),n=api.neighbourOf(i%7,Math.floor(i/7),e);const other=api.inBounds(7,7,n.col,n.row)?map.layers.polities.data.owner[n.row*7+n.col]:null;
      for(const p of other&&other!==owner?api.raggedEdge(a,b,borders,map.id,size):[b])path.lineTo(p.x,p.y);
     }path.closePath();
    });
    for(const {p,owners}of vertices.values())if(owners.size>=3){
     for(let y=p.y-4;y<=p.y+4;y+=.25)for(let x=p.x-4;x<=p.x+4;x+=.25){
      const q={x,y};if(!land(q)||edges.some(([a,b])=>distance(q,a,b)<1.15))continue;
      const owner=Object.keys(regions).find(k=>sx.isPointInPath(regions[k],x,y));if(!owner)continue;
      const k=(Math.floor(y*scale)*c.width+Math.floor(x*scale))*4,colour=expected[owner];junctionChecked++;
      if(Math.max(...colour.map((v,j)=>Math.abs(v-actual[k+j])))>5)junctionCanvasErrors++;
      if(Math.max(...colour.map((v,j)=>Math.abs(v-svg[k+j])))>5)junctionSvgErrors++;
     }
    }
   }
   return{layout,borders,mode,checked,canvasErrors,svgErrors,junctionChecked,junctionCanvasErrors,junctionSvgErrors,samples,png,svgPng:sc.toDataURL().split(',')[1]};
  },{layout,borders,mode});
  for(const [key,suffix]of [['png','canvas'],['svgPng','svg']]){writeFileSync(resolve(out,`${layout}-${borders}-${mode}-${suffix}.png`),Buffer.from(result[key],'base64'));delete result[key];}results.push(result);console.log(JSON.stringify(result));
 }
 writeFileSync(resolve(out,'results.json'),JSON.stringify(results,null,2));
 if(process.argv.includes('--check')&&results.some(r=>r.checked<10||r.canvasErrors||r.svgErrors||r.junctionCanvasErrors||r.junctionSvgErrors||(r.layout==='triple'&&r.junctionChecked<10)))throw Error('Shared frontier paint does not match its border');
 await context.close();
}finally{await browser.close();}
