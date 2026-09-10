import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { buildPrompt } from '../core/prompts.ts';
import { serializeMapExport } from '../src/render/export.ts';

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

test('generation prompts do not invent a physical hex scale', () => {
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
    assert.match(prompt, /do not assume a distance, area, or kilometres-per-hex value/i);
  }
});
