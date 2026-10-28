import assert from 'node:assert/strict';
import test from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { contextFromMap } from '../core/context.ts';
import { decodeLayer } from '../core/decode.ts';
import { generateLayer } from '../core/pipeline.ts';
import { buildPrompt } from '../core/prompts.ts';
import { BaseResponse } from '../core/schemas.ts';
import { buildWebchatPrompt, buildMultiWebchatPrompt, importWebchatResponse, importMultiWebchatResponse } from '../core/webchat.ts';
import { createMapState } from '../shared/layers.ts';
import { landFraction } from '../shared/surfaceArea.ts';
import { DEFAULT_HEX_DIMENSIONS, LAYER_ORDER } from '../shared/types.ts';
import { reducer } from '../src/state/store.ts';

function fixture() {
  const map = createMapState('Two islands and a mainland shore.', 3, 2);
  map.layers.base.data = ['Islands', 'Mainland and islands', 'Sea', 'Land', 'Lake', 'Land'];
  map.islandSpecs = { '0': { large: 1, small: 2, coastal: { large: true }, side: 3, layoutSeed: 9 } };
  map.hexShapes = { '0': { type: 'Islands', land: 37, irregular: 'Ragged' }, '5': { type: 'Land', land: 70 } };
  return map;
}
const rows = ['ikm', 'tlt'];
const islands = [{ col: 0, row: 0, small: 3, arrangement: 'chain', orientation: 'along', irregular: 'Wavy' }];

test('old replies remain valid; limited island controls validate in row and keyed replies', () => {
  assert.ok(BaseResponse(3, 2).safeParse({ rows }).success);
  assert.ok(BaseResponse(3, 2).safeParse({ rows, islands }).success);
  const keyed = { r0: { c0: 'i', c1: 'k', c2: 'm' }, r1: { c0: 't', c1: 'l', c2: 't' } };
  assert.ok(BaseResponse(3, 2, { grid: 'keyed' }).safeParse({ rows: keyed, names: [], islands }).success);
  for (const bad of [{ col: 3 }, { row: -1 }, { large: 3 }, { small: 7 }, { arrangement: 'unknown' }, { orientation: 'north' }, { irregular: 'unknown' }]) {
    assert.equal(BaseResponse(3, 2).safeParse({ rows, islands: [{ ...islands[0], ...bad }] }).success, false);
  }
  const stripped = BaseResponse(3, 2).parse({ rows, islands: [{ ...islands[0], land: 99, layoutSeed: 4 }] });
  assert.equal('land' in stripped.islands![0] || 'layoutSeed' in stripped.islands![0], false);
});

test('pasted island settings preserve manual fields and apply with the terrain as one undoable change', () => {
  const map = fixture();
  const result = importWebchatResponse({ layer: 'base', pass: 'full', ctx: contextFromMap(map, null), text: JSON.stringify({ rows, islands }) });
  assert.equal(result.islandSpecs?.['0']?.small, 3);
  assert.equal(result.islandSpecs?.['0']?.large, 1);
  assert.equal(result.islandSpecs?.['0']?.layoutSeed, 9);
  assert.equal(result.islandSpecs?.['0']?.side, 3);
  const changed = reducer(map, { type: 'applyGeneration', layer: 'base', ...result, imported: true });
  assert.equal(changed.islandSpecs?.['0']?.arrangement, 'chain');
  assert.equal(changed.hexShapes?.['0']?.irregular, 'Wavy');
  assert.equal(changed.hexShapes?.['0']?.land, 37);
  assert.deepEqual(changed.hexShapes?.['5'], map.hexShapes?.['5']);
  const undone = reducer(changed, { type: 'undo', layer: 'base' });
  assert.deepEqual(undone.islandSpecs, map.islandSpecs);
  assert.deepEqual(undone.hexShapes, map.hexShapes);
  const redone = reducer(undone, { type: 'redo', layer: 'base' });
  assert.deepEqual(redone.islandSpecs, changed.islandSpecs);
  assert.deepEqual(redone.hexShapes, changed.hexShapes);
});

