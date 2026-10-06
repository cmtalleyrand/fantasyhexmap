import { writeFileSync, mkdirSync } from 'node:fs';
import { createMapState } from '../shared/layers.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';
import { sceneToSvg } from '../src/render/svg.ts';
import type { BaseGeo, Irregularity } from '../shared/types.ts';
const stage = process.argv[2] ?? 'after';
const seed = process.argv[3] ?? 'coast-evidence';
const level = process.argv[4] ?? 'Ragged';
if (!['Wavy', 'Ragged', 'Fractured'].includes(level)) throw new Error('Use Wavy, Ragged or Fractured.');
mkdirSync('work/evidence', { recursive: true });
const fixtures: Record<string, Array<[
  number,
  number
]>> = {
  'three-hex-chain': [[3, 2], [3, 3], [4, 4]],
  'long-chain': [[2, 2], [3, 2], [3, 3], [4, 3], [4, 4], [5, 4], [5, 5]],
  'bay': [[2, 2], [3, 2], [4, 2], [5, 2], [2, 3], [3, 3], [5, 3], [2, 4], [5, 4], [2, 5], [3, 5], [4, 5], [5, 5]],
  'isthmus': [[2, 3], [3, 3], [4, 3]],
  'strait': [[2, 2], [3, 2], [4, 2], [2, 4], [3, 4], [4, 4]],
};
for (const [name, land] of Object.entries(fixtures)) {
  const map = createMapState('Coast evidence', 8, 8);
  map.id = seed;
  const base: BaseGeo[] = Array(64).fill('Sea');
  for (const [c, r] of land)
    base[r * 8 + c] = 'Coastal Land';
  if (name === 'isthmus')
    base[27] = 'Isthmus';
  if (name === 'strait')
    base[27] = 'Strait';
  map.layers.base.data = base;
  map.defaultIrregularity = level as Irregularity;
  const visibility = defaultVisibility();
  const scene = buildScene(map, { size: 30, visible: visibility, labels: false, style: resolveStyle({ preset: 'parchment' }) });
  writeFileSync(`work/evidence/${name}-${stage}.svg`, sceneToSvg(scene, name));
}
