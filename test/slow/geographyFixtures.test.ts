import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, options } from '../../scripts/render-profile-input.ts';
import { coastGallery } from '../../scripts/coast-gallery-fixtures.ts';
import { landscapeGallery } from '../../scripts/render-landscape-fixtures.ts';
import { auditGeography } from '../../src/render/geographyAudit.ts';
import { buildStaticScene, islandTestOf, landTestOf, singleLayerVisibility } from '../../src/render/scene.ts';

test('coherent representative inputs render attached mainland, detached islands and connected passages', () => {
  const maps = [{ name: 'populated', map: fixture('populated') }, { name: 'mixed', map: fixture('mixed') },
    ...landscapeGallery(), ...coastGallery()];
  const opts = { ...options(), visible: singleLayerVisibility('base'), labels: false,
    riverNames: false, rangeNames: false, seaNames: false, landNames: false };
  for (const { name, map } of maps) {
    const scene = buildStaticScene(map, opts);
    assert.deepEqual(auditGeography(map.layers.base.data!, map.cols, map.rows, opts.size,
      landTestOf(scene)!, islandTestOf(scene)), [], name);
  }
});
