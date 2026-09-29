import assert from 'node:assert/strict';
import test from 'node:test';

import type Anthropic from '@anthropic-ai/sdk';

import { generateLayer, parseResponse } from '../core/pipeline.js';
import type { PromptContext } from '../core/prompts.js';
import { ElevationResponse } from '../core/schemas.js';

/**
 * The bug these guard against: every layer after the base one failed with "The
 * model returned malformed data twice". The SDK's own structured-output parser
 * ran the strict schema - including row lengths the API never enforces - inside
 * `finalMessage()`, so a single miscounted row, a truncated response, or an
 * answer split across two text blocks all surfaced as the same parse error and
 * were retried identically until they failed twice.
 */

const COLS = 5;
const ROWS = 4;

function context(): PromptContext {
  return {
    description: 'A small island.',
    cols: COLS,
    rows: ROWS,
    base: new Array(COLS * ROWS).fill('Land'),
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
}

interface FakeMessage {
  stop_reason: string;
  content: { type: string; text?: string }[];
}

function message(texts: string[], stop_reason = 'end_turn'): FakeMessage {
  return { stop_reason, content: texts.map((text) => ({ type: 'text', text })) };
}

/** A client that plays back canned messages and records what it was asked. */
function fakeClient(replies: FakeMessage[]) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        stream(params: Record<string, unknown>) {
          calls.push(params);
          const reply = replies.shift();
          if (!reply) throw new Error('No more canned replies.');
          return {
            on() {},
            finalMessage: async () => ({
              ...reply,
              stop_details: null,
              usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 },
            }),
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const goodElevation = {
  rows: ['lllll', 'lrrhl', 'lhHMl', 'lllll'],
  notes: 'A low island with a central peak.',
  decisions: [],
};

test('a row one character short is accepted with a warning, not rejected as malformed', async () => {
  const reply = { ...goodElevation, rows: ['lllll', 'lrrh', 'lhHMl', 'lllll'] };
  const { client, calls } = fakeClient([message([JSON.stringify(reply)])]);

  const result = await generateLayer(
    { client, model: 'test-model', effort: 'medium' },
    { layer: 'elevation', ctx: context() },
    () => undefined,
  );

  assert.equal(calls.length, 1, 'a miscount must not trigger a retry');
  assert.ok(result.warnings.some((w) => /Row 1 had 4 cells/.test(w)), result.warnings.join('\n'));
});

test('a missing row is accepted with a warning', async () => {
  const reply = { ...goodElevation, rows: goodElevation.rows.slice(0, 3) };
  const { client } = fakeClient([message([JSON.stringify(reply)])]);

  const result = await generateLayer(
    { client, model: 'test-model', effort: 'medium' },
    { layer: 'elevation', ctx: context() },
    () => undefined,
  );
  assert.ok(result.warnings.some((w) => /Expected 4 rows/.test(w)), result.warnings.join('\n'));
});

test('the request carries the schema but not the SDK parser that rejected miscounts', async () => {
  const { client, calls } = fakeClient([message([JSON.stringify(goodElevation)])]);
  await generateLayer(
    { client, model: 'test-model', effort: 'medium' },
    { layer: 'elevation', ctx: context() },
    () => undefined,
  );
  const format = (calls[0]!.output_config as { format: Record<string, unknown> }).format;
  assert.equal(format.type, 'json_schema');
  assert.ok(format.schema);
  assert.equal('parse' in format, false);
});

test('an answer split across two text blocks is joined before parsing', async () => {
  const json = JSON.stringify(goodElevation);
  const { client } = fakeClient([message([json.slice(0, 30), json.slice(30)])]);

  const result = await generateLayer(
    { client, model: 'test-model', effort: 'medium' },
    { layer: 'elevation', ctx: context() },
    () => undefined,
  );
  assert.equal(result.layer, 'elevation');
});

test('a truncated response goes to the truncation recovery, not the malformed retry', async () => {
  const cut = JSON.stringify(goodElevation).slice(0, 25);
  const { client, calls } = fakeClient([
    message([cut], 'max_tokens'),
    message([JSON.stringify(goodElevation)]),
  ]);
  const phases: string[] = [];

  await generateLayer(
    { client, model: 'test-model', effort: 'medium' },
    { layer: 'elevation', ctx: context() },
    (event) => phases.push(event.detail ?? event.phase),
  );

  assert.equal(calls.length, 2);
  const effortOf = (i: number) => (calls[i]!.output_config as { effort: string }).effort;
  assert.equal(effortOf(0), 'medium');
  assert.equal(effortOf(1), 'low', 'the retry after truncation steps effort down');
  assert.ok(!phases.some((p) => /unusable JSON/.test(p)));
});

test('a wrong type is retried once and then reported by field', async () => {
  const bad = { ...goodElevation, rows: 'lllll' };
  const { client, calls } = fakeClient([
    message([JSON.stringify(bad)]),
    message([JSON.stringify(bad)]),
  ]);

  await assert.rejects(
    generateLayer(
      { client, model: 'test-model', effort: 'medium' },
      { layer: 'elevation', ctx: context() },
      () => undefined,
    ),
    /malformed data twice.*rows:/is,
  );
  assert.equal(calls.length, 2);
});

test('a response that is not JSON at all is still treated as malformed', () => {
  assert.throws(() => parseResponse(ElevationResponse(COLS, ROWS), '{"rows": ["lllll",'), /not valid JSON/);
});

test('too many decisions is a warning, not a failure', () => {
  const decisions = Array.from({ length: 10 }, (_, i) => ({ title: `D${i}`, detail: 'x', hexes: [] }));
  const result = parseResponse(
    ElevationResponse(COLS, ROWS),
    JSON.stringify({ ...goodElevation, decisions }),
  );
  assert.equal(result.parsed.decisions.length, 10);
  assert.ok(result.warnings.some((w) => /decisions/.test(w)));
});
