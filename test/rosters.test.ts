import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canSplit,
  parseRoster,
  passesFor,
  rosterFromPolities,
  rosterToLines,
  normaliseRoster,
  RosterParseError,
} from '../core/rosters.js';
import { combinePasses, rosterFromResponse, rosterOnlyResponse } from '../core/passes.js';
import { MAX_POLITIES } from '../core/rosters.js';
import { buildPrompt } from '../core/prompts.js';
import { decodeLayer } from '../core/decode.js';
import { mockLayer } from '../core/mock.js';
import type { PromptContext } from '../core/prompts.js';
import type { PolitiesData } from '../shared/types.js';

/* ----------------------------------------------------------------- parsing */

test('a polity roster parses from one entry per line', () => {
  const roster = parseRoster('polities', 'The Ardhic League | #b5533c\nBrennmark | #3f7a8c');
  assert.equal(roster.kind, 'polities');
  assert.deepEqual(roster.entries, [
    { key: 'A', name: 'The Ardhic League', colour: '#b5533c' },
    { key: 'B', name: 'Brennmark', colour: '#3f7a8c' },
  ]);
});

test('a colour is optional', () => {
  const roster = parseRoster('polities', 'Ardh\nBrenn');
  assert.deepEqual(
    roster.entries.map((e) => e.colour),
    ['', ''],
  );
});

test('blank lines and comments are skipped', () => {
  const roster = parseRoster('polities', '# my realms\n\nArdh\n\nBrenn\n');
  assert.equal(roster.entries.length, 2);
});

test('a river roster keeps the course clause', () => {
  const roster = parseRoster('rivers', 'Kelder | rises on the Spine, runs south into the bay');
  assert.equal(roster.kind, 'rivers');
  assert.deepEqual(roster.entries, [
    { name: 'Kelder', course: 'rises on the Spine, runs south into the bay' },
  ]);
});

test('a roster parses from the JSON a roster pass returns', () => {
  const json = JSON.stringify({
    polities: [
      { key: 'X', name: 'Ardh', colour: '#b5533c' },
      { key: 'Y', name: 'Brenn', colour: '#3f7a8c' },
    ],
  });
  const roster = parseRoster('polities', json);
  assert.deepEqual(
    roster.entries.map((e) => e.name),
    ['Ardh', 'Brenn'],
  );
});

test('a bare JSON array is accepted too', () => {
  const roster = parseRoster('polities', '[{"name":"Ardh"},{"name":"Brenn"}]');
  assert.equal(roster.entries.length, 2);
});

test('an empty roster is rejected', () => {
  assert.throws(() => parseRoster('polities', '   '), RosterParseError);
});

test('an entry with no name is rejected', () => {
  assert.throws(() => parseRoster('polities', '[{"colour":"#fff"}]'), RosterParseError);
});

test('JSON without the expected array says which key it wanted', () => {
  assert.throws(
    () => parseRoster('polities', '{"realms":[{"name":"Ardh"}]}'),
    (error: unknown) => {
      assert.ok(error instanceof RosterParseError);
      assert.match(error.message, /"polities" array/);
      return true;
    },
  );
});

/* ------------------------------------------------------------------- keys */

test('keys are reassigned by position, so duplicates cannot drop hexes', () => {
  const roster = normaliseRoster({
    kind: 'polities',
    entries: [
      { key: 'A', name: 'Ardh', colour: '' },
      { key: 'A', name: 'Brenn', colour: '' },
      { key: 'Q', name: 'Cairn', colour: '' },
    ],
  });
  assert.deepEqual(
    roster.entries.map((e) => e.key),
    ['A', 'B', 'C'],
  );
});

test('lines round-trip through the parser', () => {
  const original = parseRoster('polities', 'Ardh | #b5533c\nBrenn | #3f7a8c');
  const reparsed = parseRoster('polities', rosterToLines(original));
  assert.deepEqual(reparsed.entries, original.entries);
});

/* ------------------------------------------------------------- the passes */

test('only polities and rivers split', () => {
  assert.equal(canSplit('polities'), true);
  assert.equal(canSplit('rivers'), true);
  assert.equal(canSplit('base'), false);
  assert.equal(canSplit('climate'), false);
});

test('a layer that cannot split always runs one full pass', () => {
  assert.deepEqual(passesFor('base', 'both'), ['full']);
  assert.deepEqual(passesFor('base', 'roster'), ['full']);
  assert.deepEqual(passesFor('climate', 'paint'), ['full']);
});

test('a splittable layer runs the halves that were asked for', () => {
  assert.deepEqual(passesFor('polities', 'both'), ['roster', 'paint']);
  assert.deepEqual(passesFor('polities', 'roster'), ['roster']);
  assert.deepEqual(passesFor('polities', 'paint'), ['paint']);
});

/* ------------------------------------------------------- recombination */

