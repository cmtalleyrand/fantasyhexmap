import assert from 'node:assert/strict';
import test from 'node:test';

import { createMapState, LAYER_META } from '../shared/layers.js';
import { LAYER_ORDER, type LayerId, type MapState } from '../shared/types.js';
import { reducer } from '../src/state/store.js';
import { contextFromMap } from '../core/context.js';
import { rosterFromContext } from '../core/passes.js';
import { decodeLayer, extractJsonObject } from '../core/decode.js';
import { mockLayer } from '../core/mock.js';
import {
  buildWebchatPrompt,
  describePromptContext,
  importWebchatResponse,
  isPresent,
  WebchatImportError,
} from '../core/webchat.js';
import type { PromptContext } from '../core/prompts.js';
import type { PolitiesData } from '../shared/types.js';

/* ------------------------------------------------------- the loose parser */

test('a JSON object is found inside surrounding prose', () => {
  const text = 'Sure! Here is the layer.\n\n{"rows":["ab"],"notes":"x"}\n\nLet me know!';
  assert.equal(extractJsonObject(text), '{"rows":["ab"],"notes":"x"}');
});

test('a fenced JSON block is found', () => {
  const text = 'Here you go:\n\n```json\n{"a":1}\n```\n\nAnything else?';
  assert.equal(extractJsonObject(text), '{"a":1}');
});

test('nested objects are balanced, not truncated at the first brace', () => {
  const text = 'x {"a":{"b":{"c":1}},"d":2} y';
  assert.equal(extractJsonObject(text), '{"a":{"b":{"c":1}},"d":2}');
});

test('a brace inside a string does not end the scan', () => {
  const text = '{"name":"The } Kingdom","n":1}';
  assert.equal(extractJsonObject(text), text);
});

test('an escaped quote inside a string does not end the string', () => {
  const text = '{"name":"a \\" } b","n":1}';
  assert.equal(extractJsonObject(text), text);
});

test('text with no object at all yields null', () => {
  assert.equal(extractJsonObject('I cannot help with that.'), null);
});

test('an unterminated object yields null rather than a partial one', () => {
  assert.equal(extractJsonObject('{"rows":["ab"'), null);
});

/* ------------------------------------------------------------ round trip */

function contextWithBase(cols: number, rows: number): PromptContext {
  const empty: PromptContext = {
    description: 'A cold northern archipelago.',
    cols,
    rows,
    base: null,
    elevation: null,
    climate: null,
    vegetation: null,
    rivers: null,
    cities: null,
    polities: null,
    population: null,
    instruction: null,
    excluded: [],
  };
  const base = decodeLayer('base', mockLayer('base', empty), empty).data as PromptContext['base'];
  return { ...empty, base };
}

test('a polity layer wrapped in prose and fences imports cleanly', () => {
  const ctx = contextWithBase(12, 12);
  const reply = [
    "Here's the polity layer for your map.",
    '',
    '```json',
    JSON.stringify(mockLayer('polities', ctx)),
    '```',
    '',
    'Let me know if you want any borders adjusted!',
  ].join('\n');

  const result = importWebchatResponse({ layer: 'polities', pass: 'full', ctx, text: reply });
  const data = result.data as PolitiesData;
  assert.ok(data.polities.length > 0, 'expected at least one polity');
  assert.equal(data.owner.length, 12 * 12);
  assert.ok(data.owner.some((o) => o !== null), 'expected some hexes to be claimed');
});

test('a row of the wrong length is reported by name, not just rejected', () => {
  const ctx = contextWithBase(12, 12);
  const bad = mockLayer('polities', ctx) as { rows: string[] };
  bad.rows[7] = bad.rows[7]!.slice(0, 11);

  assert.throws(
    () => importWebchatResponse({ layer: 'polities', pass: 'full', ctx, text: JSON.stringify(bad) }),
    (error: unknown) => {
      assert.ok(error instanceof WebchatImportError);
      assert.match(error.message, /rows\.7/);
      return true;
    },
  );
});

test('a reply with no JSON in it says so', () => {
  const ctx = contextWithBase(8, 8);
  assert.throws(
    () => importWebchatResponse({ layer: 'polities', pass: 'full', ctx, text: 'I would rather not.' }),
    (error: unknown) => {
      assert.ok(error instanceof WebchatImportError);
      assert.match(error.message, /No JSON object/);
      return true;
    },
  );
});

