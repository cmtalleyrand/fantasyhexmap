import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { buildPrompt } from '../core/prompts.ts';
import { serializeMapExport, serializeParseFriendlyExport } from '../src/render/export.ts';

test('JSON export is parseable and omits history only when requested', () => {
  const map = createMapState('A compact island realm.', 3, 3, 'Test Realm');
  map.layers.base.past = [{
    data: Array(9).fill('Land'),
    warnings: [],
    notes: null,
    generatedAt: null,
    depVersions: {},
  }];

  const withoutHistory = JSON.parse(serializeMapExport(map, false));
  const withHistory = JSON.parse(serializeMapExport(map, true));

  assert.equal(withoutHistory.format, 'fantasyhexmap/v1');
  assert.deepEqual(withoutHistory.map.layers.base.past, []);
  assert.equal(withHistory.map.layers.base.past.length, 1);
});

test('parse-friendly export drops all decision records and adds a guide and hex list', () => {
  const map = createMapState('A compact island realm.', 3, 2, 'Test Realm');
  map.layers.base.data = ['Land', 'Sea', 'Land', 'Land', 'Land', 'Sea'];
  map.layers.base.notes = 'secret reasoning';
  map.layers.base.warnings = ['a warning'];
  map.layers.base.past = [{ data: Array(6).fill('Land'), warnings: [], notes: null, generatedAt: null, depVersions: {} }];
  map.journal = [{
    id: 'j1', layer: 'base', kind: 'generate', at: 0, instruction: null, summary: 'why',
    decisions: [{ title: 'Because', detail: 'reasons' }], model: null, warnings: 0,
  }];

  const text = serializeParseFriendlyExport(map);
  const out = JSON.parse(text);

  assert.equal(out.variant, 'parse-friendly');
  assert.equal(out.guide.grid.flatIndex, 'index = row * cols + col');
  assert.equal(out.hexes.length, 6);
  assert.deepEqual(out.hexes[4], { index: 4, col: 1, row: 1, base: 'Land' });
  assert.equal(out.map.journal, undefined);
  assert.deepEqual(Object.keys(out.map.layers.base).sort(), ['data', 'version']);
  assert.doesNotMatch(text, /secret reasoning|a warning|Because/);
});

test('generation prompts derive a scale from the brief and never invent one', () => {
  const map = createMapState('A temperate island realm.', 3, 3);
  map.layers.base.data = Array(9).fill('Land');
  const context = {
    description: map.description,
    cols: map.cols,
    rows: map.rows,
    base: map.layers.base.data,
    elevation: map.layers.elevation.data,
    climate: map.layers.climate.data,
    vegetation: map.layers.vegetation.data,
    rivers: map.layers.rivers.data,
    cities: map.layers.cities.data,
    polities: map.layers.polities.data,
    population: map.layers.population.data,
  };

  for (const layer of ['base', 'population'] as const) {
    const prompt = buildPrompt(layer, context).system;
    assert.doesNotMatch(prompt, /40 km|1,400 km/i);
    assert.match(prompt, /If the brief gives no size of any kind, do not invent one/);
    assert.match(prompt, /Convert every stated area into a hex count/);
  }
});
