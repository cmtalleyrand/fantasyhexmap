import assert from 'node:assert/strict';
import test from 'node:test';
import { contextFromMap } from '../core/context.ts';
import { decodeLayer } from '../core/decode.ts';
import { encodeBase } from '../shared/codec.ts';
import { checkBaseGeography, geographyCategory, GEOGRAPHY_WARNING_PREFIX } from '../shared/geography.ts';
import { hexCenter, neighbourOf, pixelToOffset, type Point } from '../shared/hex.ts';
import { createMapState } from './seededMap.ts';
import type { BaseGeo } from '../shared/types.ts';
import { auditGeography } from '../src/render/geographyAudit.ts';
import { buildStaticScene, islandTestOf, landTestOf, singleLayerVisibility, withLandOf } from '../src/render/scene.ts';
import { landscapeGallery } from '../scripts/render-landscape-fixtures.ts';
import { resolveStyle } from '../src/render/styles.ts';
import { reducer } from '../src/state/store.ts';

const landTypes = ['Land', 'Glacier', 'Mainland and islands', 'Isthmus', 'Strait'] as const;
const waterTypes = ['Sea', 'Lake', 'Sea Ice', 'Islands'] as const;
function ring(type: BaseGeo, row = 2) {
  const cols = 7, rows = 7, hex = row * cols + 3;
  const base: BaseGeo[] = Array(cols * rows).fill('Sea'); base[hex] = type;
  const neighbours = Array.from({ length: 6 }, (_, edge) => {
    const n = neighbourOf(3, row, edge); return n.row * cols + n.col;
  });
  return { base, cols, rows, hex, neighbours };
}

test('geography categories include strait banks as land and islands as water', () => {
  for (const type of landTypes) assert.equal(geographyCategory(type), 'land', type);
  for (const type of waterTypes) assert.equal(geographyCategory(type), 'water', type);
  assert.equal(geographyCategory(null), null);
});

test('passages require exactly two land and four water neighbours, on both row parities', () => {
  for (const type of ['Isthmus', 'Strait'] as const) for (const row of [2, 3]) {
    for (const land of landTypes) for (const water of waterTypes) {
      const f = ring(type, row);
      f.neighbours.forEach((h, edge) => { f.base[h] = edge === 0 || edge === 3 ? land : water; });
      assert.equal(checkBaseGeography(f.base, f.cols, f.rows).some(i => i.hex === f.hex), false, `${type}/${row}/${land}/${water}`);
      f.base[f.neighbours[1]!] = 'Land';
      assert.equal(checkBaseGeography(f.base, f.cols, f.rows).find(i => i.hex === f.hex)?.kind, 'passage-neighbours');
      f.base[f.neighbours[0]!] = 'Sea'; f.base[f.neighbours[1]!] = 'Sea';
      assert.equal(checkBaseGeography(f.base, f.cols, f.rows).find(i => i.hex === f.hex)?.kind, 'passage-neighbours');
    }
  }
});

test('mainland-and-islands needs both categories; missing map-edge neighbours are not water', () => {
  for (const land of landTypes) for (const water of waterTypes) {
    const f = ring('Mainland and islands');
    f.neighbours.forEach(h => { f.base[h] = water; });
    assert.ok(checkBaseGeography(f.base, f.cols, f.rows).some(i => i.hex === f.hex));
    f.base[f.neighbours[0]!] = land;
    assert.equal(checkBaseGeography(f.base, f.cols, f.rows).some(i => i.hex === f.hex), false);
    f.neighbours.forEach(h => { f.base[h] = land; });
    assert.ok(checkBaseGeography(f.base, f.cols, f.rows).some(i => i.hex === f.hex));
  }
  assert.equal(checkBaseGeography(['Strait', 'Land', 'Land', 'Sea'], 2, 2)[0]?.kind, 'passage-neighbours');
  assert.equal(checkBaseGeography(['Mainland and islands', 'Land', 'Sea', 'Sea'], 2, 2).length, 0);
  assert.equal(checkBaseGeography(['Mainland and islands', 'Land', 'Land', 'Land'], 2, 2)[0]?.kind, 'mainland-neighbours');
  assert.equal(checkBaseGeography(['Land', 'Glacier', 'Islands'], 3, 1).length, 0);
});

test('generation reports invalid geography without changing it; load, edits, undo and redo refresh the notes', () => {
  const f = ring('Mainland and islands');
  const map = createMapState('Geography validation', f.cols, f.rows);
  const result = decodeLayer('base', { rows: encodeBase(f.base, f.cols, f.rows) }, contextFromMap(map, null));
  assert.deepEqual(result.data, f.base);
  assert.ok(result.warnings.some(w => w.startsWith(GEOGRAPHY_WARNING_PREFIX) && w.includes('3,2')));
  map.layers.base.data = f.base;
  map.layers.base.warnings = ['Keep this unrelated note.'];
  const loaded = reducer(map, { type: 'load', map });
  assert.equal(loaded.layers.base.warnings.length, 2);
  const generated = reducer(loaded, { type: 'applyGeneration', layer: 'base', ...result });
  assert.equal(generated.layers.base.warnings.filter(w => w.startsWith(GEOGRAPHY_WARNING_PREFIX)).length, 1);
  const fixed = reducer(loaded, { type: 'setHexValues', layer: 'base', indices: [f.neighbours[0]!], value: 'Land' });
  assert.deepEqual(fixed.layers.base.warnings, ['Keep this unrelated note.']);
  const undo = reducer(fixed, { type: 'undo', layer: 'base' });
  assert.equal(undo.layers.base.warnings.length, 2);
  const redo = reducer(undo, { type: 'redo', layer: 'base' });
  assert.deepEqual(redo.layers.base.warnings, ['Keep this unrelated note.']);
  assert.deepEqual(reducer(loaded, { type: 'load', map: loaded }).layers.base.warnings, loaded.layers.base.warnings);
});

