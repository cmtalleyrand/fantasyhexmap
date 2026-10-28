/** Pinned, small counterexamples for the post-#118 drawing investigation. */
import { createMapState } from '../shared/layers.ts';
import { hexCenter, neighbourOf, pixelToOffset } from '../shared/hex.ts';
import type { BaseGeo, River, MapState } from '../shared/types.ts';
import { buildScene, defaultVisibility, landTestOf, symbolsOf } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';
export { buildScene, landTestOf, symbolsOf, hexCenter, pixelToOffset };
export { drawScene } from '../src/render/canvas.ts';
export { sceneToSvg } from '../src/render/svg.ts';
export { auditScene } from '../src/render/audit.ts';
export { textPrims, textBoxes } from '../src/render/collide.ts';
export { riverCourse } from '../src/render/rivers.ts';
export { pathPolylines } from '../src/render/ice.ts';
export { beginRenderProfile, endRenderProfile } from '../src/render/profile.ts';
export function windingRiver(): River {
  const dirs = [0, 1, 0, 1, 2, 1, 0, 0, 5, 0];
  let at = { col: 1, row: 1 };
  const segments = dirs.map((d, k) => {
    const s = { ...at, entryEdge: k === 0 ? null : (dirs[k - 1]! + 3) % 6, exitEdge: d, navigable: k > 4 };
    at = neighbourOf(at.col, at.row, d); return s;
  });
  return { id: 'w', name: 'Wend', terminus: 'OffMap', segments };
}
export function riverMetrics(line: { x: number; y: number }[], river = windingRiver(), size = 20) {
  const hexes = new Set(river.segments.map(s => `${s.col},${s.row}`));
  let outside = 0, maxTurn = 0, turnAt = 0;
  for (const p of line) {
    const probes = [p, ...Array.from({ length: 6 }, (_, k) => ({ x: p.x + Math.cos(k) * size * .04, y: p.y + Math.sin(k) * size * .04 }))];
    if (!probes.some(q => { const h = pixelToOffset(q.x, q.y, size); return hexes.has(`${h.col},${h.row}`); })) outside++;
  }
  for (let i = 2; i < line.length; i++) {
    const a = line[i-2]!, b = line[i-1]!, c = line[i]!;
    let turn = Math.abs(Math.atan2(c.y-b.y,c.x-b.x)-Math.atan2(b.y-a.y,b.x-a.x));
    if (turn > Math.PI) turn = 2*Math.PI-turn;
    if (turn > maxTurn) { maxTurn = turn; turnAt = i-1; }
  }
  return { outside, maxTurn: maxTurn * 180 / Math.PI, turnAt };
}
export function coastMap(share = 20, id = 'drawing-investigation'): MapState {
  const map = createMapState('Drawn coast', 5, 4); map.id = id;
  map.layers.base.data = ['Land','Land','Land','Land','Land','Land','Land','Land','Land','Land','Sea','Sea','Land','Sea','Sea','Sea','Sea','Sea','Sea','Sea'];
  map.hexShapes = { '12': { type: 'Land', land: share } };
  map.layers.elevation.data = map.layers.base.data.map((b, i) => b === 'Sea' ? null : i === 12 ? 'Mountains' : 'Hills');
  return map;
}
export function options(preset: 'parchment' | 'atlas' | 'classic' = 'parchment', relief: 'illustrated' | 'hillshade' | 'marks' | 'none' = 'illustrated') {
  return { size: 40, visible: { ...defaultVisibility(), elevation: true, vegetation: true, polities: true, rivers: true, cities: true }, labels: true, polityNames: 1 as const, riverNames: true, seaNames: true,
    style: resolveStyle({ preset, overrides: { grain: false, grid: 'none', relief } }) };
}
export function cases() {
  const out: { name: string; map: MapState; opts: ReturnType<typeof options> }[] = [];
  for (const [preset, share, seed] of [['classic', 20, 'coverage-1'], ['parchment', 5, 'coverage-2']] as const) {
    const map = coastMap(share, seed); map.hexDimensions.coastalLandPercent = 80;
    out.push({ name: `coast-fit-${preset}`, map, opts: options(preset, 'none') });
  }
  for (const share of [5,10,20,50,90]) out.push({ name: `coast-${share}`, map: coastMap(share), opts: options() });
  for (const kind of ['Islands','Strait','Isthmus','Glacier','Lake'] as BaseGeo[]) {
    const map = coastMap(20, `investigation-${kind}`);
    map.layers.base.data![12] = kind;
    map.hexShapes = { '12': { type: kind, land: 10, width: 'Very narrow', irregular: 'Fractured' } };
    if (kind === 'Strait' || kind === 'Isthmus') map.layers.base.data![11] = map.layers.base.data![13] = 'Land';
    if (kind === 'Islands') map.islandSpecs = { '12': { large: 1, small: 2 } };
    out.push({ name: kind.toLowerCase(), map, opts: options() });
  }
  for (const relief of ['illustrated','hillshade','marks'] as const) {
    const map = coastMap(20);
    map.layers.polities.data = { polities: [{ id:'a',name:'Ahnver',colour:'#c03030' },{ id:'b',name:'Hillmark',colour:'#5050c0' }], owner: map.layers.base.data!.map((b,i)=>b==='Sea'?null:i===12?'a':'b'), shares: { '12': { polityId:'b',share:.5 } } };
    map.layers.cities.data = { cities: [{ id:'c',name:'Port',col:2,row:2,population:1000,capital:false,coastal:true,coastalEdges:[0,1,2],onRiver:false,riverId:null,site:{ offset: { x:0,y:.7 } } }] };
    out.push({ name:`realm-${relief}`,map,opts:options('parchment',relief) });
  }
  const lake = createMapState('Lake island', 7, 7); lake.id = 'lake-isle';
  lake.layers.base.data = Array(49).fill('Land');
  for (let r=1;r<6;r++) for(let c=1;c<6;c++) lake.layers.base.data[r*7+c]='Lake';
  lake.layers.base.data[24]='Islands'; lake.islandSpecs={'24':{large:1,small:0}};
  lake.layers.elevation.data=Array(49).fill(null);lake.layers.elevation.data[24]='Mountains';
  out.push({name:'lake-island',map:lake,opts:options()});
  for(const width of ['Very narrow','Normal'] as const) {
    const map=createMapState('Strait ink',7,7);map.id='strait-ink';
    map.layers.base.data=Array.from({length:49},(_,i)=>i%7===3?'Sea':'Land');map.layers.base.data[24]='Strait';
    map.hexShapes={'24':{type:'Strait',width}};
    const opts=options();opts.labels=false;
    out.push({name:`strait-${width==='Normal'?'normal':'very-narrow'}`,map,opts});
  }
  const named=createMapState('Small named sea',5,5);named.id='named-sea';
  named.layers.base.data=Array(25).fill('Land');named.layers.base.data[12]='Sea';
  named.geoNames=[{id:'sea',kind:'sea',name:'The Sea of the Long Forgotten Kings',hexes:[12]}];
  out.push({name:'small-sea-name',map:named,opts:options()});
  const namedLake=structuredClone(named);namedLake.id='named-lake';namedLake.layers.base.data![12]='Lake';
  namedLake.geoNames=[{id:'lake',kind:'lake',name:'The Lake of the Long Forgotten Kings',hexes:[12]}];
  out.push({name:'small-lake-name',map:namedLake,opts:options()});
  const mouth=coastMap(10,'river-mouth');
  mouth.layers.rivers.data={rivers:[{id:'mouth',name:'Wend',terminus:'Sea',segments:[
    {col:2,row:1,entryEdge:null,exitEdge:2,navigable:false},
    {col:2,row:2,entryEdge:5,exitEdge:1,navigable:true},
  ]}]};
  out.push({name:'river-mouth',map:mouth,opts:options()});
  return out;
}
