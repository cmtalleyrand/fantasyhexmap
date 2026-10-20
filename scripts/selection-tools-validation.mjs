/** Run with node --import tsx scripts/selection-tools-validation.mjs [--driver PATH] [--chromium PATH]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMapState } from '../shared/layers.ts';
import { hexCenter, gridPixelSize } from '../shared/hex.ts';
import { buildRiverFromPath } from '../shared/validate.ts';
import { LAYER_ORDER } from '../shared/types.ts';
import { reducer } from '../src/state/store.ts';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';

let map = createMapState('', 12, 10, 'Selection tools review', [...LAYER_ORDER]);
const base = Array(120).fill('Sea');
for (let r = 0; r < 10; r++) for (let c = 0; c < 5; c++) base[r * 12 + c] = 'Land';
base[17] = base[29] = base[41] = 'Land';
map = reducer(map, { type: 'applyGeneration', layer: 'base', data: base, warnings: [], notes: null });
const name = 'The Sea of a Thousand Scattered Islands';
map.geoNames = [
  { id: 'sea-a', name, kind: 'sea', hexes: [17,18,19,29,30,31,41,42,43,53,54,55,65,66,67,77,78,79,89,90,91,101,102,103] },
  { id: 'sea-b', name: 'Gulf of Eskild', kind: 'sea', hexes: [20,21,22,32,33,34] },
];
const elevation = base.map(v => v === 'Land' ? 'Mountains' : null);
elevation[25] = 'Lowland';
for (const [layer, data] of Object.entries({ elevation, climate: base.map(v => v === 'Land' ? 'Cfb' : null), vegetation: base.map(v => v === 'Land' ? 'Grassland' : null), population: Array(120).fill(0) })) {
  map = reducer(map, { type: 'applyGeneration', layer, data, warnings: [], notes: null });
}
const rangeName = 'The Mountains of the Long Forgotten Northern Kingdom';
map.mountainRanges = [{ id: 'range-a', name: rangeName, hexes: [25,26,27,28] }];
const polityName = 'The Confederation of the Seven Western Provinces';
const owner = Array(120).fill(null); owner[61] = owner[62] = 'p-a'; owner[63] = owner[74] = 'p-b';
map = reducer(map, { type: 'applyGeneration', layer: 'polities', data: { polities: [{ id: 'p-a', name: polityName, colour: '#ac573c' }, { id: 'p-b', name: 'Eastern Kingdom', colour: '#4e759b' }], owner, shares: { '62': { polityId: 'p-b', share: .5 } } }, warnings: [], notes: null });
const cityName = 'The Ancient City of Saint Bartholomew by the Water';
map = reducer(map, { type: 'applyGeneration', layer: 'cities', data: { cities: [{ id: 'city-a', name: cityName, col: 1, row: 4, population: 5000, onRiver: false, riverId: null, coastal: false, coastalEdges: [] }] }, warnings: [], notes: null });
const riverName = 'The River of the Distant and Winding Eastern Marches';
const river = buildRiverFromPath({ name: riverName, path: [1,2,3,4,5].map(col => ({ col, row: 6 })), navigable: [false,false,false,false,false] }, 'river-a', base, elevation, 12, 10, []);
assert.ok(river);
map = reducer(map, { type: 'applyGeneration', layer: 'rivers', data: { rivers: [river] }, warnings: [], notes: null });
const browser = await launchBrowser();
const errors = [];
mkdirSync('work/selection-tools', { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await serveBuild(context, resolve('dist'));
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  await page.goto('http://render.test/blank');
  await page.evaluate(async map => {
    localStorage.setItem('fhm.mode', 'manual');
    localStorage.setItem('fantasyhexmap.prefs', JSON.stringify({ defaultsVersion: 2, offline: true }));
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('fantasyhexmap', 2);
      req.onupgradeneeded = () => { req.result.createObjectStore('maps'); req.result.createObjectStore('saves', { keyPath: 'id' }); };
      req.onsuccess = () => { const tx = req.result.transaction('maps', 'readwrite'); tx.objectStore('maps').put(map, 'current'); tx.oncomplete = resolve; tx.onerror = reject; };
      req.onerror = reject;
    });
  }, map);
  await page.goto('http://render.test/');
  const card = page.getByRole('article', { name, exact: true });
  await card.locator('.geo-title').click();
  await page.waitForFunction(() => !document.querySelector('.mapwrap[aria-busy="true"]'));
  assert.match(await card.innerText(), /Current area:\s*21 hexes/);
  assert.match(await card.innerText(), /3 assigned hexes excluded/);
  assert.match(await page.locator('.map-selection-count').innerText(), /0 hexes selected/);
  assert.equal(await card.locator('.geo-title').evaluate(el => el.scrollWidth <= el.clientWidth), true, 'long title wraps without clipping');
  const canvas = page.locator('.mapwrap canvas').first();
  await page.locator('.mapzoom').getByRole('button', { name: 'fit', exact: true }).click();
  const point = async (col, row) => {
    const box = await canvas.boundingBox(), grid = gridPixelSize(12, 10, 26);
    const scale = Math.max(.15, Math.min(4, (box.width - 40) / grid.width, (box.height - 40) / grid.height));
    const p = hexCenter(col, row, 26);
    return { x: box.x + (box.width - grid.width * scale) / 2 + p.x * scale,
      y: box.y + (box.height - grid.height * scale) / 2 + p.y * scale };
  };
  const clickHex = async (col, row) => { const p = await point(col, row); await page.mouse.click(p.x, p.y); };
  const stroke = async (a, b) => { const p = await point(...a), q = await point(...b); await page.mouse.move(p.x,p.y); await page.mouse.down(); await page.mouse.move(q.x,q.y,{steps:8}); await page.mouse.up(); };
  const count = async n => assert.match(await page.locator('.map-selection-count').innerText(), new RegExp(`^${n} hex(?:es)? selected`));
  const operations = page.getByRole('group', { name: 'Selection operation', exact: true });
  await operations.getByRole('button', { name: 'Replace', exact: true }).click();
  await stroke([6,2], [7,2]); await count(2);
  await operations.getByRole('button', { name: '+ Add', exact: true }).click();
  await clickHex(8,2); await count(3);
  await operations.getByRole('button', { name: '− Remove', exact: true }).click();
  await stroke([6,2], [7,2]); await count(1);
  assert.match(await card.innerText(), /Current area:\s*21 hexes/);

  const tools = page.getByRole('group', { name: 'Map feature tools', exact: true });
  await tools.getByRole('button', { name: '− Remove from area', exact: true }).click();
  await clickHex(6,2); await count(1);
  assert.match(await card.innerText(), /Current area:\s*20 hexes/);
  await tools.getByRole('button', { name: '+ Add to area', exact: true }).click();
  await clickHex(6,2); await count(1);
  assert.match(await card.innerText(), /Current area:\s*21 hexes/);
  await clickHex(2,3);
  assert.match(await card.innerText(), /Current area:\s*21 hexes/);
  await count(1);
  const alert = page.getByRole('alert');
  assert.match(await alert.innerText(), /No eligible sea hexes/);
  const alertBox = await alert.boundingBox(), statusBox = await page.locator('.map-selection-status').boundingBox();
  assert.ok(alertBox.y + alertBox.height <= statusBox.y, 'feedback does not obscure area controls');
  await alert.getByRole('button', { name: 'dismiss', exact: true }).click();
  // Keyboard undo works on strokes, and Escape disarms the feature brush.
  await page.keyboard.press('Control+z');
  assert.match(await card.innerText(), /Current area:\s*20 hexes/);
  await page.keyboard.press('Control+z');
  assert.match(await card.innerText(), /Current area:\s*21 hexes/);
  await page.keyboard.press('Escape'); await count(0);
  assert.equal(await tools.getByRole('button', { name: 'Select', exact: true }).getAttribute('aria-pressed'), 'true');
  await operations.getByRole('button', { name: 'Replace', exact: true }).click();
  await clickHex(2,3); await count(1);
  assert.match(await page.locator('.geo-create .geo-selection-summary').innerText(), /0 eligible · 1 excluded/);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await card.getByRole('button', { name: 'Select area', exact: true }).click(); await count(21);
  await page.screenshot({ path: 'work/selection-tools/desktop.png' });

  await card.getByRole('button', { name: 'Remove 21 from area', exact: true }).click();
  assert.match(await card.innerText(), /Current area:\s*0 hexes/);
  await page.keyboard.press('Control+z');
  assert.match(await card.innerText(), /Current area:\s*21 hexes/);

  // Switching feature and type disarms the previous area tool.
  await page.getByRole('article', { name: 'Gulf of Eskild', exact: true }).getByRole('button', { name: 'Edit area', exact: true }).click();
  assert.match(await page.locator('.map-active-feature').innerText(), /Gulf of Eskild/);
  await page.getByRole('group', { name: 'Feature type', exact: true }).getByRole('button', { name: 'Lakes', exact: true }).click();
  assert.equal(await page.locator('.map-active-feature').count(), 0);
  await page.getByRole('group', { name: 'Feature type', exact: true }).getByRole('button', { name: 'Seas and oceans', exact: true }).click();
  await card.locator('.geo-title').click();
  await page.setViewportSize({ width: 500, height: 900 });
  await page.getByRole('tab', { name: 'Edit', exact: true }).click();
  await card.scrollIntoViewIfNeeded();
  assert.equal(await card.evaluate(el => el.scrollWidth <= el.clientWidth), true, 'mobile card fits');
  await page.screenshot({ path: 'work/selection-tools/mobile.png' });
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const chooseLayer = async label => { await page.locator('.sidebar .layer-row').filter({ has: page.getByText(label, { exact: true }) }).click(); await count(0); await page.locator('.mapzoom').getByRole('button', { name: 'fit', exact: true }).click(); };
  await chooseLayer('Elevation / Ruggedness');
  const rangeCard = page.getByRole('article', { name: rangeName, exact: true });
  await rangeCard.locator('.geo-title').click();
  assert.match(await page.locator('.map-active-feature').innerText(), /Active mountain range/);
  assert.match(await rangeCard.innerText(), /Current area:\s*3 hexes/);
  assert.match(await rangeCard.innerText(), /1 assigned hex excluded/);
  await tools.getByRole('button', { name: '+ Add to area', exact: true }).click();
  await clickHex(4,3); await count(0);
  assert.match(await rangeCard.innerText(), /Current area:\s*4 hexes/);
  await tools.getByRole('button', { name: '− Remove from area', exact: true }).click();
  await clickHex(4,3); await count(0);
  assert.match(await rangeCard.innerText(), /Current area:\s*3 hexes/);
  await page.screenshot({ path: 'work/selection-tools/ranges.png' });

  await chooseLayer('Polities');
  const polityCard = page.getByRole('article', { name: polityName, exact: true });
  await polityCard.locator('.geo-title').click();
  assert.match(await page.locator('.map-active-feature').innerText(), /Active polity/);
  assert.match(await polityCard.innerText(), /Direct territory:\s*2 hexes/);
  assert.match(await polityCard.innerText(), /Ownership equivalent: 1.5 whole hexes/);
  await tools.getByRole('button', { name: '− Remove from area', exact: true }).click();
  await clickHex(2,5); await count(0);
  assert.match(await polityCard.innerText(), /Direct territory:\s*1 hex/);
  await page.keyboard.press('Control+z');
  assert.match(await polityCard.innerText(), /Direct territory:\s*2 hexes/);
  await polityCard.getByRole('button', { name: 'Select direct territory (2 hexes)', exact: true }).click(); await count(2);
  await page.screenshot({ path: 'work/selection-tools/polities.png' });

  await chooseLayer('Cities');
  const cityCard = page.getByRole('article', { name: cityName, exact: true });
  await cityCard.locator('.geo-title').click(); await count(1);
  assert.match(await page.locator('.map-active-feature').innerText(), /Active city/);
  await stroke([1,4], [2,4]);
  assert.match(await cityCard.innerText(), /Location:\s*hex 2,4/);
  await page.keyboard.press('Control+z');
  assert.match(await cityCard.innerText(), /Location:\s*hex 1,4/);
  await page.screenshot({ path: 'work/selection-tools/cities.png' });

  await chooseLayer('Rivers');
  const riverRow = page.locator('.river-row').filter({ hasText: riverName });
  await riverRow.click();
  assert.match(await page.locator('.map-active-feature').innerText(), /Active river/);
  await page.getByRole('button', { name: 'Select course hexes', exact: true }).click();
  await count(new Set(river.segments.map(s => s.row * 12 + s.col)).size);
  await page.getByRole('button', { name: 'hex-by-hex detail', exact: true }).click();
  const segment = page.locator('.segment-row').first();
  await segment.getByRole('button').click(); await count(1);
  await segment.getByRole('checkbox').check(); await count(1);
  await page.screenshot({ path: 'work/selection-tools/rivers.png' });
  for (const label of ['Climate', 'Vegetation', 'Population']) {
    await chooseLayer(label);
    await operations.getByRole('button', { name: 'Replace', exact: true }).click();
    await clickHex(3,3); await count(1);
    const brush = page.getByRole('checkbox', { name: /^(Paint .*|Clear this layer) on the map/ });
    await brush.check();
    assert.match(await page.locator('.map-active-feature').innerText(), /Paint|Clear/);
    await page.locator('.mapzoom').getByRole('button', { name: 'select', exact: true }).click();
    assert.equal(await brush.isChecked(), false);
  }
  // Verify long names and action rows fit in every feature editor on mobile.
  await page.setViewportSize({ width: 500, height: 900 });
  for (const [label, selector] of [['Elevation / Ruggedness', '.geo-card'], ['Polities', '.polity-entry'], ['Cities', '.geo-card'], ['Rivers', '.river-row']]) {
    await page.getByRole('tab', { name: 'Layers', exact: true }).click();
    await chooseLayer(label);
    await page.getByRole('tab', { name: 'Edit', exact: true }).click();
    const item = page.locator('.inspector').locator(selector).first();
    await item.scrollIntoViewIfNeeded();
    assert.equal(await item.evaluate(el => el.scrollWidth <= el.clientWidth), true, `${label} mobile card fits`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS: all eight layer menus, feature focus, range/polity strokes, city movement, river selection, mobile layouts; readable titles, explicit counts, replace/add/remove selection, independent feature strokes, undo, Escape, terrain filtering, feature switching and mobile layout.');
} finally { await browser.close(); }
