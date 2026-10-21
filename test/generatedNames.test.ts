import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeLayer } from '../core/decode.js';
import { buildPrompt, type PromptContext } from '../core/prompts.js';
import { BaseResponse, ElevationResponse } from '../core/schemas.js';
import { createMapState } from '../shared/layers.js';
import { mergeGeneratedNames } from '../shared/geoNames.js';
import type { BaseGeo, Elevation } from '../shared/types.js';
import { reducer } from '../src/state/store.js';

const COLS = 6;
const ROWS = 4;

/** Row 0 sea, row 1 land with a lake at c4, rows 2-3 land. */
const BASE_ROWS = ['mmmmmm', 'ttttlt', 'tttttt', 'tttttt'];

function context(over: Partial<PromptContext> = {}): PromptContext {
  const base: BaseGeo[] = Array(COLS * ROWS).fill('Land');
  for (let c = 0; c < COLS; c++) base[c] = 'Sea';
  base[COLS + 4] = 'Lake';
  return {
    description: 'A test world.',
    cols: COLS,
    rows: ROWS,
    base,
    elevation: null,
    climate: null,
    vegetation: null,
    rivers: null,
    cities: null,
    polities: null,
    population: null,
    instruction: null,
    excluded: [],
    ...over,
  };
}

const baseReply = (names: unknown) => ({ rows: BASE_ROWS, names });

test('base names are decoded to flat hexes, kept to the hexes each kind may hold', () => {
  const ctx = context();
  const decoded = decodeLayer(
    'base',
    baseReply([
      { kind: 'sea', name: 'The Grey Sound', spans: [{ row: 0, from: 1, to: 3 }, { row: 1, from: 0, to: 1 }] },
      { kind: 'lake', name: 'Mere Aldan', spans: [{ row: 1, from: 4, to: 4 }] },
      { kind: 'land', name: 'The Ashen Waste', spans: [{ row: 2, from: 0, to: 5 }, { row: 9, from: 0, to: 3 }] },
      { kind: 'lake', name: 'Nowhere', spans: [{ row: 2, from: 0, to: 1 }] },
    ]),
    ctx,
  );
  const byName = new Map((decoded.geoNames ?? []).map((n) => [n.name, n]));
  assert.deepEqual(byName.get('The Grey Sound')?.hexes, [1, 2, 3], 'land hexes in the run are dropped');
  assert.deepEqual(byName.get('Mere Aldan')?.hexes, [COLS + 4]);
  assert.deepEqual(byName.get('The Ashen Waste')?.hexes, [12, 13, 14, 15, 16, 17], 'a run off the map is ignored');
  assert.equal(byName.has('Nowhere'), false);
  assert.ok(decoded.warnings.some((w) => /"Nowhere"/.test(w)));
  assert.equal('notes' in decoded || 'decisions' in decoded, false);
});

test('a response with no names decodes with none', () => {
  assert.equal(decodeLayer('base', { rows: BASE_ROWS }, context()).geoNames, undefined);
});

test('range names keep only Mountains and Highland hexes of the new elevation', () => {
  const base = context().base!;
  const ctx = context({ base });
  const rows = ['......', 'lHMMHl', 'llllll', 'llllll'];
  const decoded = decodeLayer(
    'elevation',
    { rows, ranges: [{ name: 'The Iron Teeth', spans: [{ row: 1, from: 0, to: 5 }] }] },
    ctx,
  );
  const elevation = decoded.data as (Elevation | null)[];
  assert.equal(elevation[COLS + 2], 'Mountains');
  assert.deepEqual(decoded.mountainRanges?.[0]?.hexes, [COLS + 1, COLS + 2, COLS + 3]);  // c4 is the lake, which holds no elevation
});

test('regenerating keeps the id of a name it matches, and a rename follows previousName', () => {
  const ctx = context({ geoNames: [{ id: 'old', kind: 'sea', name: 'North Sea', hexes: [0, 1] }] });
  const same = decodeLayer('base', baseReply([{ kind: 'sea', name: 'north sea', spans: [{ row: 0, from: 0, to: 4 }] }]), ctx);
  assert.equal(same.geoNames?.[0]?.id, 'old');
  const renamed = decodeLayer(
    'base',
    baseReply([{ kind: 'sea', name: 'Boreal Sea', previousName: 'North Sea', spans: [{ row: 0, from: 0, to: 4 }] }]),
    ctx,
  );
  assert.equal(renamed.geoNames?.[0]?.id, 'old');
  assert.equal(renamed.geoNames?.[0]?.name, 'Boreal Sea');
});

