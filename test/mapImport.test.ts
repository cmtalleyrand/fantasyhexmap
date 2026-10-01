import assert from 'node:assert/strict';
import test from 'node:test';

import { createMapState } from '../shared/layers.js';
import { parseMapImport } from '../src/state/import.js';

test('a saved map imports from its export wrapper', () => {
  const map = createMapState('A realm.', 3, 3);
  assert.deepEqual(parseMapImport(JSON.stringify({ format: 'fantasyhexmap/v1', map })), map);
});

test('a webchat layer bundle is distinguished from a saved-map export', () => {
  const response = JSON.stringify({ base: { rows: [] }, elevation: { rows: [] } });
  assert.throws(() => parseMapImport(response), /webchat layer response.*“by webchat”/);
});

test('malformed JSON explains the single-document and escape rules', () => {
  assert.throws(() => parseMapImport('{}{}'), /only one top-level object/);
  assert.throws(() => parseMapImport('{"scale":"\\~111 km"}'), /backslashes may only introduce valid JSON escapes/);
});
