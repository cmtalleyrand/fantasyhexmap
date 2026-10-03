import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeLayer, extractJsonObject } from '../core/decode.js';
import { mockLayer } from '../core/mock.js';
import type { PromptContext } from '../core/prompts.js';
import {
  buildMultiWebchatPrompt,
  buildWebchatPrompt,
  importMultiWebchatResponse,
  importWebchatResponse,
  multiLayerProblem,
  WebchatImportError,
} from '../core/webchat.js';
import type { BaseGeo } from '../shared/types.js';

function emptyContext(cols: number, rows: number): PromptContext {
  return {
    description: 'An island realm 600 km across.',
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
}

function withBase(cols: number, rows: number): PromptContext {
  const empty = emptyContext(cols, rows);
  return { ...empty, base: decodeLayer('base', mockLayer('base', empty), empty).data as BaseGeo[] };
}

const fence = (obj: unknown) => ['```json', JSON.stringify(obj), '```'].join('\n');

/* ------------------------------------------------------------ compact style */

test('the compact prompt asks for data-only JSON and puts the decisions in the chat', () => {
  const ctx = withBase(10, 8);
  const compact = buildWebchatPrompt({ layer: 'elevation', pass: 'full', ctx, style: 'compact' });
  const full = buildWebchatPrompt({ layer: 'elevation', pass: 'full', ctx });

  assert.match(compact, /no notes, no decisions/);
  assert.match(compact, /EXPLAIN YOUR DECISIONS IN THE CHAT/);
  assert.match(compact, /write in the chat, before the JSON,/);
  assert.match(compact, /- "rows": Exactly 8 strings/);
  assert.doesNotMatch(compact, /JSON SCHEMA/);
  assert.doesNotMatch(compact, /RECORD YOUR DECISIONS/);
  assert.doesNotMatch(compact, /"decisions"/);
  assert.ok(compact.length < full.length * 0.8, `compact ${compact.length} vs full ${full.length}`);
});

test('a compact reply imports, and its chat prose becomes the layer notes', () => {
  const ctx = withBase(4, 3);
  const rows = ctx.base!.reduce<string[]>((acc, v, i) => {
    const r = Math.floor(i / 4);
    acc[r] = (acc[r] ?? '') + (v === 'Sea' || v === 'Lake' || v === 'Sea Ice' ? '.' : 'l');
    return acc;
  }, []);
  const reply = [
    'Scale: ~50 km per hex, from the 600 km width. Target: lowland coast all round.',
    '',
    fence({ rows }),
    '',
    'Decisions: I kept the whole island low {it is small} because the brief names no ranges.',
  ].join('\n');

  const result = importWebchatResponse({ layer: 'elevation', pass: 'full', ctx, text: reply });
  assert.match(result.notes ?? '', /Scale: ~50 km per hex/);
  assert.match(result.notes ?? '', /I kept the whole island low/);
  assert.doesNotMatch(result.notes ?? '', /"rows"/);
  assert.deepEqual(result.decisions, []);
});

test('a fenced JSON block wins over braces in the prose before it', () => {
  const text = 'Plan: the realm {about 40 hexes} sits west.\n\n```json\n{"rows":["ab"]}\n```\n';
  assert.equal(extractJsonObject(text), '{"rows":["ab"]}');
});

/* ------------------------------------------------------- several layers */

test('a multi-layer prompt states the shared rules once and every layer in pipeline order', () => {
  const ctx = emptyContext(10, 8);
  const prompt = buildMultiWebchatPrompt({ layers: ['polities', 'base', 'elevation'], ctx });

  const count = (re: RegExp) => (prompt.match(re) ?? []).length;
  assert.equal(count(/^THE GRID$/gm), 1);
  assert.equal(count(/^THE BRIEF COMES FIRST$/gm), 1);
  assert.equal(count(/^RECORD YOUR DECISIONS$/gm), 1);
  const order = ['LAYER 1 OF 3: BASE GEOGRAPHY', 'LAYER 2 OF 3: ELEVATION', 'LAYER 3 OF 3: POLITIES'].map((h) =>
    prompt.indexOf(h),
  );
  assert.ok(order.every((i) => i > 0) && order[0]! < order[1]! && order[1]! < order[2]!, String(order));
  assert.match(prompt, /one key per layer: "base", "elevation", "polities"/);
});

test('a layer needs its dependency on the map or in the selection', () => {
  const empty = emptyContext(6, 4);
  assert.match(multiLayerProblem(['elevation'], empty) ?? '', /needs Base Geography/);
  assert.equal(multiLayerProblem(['base', 'elevation'], empty), null);
  assert.equal(multiLayerProblem(['elevation'], withBase(6, 4)), null);
  assert.match(multiLayerProblem([], empty) ?? '', /at least one/);
});

test('a multi-layer reply is decoded in order, each layer against the ones before it', () => {
  const ctx = emptyContext(4, 2);
  const reply = fence({
    base: { rows: ['tttm', 'mmmm'], notes: 'n', decisions: [] },
    // Elevation on a sea hex (c3 of r0) must be cleared against the NEW base.
    elevation: { rows: ['lhMl', '....'], notes: 'n', decisions: [] },
  });

  const results = importMultiWebchatResponse({ layers: ['elevation', 'base'], ctx, text: reply });
  assert.deepEqual(results.map((r) => r.layer), ['base', 'elevation']);
  const elevation = results[1]!.result.data as (string | null)[];
  assert.deepEqual(elevation.slice(0, 4), ['Lowland', 'Hills', 'Mountains', null]);
});

test('a multi-layer reply missing a layer imports nothing and says which', () => {
  const ctx = emptyContext(4, 2);
  const reply = fence({ base: { rows: ['tttm', 'mmmm'], notes: 'n', decisions: [] } });
  assert.throws(
    () => importMultiWebchatResponse({ layers: ['base', 'elevation'], ctx, text: reply }),
    (e: unknown) => e instanceof WebchatImportError && /no "elevation" layer/.test(e.message),
  );
});

test('a compact multi-layer reply shares its chat prose as notes', () => {
  const ctx = emptyContext(4, 2);
  const reply = `Base: one island.\n\n${fence({ base: { rows: ['tttm', 'mmmm'] }, elevation: { rows: ['llll', '....'] } })}\n\nElevation: all low.`;
  const results = importMultiWebchatResponse({ layers: ['base', 'elevation'], ctx, text: reply });
  for (const { result } of results) assert.match(result.notes ?? '', /Base: one island[\s\S]*Elevation: all low/);
});

/* ------------------------------------------------- several layers: editing */

function withBaseAndElevation(cols: number, rows: number): PromptContext {
  const ctx = withBase(cols, rows);
  return { ...ctx, elevation: decodeLayer('elevation', mockLayer('elevation', ctx), ctx).data as PromptContext['elevation'] };
}

test('an instruction turns a several-layer prompt into an edit of the layers as they stand', () => {
  const ctx = { ...withBaseAndElevation(10, 8), instruction: '  Raise a mountain range in the east.  ' };
  const prompt = buildMultiWebchatPrompt({ layers: ['elevation', 'base'], ctx });

  assert.match(prompt, /You are editing 2 layers/);
  assert.match(prompt, /THE MAP AS IT STANDS/);
  assert.match(prompt, /<instruction>\nRaise a mountain range in the east\.\n<\/instruction>/);
  assert.match(prompt, /Base Geography, Elevation \/ Ruggedness, in that order/);
  // Both layers are shown as they stand rather than withheld for regeneration.
  assert.match(prompt, /CURRENT BASE|BASE GEOGRAPHY/i);
  assert.match(prompt, /ELEVATION/);

  const fresh = buildMultiWebchatPrompt({ layers: ['elevation', 'base'], ctx: { ...ctx, instruction: null } });
  assert.match(fresh, /You are generating 2 layers/);
  assert.doesNotMatch(fresh, /EDIT INSTRUCTION/);
});

test('editing several layers needs each to have data', () => {
  const ctx = { ...withBase(10, 8), instruction: 'Raise a mountain range.' };
  const problem = multiLayerProblem(['base', 'elevation'], ctx);
  assert.match(problem ?? '', /Elevation \/ Ruggedness has no data to edit/);
  assert.equal(multiLayerProblem(['base'], ctx), null);
  assert.equal(multiLayerProblem(['base', 'elevation'], { ...ctx, instruction: null }), null);
});
