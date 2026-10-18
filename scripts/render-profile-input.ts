import { coastGallery } from './coast-gallery-fixtures.ts';
import frozen from '../test/fixtures/populated-40.json';
import type { MapState } from '../shared/types.ts';
import { createMapState } from '../shared/layers.ts';
import { neighbourOf, inBounds, hexIndex } from '../shared/hex.ts';
import { featureFixture } from './coastFeatureFixture.ts';
export { options, drawScene } from './render-all-layers-fixture.ts';
export function fixture(kind = 'populated'): MapState {
  return kind === 'populated' ? structuredClone(frozen) as MapState
    : featureFixture({ createMapState, neighbourOf, inBounds, hexIndex }, 30, 'mixed');
}

export { coastGallery };
