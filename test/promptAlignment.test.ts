import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { contextFromMap, existingFeatures } from '../core/context.ts';
import { buildPrompt } from '../core/prompts.ts';
import { validateGenerateBody } from '../core/request.ts';
import { importWebchatResponse, buildMultiWebchatPrompt } from '../core/webchat.ts';
import { combinePasses, rosterFromResponse, rosterOnlyResponse } from '../core/passes.ts';
import { decodeLayer } from '../core/decode.ts';
import { DEFAULT_HEX_DIMENSIONS, type PolitiesData, type CitiesData, type RiversData } from '../shared/types.ts';
import { canHoldSettlement } from '../shared/derive.ts';

function fixture() {
  const map = createMapState('Kingdom contains Duchy. Seat is the capital.', 3, 3);
  map.layers.base.data = ['Land', 'Lake', 'Islands', 'Glacier', 'Isthmus', 'Strait', 'Land', 'Land', 'Land'];
  map.hexDimensions = { ...DEFAULT_HEX_DIMENSIONS, width: 20, height: 30, coastalLandPercent: 70 };
  map.islandSpecs = { '2': { large: 2, small: 1 } };
  map.hexShapes = { '0': { type: 'Land', land: 60 } };
  map.geoNames = [{ id: 'g', name: 'Silver Lake', kind: 'lake', hexes: [1] }];
  map.layers.polities.data = {
    polities: [
      { id: 'king', name: 'Kingdom', shortName: 'K', colour: '#884422' },
      { id: 'duke', name: 'Duchy', shortName: 'D', colour: '#446688', parentId: 'king', cityState: true, autoShade: true },
    ],
    owner: ['duke', null, 'duke', 'duke', 'duke', 'duke', 'duke', 'king', 'king'],
    shares: { '6': { polityId: 'king', share: 0.3 } },
  };
  map.layers.cities.data = { cities: [{ id: 'seat', name: 'Seat', col: 0, row: 2, population: 5000,
    capital: true, site: 'inland', onRiver: false, riverId: null, coastal: false, coastalEdges: [] }] };
  return map;
}

const reply = (sharedHexes?: unknown[]) => ({
  polities: [
    { key: 'A', name: 'Kingdom', shortName: 'K', colour: '#884422', hexes: 2 },
    { key: 'B', name: 'Duchy', shortName: 'D', colour: '#446688', parent: 'Kingdom', hexes: 6 },
  ],
  rows: ['B.B', 'BBB', 'BAA'], ...(sharedHexes ? { sharedHexes } : {}),
});

test('all transports retain physical settings, overrides and measured land fractions in prompt context', () => {
  const map = fixture();
  const direct = contextFromMap(map, null);
  const checked = validateGenerateBody({ layer: 'polities', cols: 3, rows: 3, description: map.description,
    hexDimensions: map.hexDimensions, islandSpecs: map.islandSpecs, hexShapes: map.hexShapes,
    geoNames: map.geoNames, layers: { base: map.layers.base.data, polities: map.layers.polities.data } });
  assert.ok('req' in checked);
  assert.deepEqual(checked.req.ctx.hexDimensions, direct.hexDimensions);
  assert.deepEqual(checked.req.ctx.islandSpecs, direct.islandSpecs);
  assert.deepEqual(checked.req.ctx.hexShapes, direct.hexShapes);
  for (const ctx of [direct, checked.req.ctx]) {
    const { user, system } = buildPrompt('polities', ctx);
    assert.match(user, /One whole hex: 450 km\^2/);
    assert.match(user, /r0: \[0\] 60 0 35/);
    assert.doesNotMatch(user, /Factory defaults|"coastalLandPercent":80/);
    assert.match(user, /"coastalLandPercent":70/);
    assert.match(user, /Silver Lake/);
    assert.match(user, /Measured polity land areas/);
    assert.match(system, /Do not infer another scale/);
  }
  const multi = buildMultiWebchatPrompt({ layers: ['base', 'elevation'], ctx: direct });
  assert.equal((multi.match(/PHYSICAL SCALE AND LAND SURFACE AREAS/g) ?? []).length, 1);
  assert.match(multi, /"land":60/);
  assert.ok('error' in validateGenerateBody({ layer: 'base', cols: 3, rows: 3, hexDimensions: { width: -1, height: 30, unit: 'km' } }));
  assert.ok('error' in validateGenerateBody({ layer: 'base', cols: 3, rows: 3, hexShapes: { '0': { type: 'Land', land: 150 } } }));
});

test('50/50 output imports and manual shares survive unrelated edits, with explicit clearing supported', () => {
  const ctx = contextFromMap(fixture(), 'Change only the boundary at (1,2).');
  const options = { layer: 'polities' as const, pass: 'full' as const, ctx, existing: existingFeatures(ctx) };
  const result = importWebchatResponse({ ...options, text: JSON.stringify(reply([{ col: 1, row: 2, with: 'B', share: 0.5 }])) });
  const data = result.data as PolitiesData;
  assert.deepEqual(data.shares, { '6': { polityId: 'king', share: 0.3 }, '7': { polityId: 'duke', share: 0.5 } });
  assert.equal(data.polities[1]!.cityState, true);
  assert.equal(data.polities[1]!.autoShade, true);
  assert.equal(data.polities[1]!.parentId, 'king');
  const cleared = importWebchatResponse({ ...options, text: JSON.stringify(reply([{ col: 0, row: 2, with: null, share: 0.5 }])) });
  assert.equal((cleared.data as PolitiesData).shares, undefined);
  assert.throws(() => importWebchatResponse({ ...options, text: JSON.stringify(reply([{ col: 1, row: 2, with: 'B', share: 0.3 }])) }), /expected shape/);
  const invalid = decodeLayer('polities', reply([{ col: 1, row: 2, with: 'Z', share: 0.5 }, { col: 99, row: 2, with: 'B', share: 0.5 }]), ctx, existingFeatures(ctx));
  assert.equal(invalid.warnings.filter((w) => /shared/.test(w)).length, 2);
  const changed = reply(); changed.rows[2] = 'AAA';
  assert.equal((decodeLayer('polities', changed, ctx, existingFeatures(ctx)).data as PolitiesData).shares, undefined);
});

