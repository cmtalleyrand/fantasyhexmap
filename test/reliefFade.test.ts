import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import type { BaseGeo, Elevation } from '../shared/types.ts';
import type { Prim } from '../src/render/prims.ts';
import { buildScene, defaultVisibility } from '../src/render/scene.ts';
import { resolveStyle } from '../src/render/styles.ts';

function mountainRealm() {
  const cols = 24;
  const rows = 12;
  const map = createMapState('Fade test', cols, rows);
  map.layers.base.data = Array<BaseGeo>(cols * rows).fill('Land');
  map.layers.elevation.data = Array<Elevation>(cols * rows).fill('Mountains');
  map.layers.polities.data = {
    polities: [{ id: 'a', name: 'Highmark', colour: '#aa5533' }],
    owner: Array<string | null>(cols * rows).fill('a'),
  };
  return map;
}

function fadedGroups(prims: Prim[]) {
  return prims.filter((p): p is Extract<Prim, { kind: 'group' }> => p.kind === 'group' && p.opacity !== undefined);
}

/** Drawn prims other than text, groups opened up. */
function drawn(prims: Prim[]): number {
  return prims.reduce((n, p) => n + (p.kind === 'group' ? drawn(p.prims) : p.kind === 'text' ? 0 : 1), 0);
}

test('relief under a realm name is faded, and only there', () => {
  const map = mountainRealm();
  const visible = defaultVisibility();
  visible.elevation = true;
  visible.polities = true;
  const style = resolveStyle({ preset: 'parchment', overrides: { relief: 'illustrated' } });
  const named = buildScene(map, { size: 24, visible, labels: true, polityNames: 0, style });
  const bare = buildScene(map, { size: 24, visible, labels: false, polityNames: 0, style });
  const faded = fadedGroups(named.prims);
  assert.ok(faded.length > 0, 'some symbols lie under the name and are faded');
  assert.ok(faded.every((g) => g.opacity! > 0 && g.opacity! < 1));
  assert.equal(fadedGroups(bare.prims).length, 0, 'with no names nothing is faded');
  assert.equal(drawn(named.prims), drawn(bare.prims), 'fading keeps every symbol');
  const share = drawn(faded) / drawn(named.prims);
  assert.ok(share > 0 && share < 0.4, `the faded share ${share.toFixed(2)} is a band round the name, not the whole map`);
});

test('faded relief reaches the SVG export as an opacity group', async () => {
  const { sceneToSvg } = await import('../src/render/svg.ts');
  const map = mountainRealm();
  const visible = defaultVisibility();
  visible.elevation = true;
  visible.polities = true;
  const style = resolveStyle({ preset: 'parchment', overrides: { relief: 'illustrated' } });
  const scene = buildScene(map, { size: 24, visible, labels: true, polityNames: 0, style });
  assert.ok(/<g opacity="0\.4">/.test(sceneToSvg(scene, 'Fade test')), 'the SVG carries the faded group');
});
