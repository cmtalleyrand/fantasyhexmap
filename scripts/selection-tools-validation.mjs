/** Run with node --import tsx scripts/selection-tools-validation.mjs [--driver PATH] [--chromium PATH]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMapState } from '../shared/layers.ts';
import { hexCenter, gridPixelSize } from '../shared/hex.ts';
import { reducer } from '../src/state/store.ts';
import { launchBrowser, serveBuild } from './browser-runtime.mjs';

let map = createMapState('', 12, 10, 'Selection tools review', ['base']);
const base = Array(120).fill('Sea');
for (let r = 0; r < 10; r++) for (let c = 0; c < 5; c++) base[r * 12 + c] = 'Land';
base[17] = base[29] = base[41] = 'Land';
map = reducer(map, { type: 'applyGeneration', layer: 'base', data: base, warnings: [], notes: null });
const name = 'The Sea of a Thousand Scattered Islands';
map.geoNames = [
  { id: 'sea-a', name, kind: 'sea', hexes: [17,18,19,29,30,31,41,42,43,53,54,55,65,66,67,77,78,79,89,90,91,101,102,103] },
  { id: 'sea-b', name: 'Gulf of Eskild', kind: 'sea', hexes: [20,21,22,32,33,34] },
];
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
  const point = async (col, row) => {
    const box = await canvas.boundingBox(), grid = gridPixelSize(12, 10, 26);
    const scale = Math.max(.15, Math.min(4, (box.width - 40) / grid.width, (box.height - 40) / grid.height));
    const p = hexCenter(col, row, 26);
    return { x: box.x + (box.width - grid.width * scale) / 2 + p.x * scale,
      y: box.y + (box.height - grid.height * scale) / 2 + p.y * scale };
  };
  const clickHex = async (col, row) => { const p = await point(col, row); await page.mouse.click(p.x, p.y); };
  const stroke = async (a, b) => { const p = await point(...a), q = await point(...b); await page.mouse.move(p.x,p.y); await page.mouse.down(); await page.mouse.move(q.x,q.y,{steps:8}); await page.mouse.up(); };
  const count = async n => assert.match(await page.locator('.map-selection-count').innerText(), new RegExp(`^${n} hexes selected`));
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
  assert.match(await page.locator('.geo-selection-summary').innerText(), /0 eligible · 1 excluded/);
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
  assert.deepEqual(errors, []);
  console.log('PASS: readable titles, explicit counts, replace/add/remove selection, independent feature strokes, undo, Escape, terrain filtering, feature switching and mobile layout.');
} finally { await browser.close(); }
