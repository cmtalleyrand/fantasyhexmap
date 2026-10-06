import { createRoot } from 'react-dom/client';
import {createElement,useState} from 'react';
import MapView from '../src/components/MapView.tsx';
import {createMapState} from '../shared/layers.ts';
import {defaultVisibility} from '../src/render/scene.ts';
import {resolveStyle} from '../src/render/styles.ts';
export function mount() {
 const map=createMapState('Interaction performance',30,30);map.id='interaction-performance';
 map.layers.base.data=Array.from({length:900},(_,i)=>(i%30)<15+Math.sin(Math.floor(i/30)/3)*3?'Coastal Land':'Sea');
 const noop=()=>{}; const visible=defaultVisibility(), mapStyle=resolveStyle({preset:'parchment',overrides:{coast:'smooth'}});
 const root=createRoot(document.getElementById('root')!);
 function View(){const [selection,setSelection]=useState(new Set<number>());return createElement(MapView,{map,visible,labels:false,riverNames:false,rangeNames:false,seaNames:false,landNames:false,polityNames:4,cityStateMax:4,polityOpacity:1,mapStyle,selection,onSelectionChange:setSelection,onStrokeEnd:null,activeLayer:'base',riverDraft:null,onRiverDraftClick:null,onCityMove:null,riverTool:null,onRiverSelect:noop,onRiverMove:noop,onRiverExtend:noop,onRiverPaint:noop});}
 root.render(createElement(View));
 return ()=>root.unmount();
}

export {createMapState,defaultVisibility,resolveStyle};
export {buildScene} from '../src/render/scene.ts';
export {drawScene,drawPrims} from '../src/render/canvas.ts';
