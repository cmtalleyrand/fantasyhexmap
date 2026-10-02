import assert from 'node:assert/strict';
import test from 'node:test';

import Anthropic from '@anthropic-ai/sdk';
import * as z from 'zod/v4';

import { decodeLayer } from '../core/decode.js';
import { colKey, keyedToRows, rowKey } from '../core/grid.js';
import { flattenGrid, generateLayer, parseResponse, withBriefRecorded } from '../core/pipeline.js';
import { buildPrompt, type PromptContext } from '../core/prompts.js';
import { ElevationResponse, PolitiesPaintResponse } from '../core/schemas.js';

/**
 * Two bugs these guard against.
 *
 * Every layer after the base one failed with "The model returned malformed data
 * twice": the SDK's own parser ran the strict schema - including row lengths
 * the API never enforces - inside `finalMessage()`, so a miscounted row, a
 * truncated response and an answer split across text blocks all surfaced as
 * the same parse error.
 *
 * And rows kept coming back a cell or two short, because a model cannot count
 * characters in a string it sees as multi-character tokens. Grids now come back
 * keyed cell by cell, a shape the API's grammar does enforce.
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

/** The keyed form of a grid given as row strings, as the model now returns it. */
function keyed(rows: string[], split: (row: string) => string[] = (r) => Array.from(r)) {
  return Object.fromEntries(
    rows.map((row, r) => [rowKey(r), Object.fromEntries(split(row).map((cell, c) => [colKey(c), cell]))]),
  );
}

const ROW_STRINGS = ['wwwww', 'wrrhw', 'whHMw', 'wwwww'];

const brief = {
  scale: '~50 km per hex, from the 250 km width of the island',
  requirements: [{ requirement: 'a single central peak', target: 'Mountains at c3 of r2' }],
};

const goodElevation = { brief, rows: keyed(ROW_STRINGS), notes: 'A low island with a central peak.', decisions: [] };

interface FakeMessage {
  stop_reason: string;
  content: { type: string; text?: string }[];
}

function message(texts: string[], stop_reason = 'end_turn'): FakeMessage {
  return { stop_reason, content: texts.map((text) => ({ type: 'text', text })) };
}

/** A client that plays back canned messages (or throws canned errors) and records what it was asked. */
function fakeClient(replies: (FakeMessage | Error)[]) {
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
            finalMessage: async () => {
              if (reply instanceof Error) throw reply;
              return {
                ...reply,
                stop_details: null,
                usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 0 },
              };
            },
          };
        },
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

const run = (client: Anthropic, onProgress: (e: { phase: string; detail?: string }) => void = () => undefined) =>
  generateLayer({ client, model: 'test-model', effort: 'medium' }, { layer: 'elevation', ctx: context() }, onProgress);

/* --------------------------------------------------------------- keyed grid */

test('the API is given a grid whose every row and cell is required, so its size is enforced', async () => {
  const { client, calls } = fakeClient([message([JSON.stringify(goodElevation)])]);
  await run(client);

  const format = (calls[0]!.output_config as { format: { type: string; schema: any } }).format;
  assert.equal(format.type, 'json_schema');
  assert.equal('parse' in format, false, 'the SDK parser that rejected miscounts must not be attached');

  const schema = format.schema;
  const rowsSchema = schema.properties.rows;
  assert.deepEqual(rowsSchema.required, ['r0', 'r1', 'r2', 'r3']);
  const rowDef = schema.$defs[rowsSchema.properties.r0.$ref.split('/').pop()];
  assert.deepEqual(rowDef.required, ['c0', 'c1', 'c2', 'c3', 'c4']);
  // The row definition is shared, so the schema does not grow with the number of rows.
  assert.equal(new Set(Object.values(rowsSchema.properties).map((p: any) => p.$ref)).size, 1);
});

test('the brief checklist comes before the grid, so the plan is written before the map', async () => {
  const { client, calls } = fakeClient([message([JSON.stringify(goodElevation)])]);
  await run(client);
  const schema = (calls[0]!.output_config as { format: { schema: any } }).format.schema;
  assert.deepEqual(Object.keys(schema.properties).slice(0, 2), ['brief', 'rows']);
  assert.ok(schema.required.includes('brief'));
});

