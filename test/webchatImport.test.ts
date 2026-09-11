import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeLayer, extractJsonObject } from '../core/decode.js';
import { mockLayer } from '../core/mock.js';
import {
  buildWebchatPrompt,
  importWebchatResponse,
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
  assert.match(prompt, /Do not default to eight or any other fixed target/);
  assert.doesNotMatch(prompt, /Aim for around 8 polities/);
  // Small enough to paste into a chat window.
  assert.ok(prompt.length < 40_000, `prompt was ${prompt.length} characters`);
});

test('the roster pass asks for no grid at all', () => {
  const ctx = contextWithBase(30, 30);
  const prompt = buildWebchatPrompt({ layer: 'polities', pass: 'roster', ctx });
  assert.match(prompt, /must not return a grid/);
  assert.match(prompt, /Do not default to eight or any other fixed target/);
  assert.doesNotMatch(prompt, /Aim for around 8 polities/);
  assert.doesNotMatch(prompt, /every row string/);
  assert.doesNotMatch(prompt, /a 4x3 map/);
});

test('row-count reply instructions are included only when the response has rows', () => {
  const ctx = contextWithBase(30, 30);

  assert.match(buildWebchatPrompt({ layer: 'base', pass: 'full', ctx }), /every row string/);
  assert.doesNotMatch(
    buildWebchatPrompt({ layer: 'rivers', pass: 'roster', ctx }),
    /every row string/,
  );
  assert.doesNotMatch(
    buildWebchatPrompt({ layer: 'rivers', pass: 'full', ctx }),
    /every row string/,
  );
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
