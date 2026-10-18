/** Full-scene equality across coast policies and incremental edits. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMapState } from '../shared/layers.ts';
import { CHANNEL_WIDTH_VALUES, type BaseGeo, type Irregularity } from '../shared/types.ts';
import { SceneInputs } from '../src/render/sceneInputs.ts';
import { buildStaticScene, defaultVisibility } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';
const baseline = await import(pathToFileURL(resolve(process.argv[2] || 'work/baseline', 'src/render/scene.ts')).href);
const hash = (scene: unknown) => createHash('sha256').update(JSON.stringify(scene)).digest('hex');
const results: unknown[] = [];
for (const irregular of ['Smooth', 'Wavy', 'Ragged', 'Fractured'] as Irregularity[]) {
  for (const kind of ['Strait', 'Isthmus', 'Coastal Land', 'Lake', 'Glacier', 'Sea Ice', 'Islands'] as BaseGeo[]) {
    for (const extreme of [0,1]) {
      const map = createMapState('Coast fidelity',7,7); map.id = `fidelity-${irregular}-${kind}-${extreme}`;
      map.defaultIrregularity = irregular;
      map.layers.base.data = Array.from({length:49},(_,i)=> (i%7<3?'Coastal Land':'Sea') as BaseGeo);
      map.layers.base.data[24]=kind;
      map.layers.base.data[23]='Land'; map.layers.base.data[18]='Land';
      map.layers.base.data[3]='Lake'; map.layers.base.data[45]='Islands';
      map.hexShapes = {'24':{type:kind,irregular,land:extreme?90:10,...(kind==='Strait'||kind==='Isthmus'?{width:CHANNEL_WIDTH_VALUES[extreme?3:0]}:{})}};
      const options = {size:26,visible:defaultVisibility(),labels:true,style:resolveStyle({preset:'parchment',overrides:{coast:'smooth'}})};
      const inputs = new SceneInputs();
      const original = inputs.retain(structuredClone(map));
      const initial = buildStaticScene(original,options);
      const initialHash = hash(initial);
      assert.equal(initialHash,hash(baseline.buildStaticScene(structuredClone(map),options)),`${map.id} initial`);
      const edit = structuredClone(map);edit.layers.base.data![25]='Coastal Land';
      const edited=buildStaticScene(inputs.retain(edit),options);
      assert.equal(hash(edited),hash(baseline.buildStaticScene(structuredClone(edit),options)),`${map.id} edit`);
      assert.equal(hash(buildStaticScene(inputs.retain(structuredClone(map)),options)),initialHash,`${map.id} undo`);
      results.push({irregular,kind,extreme,initialHash,editedHash:hash(edited),identical:true});
    }
  }
}
writeFileSync('work/coast-fidelity.json',JSON.stringify({baseline:process.argv[3] || 'c6bced3',cases:results},null,2)+'\n');
console.log(`${results.length} coast policy fixtures match baseline before/after edits and undo`);
