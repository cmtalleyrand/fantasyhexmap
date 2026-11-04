import assert from 'node:assert/strict';
import test from 'node:test';
import { checkBaseGeography } from '../shared/geography.ts';
import { fixture } from '../scripts/render-profile-input.ts';
import { coastGallery } from '../scripts/coast-gallery-fixtures.ts';
import { landscapeGallery } from '../scripts/render-landscape-fixtures.ts';
import { editCases } from '../scripts/render-edit-fixtures.ts';
import { cases } from '../scripts/drawing-investigation-fixtures.ts';
import { LAKE_STRAIT_CASES, lakeStraitFixture } from './fixtures/lakeStrait.ts';
import { fixture as generated } from '../scripts/render-all-layers-fixture.ts';
import { drawnLandFraction, landFraction, normaliseHexDimensions } from '../shared/surfaceArea.ts';

test('every positive performance, gallery and edit fixture describes coherent geography before rendering', () => {
  const mixed = fixture('mixed');
  for (const type of ['Strait', 'Isthmus', 'Mainland and islands', 'Islands', 'Lake']) {
    assert.ok(mixed.layers.base.data!.some(v => v === type), `mixed benchmark must actually exercise ${type}`);
  }
  const maps = [{ name: 'populated', map: fixture('populated') }, { name: 'mixed', map: fixture('mixed') },
    ...coastGallery(), ...landscapeGallery(), ...editCases(), ...cases(),
    ...LAKE_STRAIT_CASES.map((options, i) => ({ name: `lake-strait-${i}`, map: lakeStraitFixture(options) }))];
  for (const { name, map } of maps) {
    assert.deepEqual(checkBaseGeography(map.layers.base.data!, map.cols, map.rows), [], name);
    const dimensions = normaliseHexDimensions(map.hexDimensions);
    map.layers.base.data!.forEach((v, hex) => {
      if (v !== 'Mainland and islands') return;
      const shape = map.hexShapes?.[String(hex)];
      assert.ok(landFraction(v, map.islandSpecs?.[String(hex)], dimensions, shape)
        > drawnLandFraction(v, dimensions, shape)!, `${name} hex ${hex} must leave land for its offshore islands`);
    });
  }
});

test('offline generation makes coherent geography at small and representative map sizes', () => {
  for (const span of [5, 12, 30, 40]) {
    const map = generated(`coherent-${span}`, span);
    assert.deepEqual(checkBaseGeography(map.layers.base.data!, span, span), [], `${span}×${span}`);
    if (span >= 30) assert.ok(map.layers.base.data!.filter(v => v === 'Lake').length >= 7, 'large maps include a multi-hex lake');
  }
});