test('empty lists preserve settings; non-island, duplicate and empty-count edits produce warnings', () => {
  const map = fixture(); const ctx = contextFromMap(map, null);
  const unchanged = decodeLayer('base', { rows, islands: [] }, ctx);
  assert.equal(unchanged.islandSpecs, undefined);
  assert.equal(unchanged.hexShapes, undefined);
  const invalid = decodeLayer('base', { rows, islands: [
    islands[0], islands[0], { col: 2, row: 0, irregular: 'Wavy' },
    { col: 1, row: 0, large: 0, small: 0 }, { col: -1, row: 1, small: 2 },
  ] }, ctx);
  assert.equal(invalid.warnings.length, 4);
  assert.deepEqual(Object.keys(invalid.islandSpecs!), ['0']);
  assert.deepEqual(Object.keys(invalid.hexShapes!), ['0']);
});

test('changing terrain drops obsolete settings and never revives another terrain type configuration', () => {
  const map = fixture();
  const result = decodeLayer('base', { rows: ['mim', 'tlt'], islands: [{ col: 1, row: 0, arrangement: 'arc' }] }, contextFromMap(map, null));
  assert.equal(result.islandSpecs?.['1']?.large, 1);
  const changed = reducer(map, { type: 'applyGeneration', layer: 'base', ...result });
  assert.equal(changed.islandSpecs?.['0'], undefined);
  assert.equal(changed.hexShapes?.['0'], undefined);
  assert.equal(changed.islandSpecs?.['1']?.arrangement, 'arc');
});

test('combined webchat import preserves island settings alongside later layer data and actual land fractions', () => {
  const map = fixture();
  const result = importMultiWebchatResponse({ layers: ['base', 'elevation'], ctx: contextFromMap(map, null), text: JSON.stringify({
    base: { rows, islands }, elevation: { rows: ['ww.', 'w.w'] },
  }) });
  let changed = map;
  for (const { layer, result: data } of result) changed = reducer(changed, { type: 'applyGeneration', layer, ...data });
  assert.equal(changed.islandSpecs?.['0']?.small, 3);
  assert.equal(changed.layers.elevation.data?.[0], 'Lowland');
  assert.equal(landFraction('Islands', changed.islandSpecs?.['0'], DEFAULT_HEX_DIMENSIONS, changed.hexShapes?.['0']), 0.37);
});

test('API generation returns decoded island settings rather than dropping metadata in transport', async () => {
  const map = fixture();
  const keyed = { r0: { c0: 'i', c1: 'k', c2: 'm' }, r1: { c0: 't', c1: 'l', c2: 't' } };
  const client = { beta: { messages: { stream() { return {
    on() {}, finalMessage: async () => ({ stop_reason: 'end_turn', stop_details: null,
      content: [{ type: 'text', text: JSON.stringify({ rows: keyed, names: [], islands }) }],
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 },
    }),
  }; } } } } as unknown as Anthropic;
  const result = await generateLayer({ client, model: 'test-model', effort: 'medium' }, { layer: 'base', ctx: contextFromMap(map, null) }, () => {});
  assert.equal(result.islandSpecs?.['0']?.arrangement, 'chain');
  assert.equal(result.hexShapes?.['0']?.irregular, 'Wavy');
});

test('API and both external-chat prompt styles enforce fidelity, bounded contours and independent checks', () => {
  const ctx = contextFromMap(fixture(), null);
  for (const layer of LAYER_ORDER) {
    for (const style of ['full', 'compact'] as const) {
      const prompt = buildWebchatPrompt({ layer, pass: 'full', ctx, style });
      assert.match(prompt, /do not add places, names/);
      assert.match(prompt, /normally no more than 6 hexes and never more than 8/);
      assert.match(prompt, /Independently validate/);
      assert.match(prompt, /external chat without app access/);
      assert.doesNotMatch(prompt, /invent something coherent|plausible and interesting|aim for roughly half|Factory defaults|name them freely|Name the rest/);
    }
  }
  for (const layer of ['rivers', 'polities'] as const) {
    const prompt = buildPrompt(layer, ctx, 'roster');
    assert.match(prompt.system, /Include only/);
    assert.doesNotMatch(prompt.system, /aim for about|plausible political fragmentation/);
  }
  const multi = buildMultiWebchatPrompt({ layers: ['base', 'elevation', 'climate'], ctx, style: 'compact' });
  assert.match(multi, /ISLAND CONFIGURATION/);
  assert.match(multi, /arrangement \(scattered, chain, arc, barrier, ring\)/);
  assert.match(multi, /Row order alone establishes neither hemisphere nor latitude/);
  assert.match(buildPrompt('base', ctx).system, /Sea, Lake or Sea Ice/);
  assert.match(buildPrompt('climate', ctx).system, /A rain shadow can make the lee drier without making it desert/);
});
