"""Chromium fidelity, cold-build and real MapView responsiveness comparison.
Prepare with node scripts/render-comparison-bundle.mjs work/baseline.
Uses the environment's installed Python Playwright; no package download required.
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'work/comparison'
report = {'baseline': sys.argv[1] if len(sys.argv) > 1 else 'c6bced3', 'browser': 'Chromium, software raster, one raster thread', 'cold': [], 'navigation': []}
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='/usr/bin/chromium', args=['--no-sandbox', '--disable-gpu', '--num-raster-threads=1'])
    report['chromium'] = browser.version
    for run in range(3):
        page = browser.new_page()
        for version in ['before', 'after']:
            page.add_script_tag(path=str(OUT / (version + '.js')))
        result = page.evaluate('''async run => {
          const map = afterApi.fixture(`all-layer-performance${run}`), opts = afterApi.options();
          await beforeApi.loadLettering(opts.style.knobs.lettering); await afterApi.loadLettering(opts.style.knobs.lettering);
          await document.fonts.ready;
          const scenes = {}, pixels = {}, times = {};
          for (const name of (run % 2 ? ['after','before'] : ['before','after'])) {
            const api = name === 'after' ? afterApi : beforeApi;
            const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 800;
            const ctx = canvas.getContext('2d'); ctx.scale(.5,.5);
            const start = performance.now(), scene = api.buildScene(structuredClone(map),opts), built = performance.now();
            api.drawScene(ctx, scene); pixels[name] = ctx.getImageData(0,0,1000,800).data;
            times[name] = {buildMs:built-start,totalMs:performance.now()-start}; scenes[name] = JSON.stringify(scene);
          }
          let differences = 0; for(let i=0;i<pixels.before.length;i++) if(pixels.before[i]!==pixels.after[i]) differences++;
          return {run,times,identicalScene:scenes.before===scenes.after,pixelDifferences:differences};
        }''', run)
        report['cold'].append(result)
        print(json.dumps(result), flush=True)
        page.close()
    # Real MapView: observe the worker boundary and the main-thread heartbeat.
    for version in ['before', 'after']:
        for dpr in [1, 2]:
            page = browser.new_page(viewport={'width': 1000, 'height': 800}, device_scale_factor=dpr)
            page.set_content('<style>.mapwrap{width:800px;height:600px;position:relative}.maphud{position:absolute;bottom:0}canvas{display:block}</style><div id="root"></div>')
            page.evaluate('''() => {
              window.jobs=0; window.paints=0; window.builds=0; window.sceneTransfers=0; window.tasks=[]; window.gaps=[]; window.phase='cold';
              new PerformanceObserver(list=>window.tasks.push(...list.getEntries().map(e=>({phase:window.phase,ms:e.duration})))).observe({type:'longtask',buffered:true});
              let last=performance.now(); const frame=t=>{window.gaps.push({phase:window.phase,ms:t-last});last=t;requestAnimationFrame(frame)};requestAnimationFrame(frame);
              const W=window.Worker; window.Worker=class extends W {
                constructor(...args){super(...args);this.addEventListener('message',({data})=>{if(data.id!==undefined){if(data.complete!==false)window.jobs--;if(data.bitmap)window.paints++;}})}
                postMessage(data,...rest){if(data.type==='paint'){window.lastView=data;}if(data.type==='paint'||data.type==='build')window.jobs++;if(data.type==='build')window.builds++;if(data.type==='scene')window.sceneTransfers++;super.postMessage(data,...rest)}
              };
            }''')
            page.add_script_tag(path=str(OUT / (version + '.js')))
            page.evaluate('(version)=>{window.started=performance.now();window.cleanup=(version==="after"?afterApi:beforeApi).mount(true)}', version)
            page.wait_for_function('window.paints>0 && window.jobs===0', timeout=120000)
            page.wait_for_timeout(300)
            cold = page.evaluate('''() => ({ms:performance.now()-window.started,maxFrameGapMs:Math.max(...window.gaps.filter(g=>g.phase==='cold').map(g=>g.ms)),longTasks:window.tasks.filter(t=>t.phase==='cold'),builds:window.builds,sceneTransfers:window.sceneTransfers})''')
            page.evaluate("window.phase='reference'")
            reference = page.evaluate("""version => {
              const api = version==='after'?afterApi:beforeApi, frame=window.lastView;
              const scene=api.buildScene(api.fixture('all-layer-performance0'),{...api.options(),polityNames:4,cityStateMax:4,polityOpacity:1});
              const canvas=new OffscreenCanvas(Math.floor(frame.size.width*frame.dpr),Math.floor(frame.size.height*frame.dpr));
              const ctx=canvas.getContext('2d',{alpha:false});ctx.setTransform(frame.dpr,0,0,frame.dpr,0,0);
              ctx.fillStyle=api.MAP_COLOURS.background;ctx.fillRect(0,0,frame.size.width,frame.size.height);
              ctx.translate(frame.view.x,frame.view.y);ctx.scale(frame.view.scale,frame.view.scale);
              ctx.fillStyle=scene.background;ctx.fillRect(0,0,scene.width,scene.height);api.drawScene(ctx,scene,undefined,true);
              const a=ctx.getImageData(0,0,canvas.width,canvas.height).data,b=document.querySelector('canvas').getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
              let channels=0,maxDelta=0;for(let i=0;i<a.length;i++){const d=Math.abs(a[i]-b[i]);if(d)channels++;maxDelta=Math.max(maxDelta,d);}
              return {channels,maxDelta};
            }""", version)
            page.evaluate('''() => {window.phase='navigation';window.fills=0;window.strokes=0;window.copies=0;for(const [method,counter] of [['fill','fills'],['stroke','strokes'],['drawImage','copies']]){const old=CanvasRenderingContext2D.prototype[method];CanvasRenderingContext2D.prototype[method]=function(...args){window[counter]++;return old.apply(this,args)}}}''')
            canvas = page.locator('.mapwrap canvas').first
            bounds = canvas.bounding_box()
            page.mouse.move(bounds['x']+400,bounds['y']+300)
            for _ in range(8):
                page.mouse.wheel(0,-120)
                page.wait_for_timeout(40)
            page.wait_for_function('window.jobs===0', timeout=30000)
            page.wait_for_timeout(400)
            wheel = page.evaluate('() => ({fills:window.fills,strokes:window.strokes,copies:window.copies,maxFrameGapMs:Math.max(...window.gaps.filter(g=>g.phase==="navigation").map(g=>g.ms)),longTasks:window.tasks.filter(t=>t.phase==="navigation")})')
            page.evaluate("window.phase='pan';window.fills=0;window.strokes=0")
            for _ in range(3):
                page.mouse.move(bounds['x']+180,bounds['y']+300)
                page.mouse.down(button='right')
                page.mouse.move(bounds['x']+620,bounds['y']+300, steps=2)
                page.mouse.up(button='right')
                page.wait_for_timeout(250)
            page.wait_for_function('window.jobs===0', timeout=30000)
            page.wait_for_timeout(300)
            pan = page.evaluate('() => ({fills:window.fills,strokes:window.strokes,maxFrameGapMs:Math.max(...window.gaps.filter(g=>g.phase==="pan").map(g=>g.ms)),longTasks:window.tasks.filter(t=>t.phase==="pan")})')
            page.get_by_role('button', name='fit', exact=True).click()
            page.wait_for_timeout(400)
            page.wait_for_function('window.jobs===0', timeout=30000)
            base = canvas.evaluate('(c)=>c.toDataURL()')
            page.evaluate("window.fills=0;window.strokes=0;window.copies=0")
            page.mouse.click(bounds['x']+400,bounds['y']+300)
            page.wait_for_timeout(100)
            selection = page.evaluate('''base => ({unchanged:document.querySelector('canvas').toDataURL()===base,fills:window.fills,strokes:window.strokes,copies:window.copies,overlayInk:document.querySelectorAll('canvas')[1].getContext('2d').getImageData(0,0,800,600).data.some((v,i)=>i%4===3&&v>0)})''', base)
            row = {'version':version,'dpr':dpr,'cold':cold,'wheel':wheel,'pan':pan,'selection':selection,'workerReference':reference}
            report['navigation'].append(row)
            print(json.dumps(row), flush=True)
            page.screenshot(path=str(OUT / f'{version}-dpr{dpr}.png'))
            page.close()
    browser.close()
OUT.mkdir(parents=True,exist_ok=True)
(OUT / 'browser-results.json').write_text(json.dumps(report,indent=2)+'\n')
assert all(r['identicalScene'] and not r['pixelDifferences'] for r in report['cold']), 'Coastline scene/pixel regression'
for row in report['navigation']:
    assert row['workerReference']['channels']==0, 'Worker differs from synchronous reference'
    assert row['selection']['unchanged'] and row['selection']['overlayInk'], 'Selection damaged base or missing overlay'
    assert row['wheel']['fills']==0 and row['pan']['fills']==0, 'Main-thread navigation geometry paint'
    if row['version']=='after':
        assert row['cold']['builds']==1 and row['cold']['sceneTransfers']==0, 'Construction did not stay in worker'