test('painting cannot be imported without the roster it was drawn for', () => {
  const ctx = contextWithBase(8, 8);
  const rows = Array.from({ length: 8 }, () => 'A'.repeat(8));
  assert.throws(
    () =>
      importWebchatResponse({
        layer: 'polities',
        pass: 'paint',
        ctx,
        text: JSON.stringify({ rows, notes: 'x', decisions: [] }),
      }),
    (error: unknown) => {
      assert.ok(error instanceof WebchatImportError);
      assert.match(error.message, /needs the roster/);
      return true;
    },
  );
});

test('painting against a supplied roster resolves keys to those polities', () => {
  const ctx = contextWithBase(8, 8);
  const roster = {
    kind: 'polities' as const,
    entries: [
      { key: 'A', name: 'Ardh', colour: '#b5533c' },
      { key: 'B', name: 'Brenn', colour: '#3f7a8c' },
    ],
  };
  // Half the map to each, so both keys are exercised.
  const rows = Array.from({ length: 8 }, () => 'A'.repeat(4) + 'B'.repeat(4));

  const result = importWebchatResponse({
    layer: 'polities',
    pass: 'paint',
    ctx,
    roster,
    text: JSON.stringify({ rows, notes: 'Split down the middle.', decisions: [] }),
  });

  const data = result.data as PolitiesData;
  assert.deepEqual(
    data.polities.map((p) => p.name),
    ['Ardh', 'Brenn'],
  );
  // Only land hexes are claimed, so assert against the base rather than 8x8.
  const claimed = data.owner.filter((o) => o !== null);
  assert.ok(claimed.length > 0, 'expected claimed hexes');
});

/* ---------------------------------------------------------- the prompt */

test('the compiled prompt carries the schema, an example and the grid size', () => {
  const ctx = contextWithBase(30, 30);
  const prompt = buildWebchatPrompt({ layer: 'polities', pass: 'full', ctx });

  assert.match(prompt, /JSON SCHEMA/);
  assert.match(prompt, /WORKED EXAMPLE/);
  assert.match(prompt, /"maxLength": 30/, 'schema should pin the row width to the grid');
  assert.match(prompt, /exactly 30 entries/);
  // Small enough to paste into a chat window.
  assert.ok(prompt.length < 40_000, `prompt was ${prompt.length} characters`);
});

test('the roster pass asks for no grid at all', () => {
  const ctx = contextWithBase(30, 30);
  const prompt = buildWebchatPrompt({ layer: 'polities', pass: 'roster', ctx });
  assert.match(prompt, /must not return a grid/);
});

test('the paint pass names the polities it must use', () => {
  const ctx = contextWithBase(20, 20);
  const prompt = buildWebchatPrompt({
    layer: 'polities',
    pass: 'paint',
    ctx,
    roster: {
      kind: 'polities',
      entries: [{ key: 'A', name: 'Ardhic League', colour: '#b5533c' }],
    },
  });
  assert.match(prompt, /A = Ardhic League/);
  assert.match(prompt, /Do not invent, rename, merge or drop a polity/);
});

test('every layer and pass can compile a prompt', () => {
  const ctx = contextWithBase(10, 10);
  const layers = [
    'base',
    'elevation',
    'climate',
    'vegetation',
    'rivers',
    'cities',
    'polities',
    'population',
  ] as const;
  for (const layer of layers) {
    assert.ok(buildWebchatPrompt({ layer, pass: 'full', ctx }).length > 0, layer);
  }
  for (const layer of ['polities', 'rivers'] as const) {
    assert.ok(buildWebchatPrompt({ layer, pass: 'roster', ctx }).length > 0, `${layer}/roster`);
  }
});

/* --------------------------------------------------- what the prompt carries */

/**
 * These exist because the prompt was reported as missing the existing layers and
 * in fact contained them: on a 30x30 map the base geography starts around
 * character 3,000 of 7,800, behind the rules, so nothing about reading the top
 * of it tells you the map is there. Build the context the way the app does -
 * through the reducer - rather than by hand, because a hand-made context is what
 * made this look fine when it was not legible.
 */