function drawing(type: BaseGeo, leftLand = false) {
  const cols = 3, rows = 3, hex = 4, size = 20;
  const base: BaseGeo[] = Array(9).fill('Sea'); base[hex] = type; base[5] = 'Land';
  if (leftLand) base[3] = 'Land';
  const c = hexCenter(1, 1, size);
  const belongs = (p: Point) => { const h = pixelToOffset(p.x, p.y, size); return h.row * cols + h.col; };
  const audit = (shape: (p: Point) => boolean, islands?: (p: Point) => boolean) => auditGeography(base, cols, rows, size,
    p => belongs(p) === 5 || (leftLand && belongs(p) === 3) || (belongs(p) === hex && shape(p)), islands)
    .filter(issue => issue.hex === hex);
  const root = (p: Point) => p.x > c.x + size * .1 && Math.abs(p.y - c.y) < size * .3;
  const island = (p: Point) => Math.hypot(p.x - (c.x - size * .5), p.y - (c.y - size * .35)) < size * .13;
  return { c, size, audit, root, island };
}

test('water land must attach across a hex boundary; an island must not', () => {
  for (const type of ['Sea', 'Lake', 'Sea Ice'] as const) {
    const f = drawing(type);
    assert.deepEqual(f.audit(f.root), [], type);
    assert.equal(f.audit(f.island)[0]?.kind, 'detached-water-land', type);
  }
  const f = drawing('Islands');
  assert.deepEqual(f.audit(f.island), []);
  assert.equal(f.audit(f.root)[0]?.kind, 'island-connection');
});

test('mainland must attach, and its offshore islands must be separate components', () => {
  const f = drawing('Mainland and islands');
  assert.deepEqual(f.audit(p => f.root(p) || f.island(p)), []);
  assert.ok(f.audit(f.island).some(i => i.kind === 'mainland-connection'));
  assert.ok(f.audit(f.root).some(i => i.kind === 'missing-islands'));
  const joined = f.audit(p => f.root(p) || f.island(p) || (p.x > f.c.x - f.size * .5 && Math.abs(p.y - (f.c.y - f.size * .25)) < f.size * .08));
  assert.ok(joined.some(i => i.kind === 'missing-islands'));
});

test('a water gap narrower than the sample spacing is not mistaken for a mainland connection', () => {
  const f = drawing('Mainland and islands');
  const separated = f.audit(p => f.root(p) && p.x < f.c.x + f.size * .83);
  assert.ok(separated.some(i => i.kind === 'mainland-connection'));
});

test('an island joined to mainland is caught even when another island remains detached', () => {
  const f = drawing('Mainland and islands');
  const other = (p: Point) => Math.hypot(p.x - (f.c.x - f.size * .45), p.y - (f.c.y + f.size * .4)) < f.size * .1;
  const islands = (p: Point) => f.island(p) || other(p);
  const issues = f.audit(p => f.root(p) || islands(p)
    || (p.x > f.c.x - f.size * .5 && Math.abs(p.y - (f.c.y - f.size * .25)) < f.size * .08), islands);
  assert.ok(issues.some(i => i.kind === 'island-connection'));
  assert.equal(issues.some(i => i.kind === 'missing-islands'), false);
});

test('the drawn isthmus neck must join both land banks; a strait keeps separate banks', () => {
  for (const type of ['Isthmus', 'Strait'] as const) {
    const f = drawing(type, true);
    const strip = (p: Point) => Math.abs(p.y - f.c.y) < f.size * .2;
    const split = (p: Point) => strip(p) && Math.abs(p.x - f.c.x) > f.size * .35;
    assert.deepEqual(f.audit(type === 'Isthmus' ? strip : split), []);
    if (type === 'Isthmus') assert.ok(f.audit(split).some(i => i.kind === 'passage-connection'));
  }
});

test('a real mainland-and-islands drawing has attached mainland and separately recognised dry islands', () => {
  const map = landscapeGallery()[0]!.map;
  assert.deepEqual(checkBaseGeography(map.layers.base.data!, map.cols, map.rows), []);
  const size = 20;
  const scene = buildStaticScene(map, { size, visible: singleLayerVisibility('base'), labels: false,
    style: resolveStyle({ preset: 'parchment', overrides: { coast: 'smooth' } }) });
  const copy = withLandOf({ ...scene }, scene);
  assert.equal(islandTestOf(copy), islandTestOf(scene), 'export/layout copies retain island identity');
  const issues = auditGeography(map.layers.base.data!, map.cols, map.rows, size, landTestOf(copy)!, islandTestOf(copy));
  assert.deepEqual(issues, []);
});