test('a keyed grid is decoded exactly, with no size warnings', async () => {
  const { client, calls } = fakeClient([message([JSON.stringify(goodElevation)])]);
  const result = await run(client);
  assert.equal(calls.length, 1);
  assert.ok(!result.warnings.some((w) => /cells|rows/i.test(w)), result.warnings.join('\n'));
  assert.equal((result.data as unknown[])[2 * COLS + 3], 'Mountains');
});

test('the brief checklist is recorded in the decisions the user sees', async () => {
  const { client } = fakeClient([message([JSON.stringify(goodElevation)])]);
  const result = await run(client);
  assert.equal(result.decisions[0]?.title, 'Scale');
  assert.match(result.decisions[0]!.detail, /50 km/);
  assert.equal(result.decisions[1]?.title, 'Brief: a single central peak');
});

test('the prompt asks for keyed output and shows context grids with column anchors', async () => {
  const { client, calls } = fakeClient([message([JSON.stringify(goodElevation)])]);
  await run(client);
  const system = (calls[0]!.system as { text: string }[])[0]!.text;
  const user = (calls[0]!.messages as { content: string }[])[0]!.content;
  assert.match(system, /"r0" \(northern edge\)/);
  assert.match(user, /r0: \[0\] ttttt/);
  assert.match(user, /Land-type hexes \(Land \+ Coastal Land \+ islands\): 20 of 20/);
});

test('if the API refuses the keyed schema, the layer is still generated as row strings', async () => {
  const rejection = new Anthropic.BadRequestError(
    400,
    { error: { message: 'output_config.format.schema: too complex to compile' } },
    'output_config.format.schema: too complex to compile',
    new Headers(),
  );
  const rowsReply = { ...goodElevation, rows: ROW_STRINGS };
  const { client, calls } = fakeClient([rejection, message([JSON.stringify(rowsReply)])]);

  const result = await run(client);
  assert.equal(calls.length, 2);
  const secondRows = (calls[1]!.output_config as { format: { schema: any } }).format.schema.properties.rows;
  assert.equal(secondRows.type, 'array');
  assert.ok(result.warnings.some((w) => /row strings/.test(w)));
});

test('an unrelated 400 is not mistaken for a schema rejection', async () => {
  const other = new Anthropic.BadRequestError(400, { error: { message: 'model: not found' } }, 'model: not found', new Headers());
  const { client, calls } = fakeClient([other]);
  await assert.rejects(run(client), /model: not found/);
  assert.equal(calls.length, 1);
});

/* ------------------------------------------------------- response handling */

test('an answer split across two text blocks is joined before parsing', async () => {
  const json = JSON.stringify(goodElevation);
  const { client } = fakeClient([message([json.slice(0, 30), json.slice(30)])]);
  const result = await run(client);
  assert.equal(result.layer, 'elevation');
});

test('a truncated response goes to the truncation recovery, not the malformed retry', async () => {
  const cut = JSON.stringify(goodElevation).slice(0, 25);
  const { client, calls } = fakeClient([message([cut], 'max_tokens'), message([JSON.stringify(goodElevation)])]);
  const phases: string[] = [];
  await run(client, (event) => phases.push(event.detail ?? event.phase));

  assert.equal(calls.length, 2);
  const effortOf = (i: number) => (calls[i]!.output_config as { effort: string }).effort;
  assert.equal(effortOf(0), 'medium');
  assert.equal(effortOf(1), 'low', 'the retry after truncation steps effort down');
  assert.ok(!phases.some((p) => /unusable JSON/.test(p)));
});

test('a wrong type is retried once and then reported by field', async () => {
  const bad = { ...goodElevation, rows: 'lllll' };
  const { client, calls } = fakeClient([message([JSON.stringify(bad)]), message([JSON.stringify(bad)])]);
  await assert.rejects(run(client), /malformed data twice.*rows:/is);
  assert.equal(calls.length, 2);
});