test('two-pass output carries sharing and zero-direct-territory parents through to decoding', () => {
  const ctx = contextFromMap(fixture(), 'Retain the parent and its duchy.');
  const roster = rosterFromResponse('polities', { polities: [{ key: 'A', name: 'Kingdom', colour: '#884422', hexes: 0 },
    { key: 'B', name: 'Duchy', colour: '#446688', parent: 'Kingdom', hexes: 8 }] });
  assert.equal(roster.kind, 'polities');
  if (roster.kind !== 'polities') return;
  assert.equal(roster.entries[0]!.hexes, 0);
  const paint = buildPrompt('polities', ctx, 'paint', roster);
  assert.match(paint.user, /Kingdom.*0 hexes/);
  assert.match(paint.user, /Duchy.*parent=Kingdom/);
  assert.match(paint.user, /CURRENT|POLITIES/);
  const combined = combinePasses('polities', roster, { rows: ['B.B', 'BBB', 'BBB'],
    sharedHexes: [{ col: 1, row: 2, with: 'A', share: 0.5 }] });
  const result = decodeLayer('polities', combined, ctx, existingFeatures(ctx));
  assert.equal((result.data as PolitiesData).shares!['7']!.share, 0.5);
  assert.ok(!result.warnings.some((w) => /Kingdom holds/.test(w)));
  const renamed = { kind: 'polities' as const, entries: roster.entries.map((e) => ({ ...e, name: `${e.name} renamed`, parent: e.parent ? `${e.parent} renamed` : undefined })) };
  const folded = rosterOnlyResponse('polities', renamed, ctx);
  const renamedData = decodeLayer('polities', folded, ctx, existingFeatures(ctx)).data as PolitiesData;
  assert.equal(renamedData.polities[1]!.id, 'duke');
  assert.equal(renamedData.polities[1]!.cityState, true);
  assert.equal(renamedData.shares!['6']!.share, 0.3);
});

test('city edits retain manual sites and capital status, including explicit renames and removal of capital status', () => {
  const ctx = contextFromMap(fixture(), 'Rename Seat to New Seat.');
  const input = { cities: [{ name: 'New Seat', previousName: 'Seat', col: 0, row: 2, population: 5000 }] };
  const city = (decodeLayer('cities', input, ctx, existingFeatures(ctx)).data as CitiesData).cities[0]!;
  assert.equal(city.id, 'seat'); assert.equal(city.site, 'inland'); assert.equal(city.capital, true);
  const removed = (decodeLayer('cities', { ...input, cities: [{ ...input.cities[0], capital: false }] }, ctx, existingFeatures(ctx)).data as CitiesData).cities[0]!;
  assert.equal(removed.capital, undefined);
});

test('river prompts assume tapered drawing and explain the additional physical correction in every pass', () => {
  const ctx = contextFromMap(fixture(), null);
  for (const pass of ['full', 'roster', 'paint'] as const) {
    const prompt = buildPrompt('rivers', ctx, pass, { kind: 'rivers', entries: [{ name: 'R', course: 'north to south' }] });
    assert.match(prompt.system, /Assume the default TAPERED renderer/);
    assert.match(prompt.system, /Catmull-Rom/);
    assert.match(prompt.system, /1\.05 \* A\^0\.02/);
    assert.match(prompt.system, /A = 450 km\^2/);
    assert.match(prompt.system, /on top of bends already visible/);
    assert.doesNotMatch(prompt.system, /classic style|600 km.*12 hexes/);
  }
});

test('roster-only river renames retain exact manually edited geometry and connections', () => {
  const map = fixture();
  map.layers.rivers.data = { rivers: [{ id: 'r', name: 'Old', terminus: 'Sea',
    segments: [{ col: 1, row: 2, entryEdge: null, exitEdge: 2, navigable: true, reach: { min: 0.5, max: null } }] }] };
  const ctx = contextFromMap(map, null);
  const folded = rosterOnlyResponse('rivers', { kind: 'rivers', entries: [{ name: 'New', course: '' }] }, ctx);
  const output = decodeLayer('rivers', folded, ctx, existingFeatures(ctx)).data as RiversData;
  assert.deepEqual(output.rivers[0], { ...map.layers.rivers.data.rivers[0], name: 'New' });
});

test('terrain eligibility and defaults match the supported map model', () => {
  assert.equal(canHoldSettlement('Sea Ice', true), false);
  assert.equal(canHoldSettlement('Sea', true), true);
  assert.equal(canHoldSettlement('Glacier', false), true);
  assert.equal(canHoldSettlement('Isthmus', false), true);
  assert.equal(canHoldSettlement('Strait', false), true);
  assert.equal(DEFAULT_HEX_DIMENSIONS.coastalLandPercent, 80);
  assert.equal(DEFAULT_HEX_DIMENSIONS.lakeLandPercent, 0);
  assert.equal(DEFAULT_HEX_DIMENSIONS.largeIslandPercent, 15);
  assert.equal(DEFAULT_HEX_DIMENSIONS.smallIslandPercent, 5);
  assert.equal(DEFAULT_HEX_DIMENSIONS.mainlandPercent, 40);
});
