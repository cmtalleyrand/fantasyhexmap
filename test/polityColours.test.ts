import test from 'node:test';
import assert from 'node:assert/strict';
import { createMapState } from '../shared/layers.ts';
import { reducer } from '../src/state/store.ts';
import { applyAutoShade } from '../shared/polityShade.ts';
import { polityOutline } from '../shared/polityTree.ts';
import { contrastingPolityColours, toLab } from '../src/render/palette.ts';
import { parseHexColour } from '../src/components/CommitInput.tsx';

function realmMap() {
  const map = createMapState('Shade', 6, 1);
  map.layers.base.data = Array(6).fill('Land');
  map.layers.polities.data = {
    polities: [
      { id: 'k', name: 'Kingdom', colour: '#336699' },
      { id: 'd1', name: 'Duchy One', colour: '#000000', parentId: 'k' },
      { id: 'd2', name: 'Duchy Two', colour: '#000000', parentId: 'k' },
      { id: 'n', name: 'Neighbour', colour: '#aa3333' },
    ],
    owner: ['d1', 'd1', 'd2', 'd2', 'n', 'n'],
  };
  return map;
}

test('the outline groups each realm with its parts, however the list is ordered', () => {
  const rows = polityOutline([
    { id: 'd1', name: 'D1', colour: '#111111', parentId: 'k' },
    { id: 'n', name: 'N', colour: '#222222' },
    { id: 'k', name: 'K', colour: '#333333' },
    { id: 'c', name: 'C', colour: '#444444', parentId: 'd1' },
  ]);
  assert.deepEqual(rows.map((r) => [r.polity.id, r.depth, r.parts]), [
    ['n', 0, 0],
    ['k', 0, 2],
    ['d1', 1, 1],
    ['c', 2, 0],
  ]);
});

test('auto-shaded parts follow their realm’s colour, through every level', () => {
  const map = realmMap();
  const shaded = reducer(map, { type: 'setPolityAutoShade', ids: ['d1', 'd2'], on: true });
  const colour = (m: typeof map, id: string) => m.layers.polities.data!.polities.find((p) => p.id === id)!.colour;
  assert.notEqual(colour(shaded, 'd1'), '#000000');
  assert.notEqual(colour(shaded, 'd1'), colour(shaded, 'd2'));

  const recoloured = reducer(shaded, {
    type: 'upsertPolity',
    polity: { ...shaded.layers.polities.data!.polities[0]!, colour: '#993333' },
  });
  assert.notEqual(colour(recoloured, 'd1'), colour(shaded, 'd1'));
  assert.equal(colour(recoloured, 'd1'), applyAutoShade([{ id: 'k', name: 'K', colour: '#993333' }, { id: 'd1', name: 'D', colour: '', parentId: 'k', autoShade: true }])[1]!.colour);

  // Picking a part's colour by hand (flag cleared) stops it following.
  const d1 = recoloured.layers.polities.data!.polities.find((p) => p.id === 'd1')!;
  const { autoShade: _off, ...hand } = d1;
  const manual = reducer(recoloured, { type: 'upsertPolity', polity: { ...hand, colour: '#00ff00' } });
  const again = reducer(manual, {
    type: 'upsertPolity',
    polity: { ...manual.layers.polities.data!.polities[0]!, colour: '#222222' },
  });
  assert.equal(colour(again, 'd1'), '#00ff00');
  assert.notEqual(colour(again, 'd2'), colour(manual, 'd2'));
});

test('removing a realm releases its parts from shading', () => {
  const shaded = reducer(realmMap(), { type: 'setPolityAutoShade', ids: ['d1'], on: true });
  const removed = reducer(shaded, { type: 'removePolity', id: 'k' });
  const d1 = removed.layers.polities.data!.polities.find((p) => p.id === 'd1')!;
  assert.equal(d1.autoShade, undefined);
  assert.equal(d1.parentId, undefined);
});

test('assigning contrasting colours can shade the parts and keep them following', () => {
  const map = realmMap();
  const out = reducer(map, { type: 'setPolityColours', colours: { k: '#2244aa', n: '#dd8822' }, autoShade: true });
  const ps = out.layers.polities.data!.polities;
  assert.equal(ps.find((p) => p.id === 'd1')!.autoShade, true);
  assert.equal(ps.find((p) => p.id === 'n')!.autoShade, undefined);
  assert.equal(ps.find((p) => p.id === 'k')!.colour, '#2244aa');
});

test('contrast: tones, border-weighted separation, and determinism', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const owner = ['a', 'b', 'c', 'd', 'e', 'f'];
  const dist = (x: string, y: string) => Math.hypot(...toLab(x).map((v, i) => v - toLab(y)[i]!));
  for (const tone of ['vivid', 'muted', 'pastel'] as const) {
    const colours = contrastingPolityColours(ids, owner, 6, 1, { tone });
    assert.equal(new Set(colours.values()).size, 6);
    for (let i = 0; i + 1 < ids.length; i++) {
      assert.ok(dist(colours.get(ids[i]!)!, colours.get(ids[i + 1]!)!) > 25, `${tone}: neighbours ${i} differ`);
    }
    assert.deepEqual(colours, contrastingPolityColours(ids, owner, 6, 1, { tone }));
  }
  const pastel = [...contrastingPolityColours(ids, owner, 6, 1, { tone: 'pastel' }).values()];
  const vivid = [...contrastingPolityColours(ids, owner, 6, 1, { tone: 'vivid' }).values()];
  const meanL = (cs: string[]) => cs.reduce((s, c) => s + toLab(c)[0], 0) / cs.length;
  assert.ok(meanL(pastel) > meanL(vivid));
});

test('hex codes are normalised, and anything else is refused', () => {
  assert.equal(parseHexColour('ABC'), '#aabbcc');
  assert.equal(parseHexColour(' #A1B2C3 '), '#a1b2c3');
  assert.equal(parseHexColour('#12345'), null);
  assert.equal(parseHexColour('red'), null);
});
