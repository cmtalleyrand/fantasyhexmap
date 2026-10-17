/** Write the coast feature benchmark map to work/feature-map.json for the browser checks: node --import tsx scripts/make-feature-map.ts [size] */
import { writeFileSync } from 'node:fs';
import { createMapState } from '../shared/layers.ts';
import { neighbourOf, inBounds, hexIndex } from '../shared/hex.ts';
import { featureFixture } from './coastFeatureFixture.ts';
const map = featureFixture({ createMapState, neighbourOf, inBounds, hexIndex }, Number(process.argv[2] ?? 30), 'mixed');
writeFileSync('work/feature-map.json', JSON.stringify(map));
