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