test('a response that is not JSON at all is still treated as malformed', () => {
  assert.throws(() => parseResponse(ElevationResponse(COLS, ROWS), '{"rows": ["lllll",'), /not valid JSON/);
});

/* ---------------------------------------------------- the row-string form */

test('in row-string form a short row is accepted and left to the decoder to repair', () => {
  const reply = { rows: ['lllll', 'lrrh', 'lhHMl', 'lllll'], notes: 'n', decisions: [] };
  const result = parseResponse(ElevationResponse(COLS, ROWS), JSON.stringify(reply));
  assert.deepEqual(result.parsed.rows, reply.rows);
});

test('in row-string form the brief checklist is optional, so a pasted reply without it imports', () => {
  const reply = { rows: ROW_STRINGS, notes: 'n', decisions: [] };
  assert.doesNotThrow(() => parseResponse(ElevationResponse(COLS, ROWS), JSON.stringify(reply)));
});

test('too many decisions is a warning, not a failure', () => {
  const decisions = Array.from({ length: 10 }, (_, i) => ({ title: `D${i}`, detail: 'x', hexes: [] }));
  const result = parseResponse(
    ElevationResponse(COLS, ROWS),
    JSON.stringify({ rows: ROW_STRINGS, notes: 'n', decisions }),
  );
  assert.equal(result.parsed.decisions.length, 10);
  assert.ok(result.warnings.some((w) => /decisions/.test(w)));
});

/* ---------------------------------------------------------------- helpers */

test('keyed token grids flatten to space-separated rows', () => {
  const grid = keyed(['Cfb Cfb --', 'Dfb -- --'], (r) => r.split(' '));
  assert.deepEqual(keyedToRows(grid, 3, 2, 'token'), ['Cfb Cfb --', 'Dfb -- --']);
});

test('a missing cell is written in place rather than shifting the row', () => {
  const grid = { r0: { c0: 'L', c2: 'L' } };
  assert.deepEqual(keyedToRows(grid, 3, 1, 'char'), ['L?L']);
});

test('flattenGrid leaves row-string responses and grid-less layers alone', () => {
  const rows = { rows: ['ab'] };
  assert.equal(flattenGrid('elevation', rows, 2, 1), rows);
  const rivers = { rivers: [] };
  assert.equal(flattenGrid('rivers', rivers, 2, 1), rivers);
});

test('withBriefRecorded is a no-op without a brief', () => {
  const r = { decisions: [{ title: 't', detail: 'd' }] };
  assert.equal(withBriefRecorded(r), r);
});

test('a polity paint pass restricts cells to the roster keys', () => {
  const schema = PolitiesPaintResponse(2, 1, { grid: 'keyed', polityKeys: ['A', 'B'] });
  const json = z.toJSONSchema(schema) as any;
  const text = JSON.stringify(json);
  assert.match(text, /"enum":\["A","B","\."\]/);
});

/* ------------------------------------------------------- polity sizes */

test('a polity drawn well off its planned size is reported', () => {
  const ctx = { ...context(), cols: 4, rows: 2, base: new Array(8).fill('Land') };
  const decoded = decodeLayer(
    'polities',
    {
      polities: [
        { key: 'A', name: 'Great Realm', colour: '#aa3333', hexes: 6 },
        { key: 'B', name: 'Small March', colour: '#3333aa', hexes: 2 },
      ],
      rows: ['AABB', '....'],
      notes: '',
      decisions: [],
    },
    ctx,
  );
  assert.ok(decoded.warnings.some((w) => /Great Realm holds 2 hexes but was planned at 6/.test(w)), decoded.warnings.join('\n'));
  assert.ok(!decoded.warnings.some((w) => /Small March/.test(w)));
});

test('the paint pass is told the size each polity was planned at', () => {
  const { user } = buildPrompt('polities', context(), 'paint', {
    kind: 'polities',
    entries: [{ key: 'A', name: 'Great Realm', colour: '#aa3333', hexes: 48 }],
  });
  assert.match(user, /A = Great Realm \(#aa3333\) - draw to about 48 hexes/);
});