function contextWithBase(cols: number, rows: number): PromptContext {
  const empty: PromptContext = {
    description: 'A test world.',
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

test('a roster and a painting recombine into the single-request shape', () => {
  const roster = rosterFromResponse('polities', {
    polities: [
      { key: 'A', name: 'Ardh', colour: '#b5533c' },
      { key: 'B', name: 'Brenn', colour: '#3f7a8c' },
    ],
    notes: 'Two powers.',
    decisions: [{ title: 'Why two', detail: 'The brief implies a rivalry.', hexes: [] }],
  });

  const combined = combinePasses(
    'polities',
    roster,
    { notes: 'Two powers.', decisions: [{ title: 'Why two', detail: 'A rivalry.', hexes: [] }] },
    {
      rows: ['AABB', 'AABB'],
      notes: 'Split east-west.',
      decisions: [{ title: 'Why there', detail: 'The ridge.', hexes: [] }],
    },
  ) as { polities: unknown[]; rows: string[]; notes: string; decisions: unknown[] };

  assert.equal(combined.polities.length, 2);
  assert.deepEqual(combined.rows, ['AABB', 'AABB']);
  // Both halves reason about different things; losing either leaves the record
  // with a hole exactly where a two-pass generation is most interesting.
  assert.equal(combined.decisions.length, 2);
  assert.match(combined.notes, /Two powers/);
  assert.match(combined.notes, /Split east-west/);
});

test('a roster pass alone renames in place, keeping the existing partition', () => {
  const ctx = contextWithBase(10, 10);
  const original = decodeLayer('polities', mockLayer('polities', ctx), ctx).data as PolitiesData;
  const withPolities: PromptContext = { ...ctx, polities: original };

  const renamed = rosterFromPolities(original).entries.map((e, i) => ({
    ...e,
    name: `Renamed ${i}`,
  }));

  const folded = rosterOnlyResponse(
    'polities',
    { kind: 'polities', entries: renamed },
    { notes: 'Renamed them all.', decisions: [] },
    withPolities,
  );
  const result = decodeLayer('polities', folded, withPolities).data as PolitiesData;

  assert.deepEqual(
    result.polities.map((p) => p.name),
    renamed.map((e) => e.name),
  );
  // The partition itself is untouched: the same hexes are owned as before.
  assert.equal(
    result.owner.filter((o) => o !== null).length,
    original.owner.filter((o) => o !== null).length,
  );
});

/* -------------------------------------------------- the brief decides how many */

/**
 * The count used to be a flat instruction in the system prompt ("Aim for around
 * 8 polities") while the brief sat in the user turn with its authority asserted
 * only in a parenthetical and one line of HOUSE_STYLE three sections away. A
 * specific number in the authoritative position beats a general principle
 * downstream, so a brief asking for three kingdoms got eight.
 */
function baseContext(cols: number, rows: number): PromptContext {
  const empty: PromptContext = {
    description: 'Three rival kingdoms contest a cold archipelago.',
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
  return { ...empty, base: decodeLayer('base', mockLayer('base', empty), empty).data };
}

test('the brief is given precedence before any number is mentioned', () => {
  for (const layer of ['polities', 'rivers'] as const) {
    for (const pass of ['full', 'roster'] as const) {
      const { system } = buildPrompt(layer, baseContext(30, 30), pass);
      const rule = system.indexOf('The brief decides.');
      const figure = system.indexOf('Only if the brief says nothing');
      assert.ok(rule >= 0, `${layer}/${pass} should state that the brief decides`);
      assert.ok(figure > rule, `${layer}/${pass} must put the brief before the fallback figure`);
      assert.match(system, /follow it exactly, however many that is/);
    }
  }
});

test('no prompt dictates a count unconditionally any more', () => {
  for (const layer of ['polities', 'rivers'] as const) {
    for (const pass of ['full', 'roster'] as const) {
      const { system } = buildPrompt(layer, baseContext(30, 30), pass);
      assert.doesNotMatch(system, /Aim for a(round|bout) \d+/, `${layer}/${pass} still dictates a count`);
    }
  }
});

test('the fallback range never exceeds the polity cap', () => {
  for (const [cols, rows] of [[10, 10], [30, 30], [40, 40], [50, 50]] as const) {
    const { system } = buildPrompt('polities', baseContext(cols, rows), 'full');
    const match = /nothing on the subject: (\d+) to (\d+)/.exec(system);
    assert.ok(match, `${cols}x${rows} should state a fallback range`);
    assert.ok(
      Number(match[2]) <= MAX_POLITIES,
      `${cols}x${rows} suggested up to ${match[2]}, above the cap of ${MAX_POLITIES}`,
    );
  }
});

test('rivers are not capped - they are named features, not a partition', () => {
  const { system } = buildPrompt('rivers', baseContext(50, 50), 'full');
  assert.doesNotMatch(system, /Never more than \d+ in total/);
});

/* ------------------------------------------------------------------ the cap */

test('a roster above the cap is refused rather than silently mangled', () => {
  const tooMany = Array.from({ length: MAX_POLITIES + 1 }, (_, i) => `Realm ${i}`).join('\n');
  assert.throws(
    () => parseRoster('polities', tooMany),
    (error: unknown) => {
      assert.ok(error instanceof RosterParseError);
      assert.match(error.message, new RegExp(String(MAX_POLITIES)));
      return true;
    },
  );
  // Exactly at the cap is fine.
  const atCap = Array.from({ length: MAX_POLITIES }, (_, i) => `Realm ${i}`).join('\n');
  assert.equal(parseRoster('polities', atCap).entries.length, MAX_POLITIES);
});

test('rivers have no cap', () => {
  const many = Array.from({ length: 40 }, (_, i) => `River ${i}`).join('\n');
  assert.equal(parseRoster('rivers', many).entries.length, 40);
});

test('duplicate polity keys are reported, not swallowed', () => {
  const ctx = baseContext(8, 8);
  // Both declared as "A": the Map used to keep the last and lose the first
  // silently, surfacing only as "owns no hexes" with nothing naming the cause.
  const response = {
    polities: [
      { key: 'A', name: 'Ardh', colour: '#b5533c' },
      { key: 'A', name: 'Brenn', colour: '#3f7a8c' },
    ],
    rows: Array.from({ length: 8 }, () => 'A'.repeat(8)),
    notes: 'x',
    decisions: [],
  };
  const { warnings } = decodeLayer('polities', response, ctx);
  const collision = warnings.find((w) => /Duplicate polity keys/.test(w));
  assert.ok(collision, `expected a duplicate-key warning, got: ${warnings.join(' | ')}`);
  assert.match(collision, /Ardh/);
  assert.match(collision, /Brenn/);
});