test('generated names merge into a map without duplicating or stealing hand-made names', () => {
  let map = createMapState('', COLS, ROWS);
  const ctx = context();
  map = reducer(map, { type: 'applyGeneration', layer: 'base', data: ctx.base!, warnings: [] });
  map = reducer(map, { type: 'nameGeo', id: 'mine', kind: 'sea', name: 'My Sea', indices: [0, 1] });
  const apply = (hexes: number[]) =>
    reducer(map, {
      type: 'applyGeneration',
      layer: 'base',
      data: ctx.base!,
      warnings: [],
      geoNames: [{ id: 'g1', kind: 'sea', name: 'The Grey Sound', hexes }],
    });
  const once = apply([1, 2, 3]);
  const names = once.geoNames!;
  assert.deepEqual(names.find((n) => n.id === 'mine')?.hexes, [0], 'a hex claimed by the new name leaves the old one');
  assert.deepEqual(names.find((n) => n.name === 'The Grey Sound')?.hexes, [1, 2, 3]);
  const twice = reducer(once, {
    type: 'applyGeneration',
    layer: 'base',
    data: ctx.base!,
    warnings: [],
    geoNames: [{ id: 'g2', kind: 'sea', name: 'The Grey Sound', hexes: [2, 3, 4] }],
  });
  assert.equal(twice.geoNames!.filter((n) => n.name === 'The Grey Sound').length, 1);
});

test('mergeGeneratedNames drops a name left with no hexes', () => {
  const merged = mergeGeneratedNames(
    [{ id: 'a', name: 'A', hexes: [1, 2] }],
    [{ id: 'b', name: 'B', hexes: [1, 2, 3] }],
  );
  assert.deepEqual(merged.map((n) => n.name), ['B']);
});

test('the keyed base and elevation schemas require the name lists; row form does not', () => {
  const keyedBase = BaseResponse(COLS, ROWS, { grid: 'keyed' });
  assert.equal(keyedBase.safeParse({ rows: {}, names: [] }).success === false, true);
  assert.ok('names' in (keyedBase as unknown as { shape: object }).shape);
  assert.ok('ranges' in (ElevationResponse(COLS, ROWS, { grid: 'keyed' }) as unknown as { shape: object }).shape);
  assert.equal(BaseResponse(COLS, ROWS).safeParse({ rows: BASE_ROWS }).success, true);
});

test('the base prompt preserves supplied names and leaves unnamed features unnamed', () => {
  const { system } = buildPrompt('base', context());
  assert.match(system, /NAMING PLACES/);
  assert.match(system, /sea|lake|island|land/);
  assert.match(system, /Leave unnamed features unnamed/);
});

test('the elevation prompt preserves supplied range names', () => {
  const { system } = buildPrompt('elevation', context());
  assert.match(system, /NAMING RANGES/);
  assert.match(system, /leave unnamed ranges unnamed/);
});

test('every prompt assumes a ring of ice or sea round the finished map and bounds straight stretches', () => {
  for (const layer of ['base', 'elevation', 'climate', 'vegetation', 'rivers', 'cities', 'polities', 'population'] as const) {
    const { system } = buildPrompt(layer, context());
    assert.match(system, /one row above and one below, and one column to the left and one to the right/, layer);
    assert.match(system, /always Sea Ice or Sea, unless the brief specifies otherwise/, layer);
    assert.match(system, /normally no more than 6 hexes and never more than 8/, layer);
  }
});

test('no prompt asks the model for comments or explanations', () => {
  for (const layer of ['base', 'elevation', 'climate', 'vegetation', 'rivers', 'cities', 'polities', 'population'] as const) {
    const { system, user } = buildPrompt(layer, context());
    assert.doesNotMatch(system + user, /EXPLANATIONS|notes = |decisions = |latitudeBand|brief\.scale|in its reason|flag only/, layer);
  }
});
