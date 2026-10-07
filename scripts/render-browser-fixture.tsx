import { createRoot } from 'react-dom/client';
import {createElement,useState} from 'react';
import MapView from '../src/components/MapView.tsx';
import {createMapState} from '../shared/layers.ts';
import {defaultVisibility} from '../src/render/scene.ts';
import {resolveStyle} from '../src/render/styles.ts';
import { fixture, options } from './render-all-layers-fixture.ts';
export function mount(allLayers = false) {
 const map=allLayers?fixture('all-layer-performance0'):createMapState('Interaction performance',30,30);
 if(!allLayers){map.id='interaction-performance';map.layers.base.data=Array.from({length:900},(_,i)=>(i%30)<15+Math.sin(Math.floor(i/30)/3)*3?'Coastal Land':'Sea');}
 const noop=()=>{}; const visible=allLayers?options().visible:defaultVisibility(), mapStyle=resolveStyle({preset:'parchment',overrides:{coast:'smooth'}});
 const root=createRoot(document.getElementById('root')!);
 function View(){const [selection,setSelection]=useState(new Set<number>());return createElement(MapView,{map,visible,labels:allLayers,riverNames:allLayers,rangeNames:allLayers,seaNames:allLayers,landNames:allLayers,polityNames:4,cityStateMax:4,polityOpacity:1,mapStyle,selection,onSelectionChange:setSelection,onStrokeEnd:null,activeLayer:'base',riverDraft:null,onRiverDraftClick:null,onCityMove:null,riverTool:null,onRiverSelect:noop,onRiverMove:noop,onRiverExtend:noop,onRiverPaint:noop});}
 root.render(createElement(View));
 return ()=>root.unmount();
}

export {createMapState,defaultVisibility,resolveStyle};
export {buildScene} from '../src/render/scene.ts';
export {drawScene,drawPrims} from '../src/render/canvas.ts';
export {MAP_COLOURS} from '../src/render/palette.ts';