function mapWithLayers(cols: number, rows: number, layers: LayerId[]): MapState {
  let map = createMapState('A cold northern archipelago.', cols, rows, 'Test');
  for (const id of layers) {
    const ctx = contextFromMap(map, null);
    const data = decodeLayer(id, mockLayer(id, ctx), ctx).data;
    map = reducer(map, {
      type: 'applyGeneration',
      layer: id,
      data,
      warnings: [],
      notes: null,
      decisions: [],
      model: 'test',
      instruction: null,
    });
  }
  return map;
}

test('every dependency that has data appears as a section in the prompt', () => {
  const map = mapWithLayers(20, 20, [...LAYER_ORDER]);
  const ctx = contextFromMap(map, null);
  // The heading a layer is shown under is not always its bare name.
  const heading: Record<LayerId, RegExp> = {
    base: /\nBASE GEOGRAPHY/,
    elevation: /\nELEVATION/,
    climate: /\nCLIMATE/,
    vegetation: /\nVEGETATION/,
    rivers: /\nRIVERS/,
    cities: /\nCITIES/,
    polities: /\nPOLITIES/,
    population: /\nPOPULATION/,
  };
  for (const layer of LAYER_ORDER) {
    const prompt = buildWebchatPrompt({ layer, pass: 'full', ctx });
    for (const dep of [...LAYER_META[layer].requires, ...LAYER_META[layer].uses]) {
      assert.match(prompt, heading[dep], `${layer} prompt should show ${dep}`);
    }
  }
});

test('the manifest claims a layer only when the prompt really carries it', () => {
  const map = mapWithLayers(16, 16, ['base', 'elevation']);
  const ctx = contextFromMap(map, null);
  const prompt = buildWebchatPrompt({ layer: 'polities', pass: 'roster', ctx });
  const entries = describePromptContext('polities', 'roster', ctx);

  const included = entries.filter((e) => isPresent(e.status)).map((e) => e.label);
  assert.ok(included.includes('Base Geography'), 'base was generated, so it should be claimed');
  assert.ok(included.includes('Elevation / Ruggedness'));
  assert.match(prompt, /\nBASE GEOGRAPHY/);
  assert.match(prompt, /\nELEVATION/);

  // And the ones it does not claim really are absent.
  const absent = entries.filter((e) => !isPresent(e.status)).map((e) => e.label);
  assert.ok(absent.includes('Rivers'), 'rivers were never generated');
  assert.doesNotMatch(prompt, /\nRIVERS\n/);
});

test('the base layer says outright that it has no upstream layers', () => {
  const map = mapWithLayers(16, 16, []);
  const ctx = contextFromMap(map, null);
  const entries = describePromptContext('base', 'full', ctx);
  const earlier = entries.find((e) => e.label === 'Earlier layers');
  assert.ok(earlier, 'base should carry an explicit note about having no upstream layers');
  assert.equal(isPresent(earlier.status), false);
  assert.match(earlier.detail, /first layer/);
  // The brief and grid are still carried, and the manifest rides on the prompt.
  assert.match(buildWebchatPrompt({ layer: 'base', pass: 'full', ctx }), /WHAT THIS PROMPT CONTAINS/);
});

test('the roster pass states the grid it is reasoning over', () => {
  const map = mapWithLayers(30, 30, ['base']);
  const ctx = contextFromMap(map, null);
  for (const layer of ['polities', 'rivers'] as const) {
    const prompt = buildWebchatPrompt({ layer, pass: 'roster', ctx });
    assert.match(prompt, /30 columns wide and 30 rows tall/, `${layer} roster needs the dimensions`);
    assert.match(prompt, /odd {2}r:/, `${layer} roster needs the neighbour rule`);
  }
});

test('an edit instruction ships the layer it claims is shown above', () => {
  const map = mapWithLayers(16, 16, ['base', 'rivers', 'polities']);
  const ctx = contextFromMap(map, 'make the northern realm bigger');

  const roster = buildWebchatPrompt({ layer: 'polities', pass: 'roster', ctx });
  assert.match(roster, /already exists and is shown above/);
  assert.match(roster, /\nCURRENT POLITIES\n/, 'a roster edit must show the current roster');

  const painted = buildWebchatPrompt({
    layer: 'polities',
    pass: 'paint',
    ctx,
    roster: rosterFromContext('polities', ctx),
  });
  assert.match(painted, /\nCURRENT BORDERS\n/, 'a border edit must show the current partition');

  const rivers = buildWebchatPrompt({ layer: 'rivers', pass: 'roster', ctx });
  assert.match(rivers, /\nCURRENT RIVERS\n/);
});
