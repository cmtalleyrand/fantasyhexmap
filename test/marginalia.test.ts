import assert from 'node:assert/strict';
import test from 'node:test';
import { gridPixelSize, hexIndex } from '../shared/hex.ts';
import { createMapState } from '../shared/layers.ts';
import type { BaseGeo, MapState } from '../shared/types.ts';
import { auditScene } from '../src/render/audit.ts';
import { boxesOverlap, textBoxes, textPrims } from '../src/render/collide.ts';
import { buildExportScene } from '../src/render/export.ts';
import { addMarginalia, DEFAULT_MARGINALIA, niceLength, scaleBarFor } from '../src/render/marginalia.ts';
import type { Prim } from '../src/render/prims.ts';
import { defaultVisibility, withLandOf } from '../src/render/scene.ts';
import { sceneToSvg } from '../src/render/svg.ts';

const SIZE = 32;

/** A `cols` x `rows` sea with a realm on the western third, so the east is open water. */
function seaMap(cols = 16, rows = 10): MapState {
  const map = createMapState('A map', cols, rows, 'Lonnavar Sea');
  const base: BaseGeo[] = Array(cols * rows).fill('Sea');
  const owner: (string | null)[] = Array(cols * rows).fill(null);
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < 5; c++) {
      base[hexIndex(cols, c, r)] = 'Land';
      owner[hexIndex(cols, c, r)] = 'b';
    }
  }
  map.layers.base.data = base;
  (map.layers.polities as { data: unknown }).data = { polities: [{ id: 'b', name: 'Mainland', colour: '#36a' }], owner };
  return map;
}

function sceneOf(map: MapState, marginalia: Parameters<typeof buildExportScene>[2]['marginalia']) {
  const visible = defaultVisibility();
  visible.polities = true;
  return buildExportScene(map, visible, { format: 'svg', labels: true, polityNames: 0, size: SIZE, marginalia });
}

test('the scale bar is derived from the configured width of a hex', () => {
  const map = seaMap();
  const { width } = gridPixelSize(map.cols, map.rows, SIZE);
  const hexPx = SIZE * Math.sqrt(3);
  map.hexDimensions = { ...map.hexDimensions, width: 10, unit: 'km' };
  const ten = scaleBarFor(map, SIZE, 0.3 * width);
  // The bar's pixels are exactly its length in units at one hex = 10 km.
  assert.ok(Math.abs(ten.px - (ten.units * hexPx) / 10) < 1e-9);
  assert.equal(ten.unit, 'km');
  // Hexes half as wide cover half the ground: the same bar is twice the length in units.
  map.hexDimensions = { ...map.hexDimensions, width: 5, unit: 'mi' };
  const five = scaleBarFor(map, SIZE, 0.3 * width);
  assert.ok(Math.abs(five.px - (five.units * hexPx) / 5) < 1e-9);
  assert.ok(five.units < ten.units, 'a hex of 5 reaches fewer units than a hex of 10 in the same width');
  assert.equal(five.unit, 'mi');
});

test('a scale bar is rounded down to 1, 2, 2.5 or 5 times a power of ten', () => {
  assert.equal(niceLength(48), 25);
  assert.equal(niceLength(50), 50);
  assert.equal(niceLength(99), 50);
  assert.equal(niceLength(100), 100);
  assert.equal(niceLength(0.7), 0.5);
  assert.equal(niceLength(2.4), 2);
  assert.equal(niceLength(0), 1);
});

test('the scale bar labels name its length and unit', () => {
  const map = seaMap();
  const scene = sceneOf(map, { frame: false, title: false, scaleBar: true, compass: false });
  const labels = textPrims(scene.prims).filter((p) => p.tag?.kind === 'scale').map((p) => p.text);
  assert.equal(labels.length, 3);
  assert.equal(labels[0], '0');
  assert.match(labels[2]!, /^\d+(\.\d+)? km$/);
});

test('a frame grows the page by a margin on every side and leaves the map as it was', () => {
  const map = seaMap();
  const bare = sceneOf(map, null);
  const framed = sceneOf(map, { frame: true, title: false, scaleBar: false, compass: false });
  assert.ok(framed.origin && framed.origin.x > 0 && framed.origin.y > 0);
  assert.equal(framed.width, bare.width + 2 * framed.origin.x);
  assert.equal(framed.height, bare.height + 2 * framed.origin.y);
  const group = framed.prims.find((p): p is Extract<Prim, { kind: 'group' }> => p.kind === 'group' && !!p.translate);
  assert.deepEqual(group?.translate, framed.origin);
  // The bare map's primitives are inside the shifted group, unchanged, after the sea laid under them.
  assert.deepEqual(group!.prims.slice(1, 1 + bare.prims.length), bare.prims);
  const svg = sceneToSvg(framed, 'framed', '');
  assert.match(svg, /transform="translate\(/);
});

test('furniture sits on open sea, clear of land, names and each other', () => {
  const map = seaMap();
  const scene = sceneOf(map, DEFAULT_MARGINALIA);
  const placed = scene.furniture!;
  assert.deepEqual(placed.map((f) => f.kind).sort(), ['compass', 'scale', 'title']);
  assert.ok(placed.every((f) => f.where === 'sea'), 'the east is open, so nothing needs the band');
  assert.deepEqual(auditScene(map, scene, SIZE), []);
  // And independently of the audit: no piece's lettering overlaps a name.
  const names = textPrims(scene.prims).filter((p) => p.tag && !['title', 'scale', 'compass'].includes(p.tag.kind)).flatMap(textBoxes);
  for (const f of placed) assert.ok(!names.some((n) => boxesOverlap(f.box, n)));
});

test('a piece that fits nowhere on the map is set in the margin band, which grows to hold it', () => {
  const cols = 14;
  const rows = 9;
  const map = createMapState('A map', cols, rows, 'Landlocked');
  map.layers.base.data = Array<BaseGeo>(cols * rows).fill('Land');
  const scene = sceneOf(map, DEFAULT_MARGINALIA);
  const placed = scene.furniture!;
  assert.ok(placed.every((f) => f.where === 'band'));
  const bare = sceneOf(map, null);
  assert.ok(scene.width > bare.width && scene.height > bare.height);
  assert.deepEqual(auditScene(map, scene, SIZE), []);
  // Every piece lies wholly on the page.
  const origin = scene.origin!;
  for (const f of placed) {
    assert.ok(f.box.cx - f.box.halfW + origin.x >= 0 && f.box.cx + f.box.halfW + origin.x <= scene.width);
    assert.ok(f.box.cy - f.box.halfH + origin.y >= 0 && f.box.cy + f.box.halfH + origin.y <= scene.height);
  }
});

test('a legend panel is part of the page the furniture keeps clear of', () => {
  const map = seaMap();
  const visible = defaultVisibility();
  visible.polities = true;
  const scene = buildExportScene(map, visible, {
    format: 'svg',
    labels: true,
    polityNames: 0,
    size: SIZE,
    legend: { exclude: [], onlyUsed: true, polityAreas: false, riverLengths: false, title: true },
    marginalia: DEFAULT_MARGINALIA,
  });
  const panel = scene.furniture!.find((f) => f.kind === 'legend');
  assert.ok(panel && panel.where === 'panel');
  for (const f of scene.furniture!.filter((x) => x.kind !== 'legend')) assert.ok(!boxesOverlap(f.box, panel.box));
  // The title is set on the map, so the legend does not repeat it.
  const heads = textPrims(scene.prims).filter((p) => p.text === 'Lonnavar Sea');
  assert.equal(heads.length, 1);
  assert.deepEqual(auditScene(map, scene, SIZE), []);
});

test('without furniture the scene is untouched', () => {
  const map = seaMap();
  const bare = sceneOf(map, null);
  assert.equal(bare.furniture, undefined);
  const same = addMarginalia(map, bare, SIZE, { frame: false, title: false, scaleBar: false, compass: false });
  assert.equal(same, bare);
});

// --- the audit ---------------------------------------------------------------

/** A scene's primitives with every realm name removed, and `more` added. */
function withNames(map: MapState, more: Prim[], marginalia = null as Parameters<typeof sceneOf>[1]) {
  const scene = sceneOf(map, marginalia);
  return withLandOf({ ...scene, prims: [...scene.prims.filter((p) => !(p.kind === 'text' && p.tag?.kind === 'polity')), ...more] }, scene);
}

function name(text: string, x: number, y: number, kind: 'polity' | 'water' | 'river', owner?: string): Prim {
  return { kind: 'text', at: { x, y }, text, size: 20, fill: '#000', anchor: 'middle', fantasy: true, tag: { kind, ...(owner ? { owner } : {}) } };
}

test('the audit reports two names that overlap, and none that merely sit near each other', () => {
  const map = seaMap();
  const near = auditScene(map, withNames(map, [name('ALPHA', 400, 300, 'water'), name('BETA', 400, 340, 'water')]), SIZE);
  assert.deepEqual(near.filter((i) => i.kind === 'name-overlaps-name'), []);
  const over = auditScene(map, withNames(map, [name('ALPHA', 400, 300, 'water'), name('BETA', 410, 305, 'water')]), SIZE);
  assert.equal(over.filter((i) => i.kind === 'name-overlaps-name').length, 1);
});

test('the audit reports a sea name that lies over land', () => {
  const map = seaMap();
  const c = { x: SIZE * Math.sqrt(3) * 3, y: SIZE * 1.5 * 4 + SIZE };
  const issues = auditScene(map, withNames(map, [name('THE SOUND', c.x, c.y, 'water')]), SIZE);
  assert.equal(issues.filter((i) => i.kind === 'sea-name-over-land').length, 1);
  const clear = auditScene(map, withNames(map, [name('THE SOUND', SIZE * Math.sqrt(3) * 11, SIZE * 6, 'water')]), SIZE);
  assert.deepEqual(clear.filter((i) => i.kind === 'sea-name-over-land'), []);
});

test('the audit reports a realm name printed across the islands it names', () => {
  // The case that prompted the audit: "LONNAVAR" on the two small islands of its own realm.
  const cols = 16;
  const rows = 10;
  const map = createMapState('A map', cols, rows, 'Lonnavar Sea');
  const base: BaseGeo[] = Array(cols * rows).fill('Sea');
  const owner: (string | null)[] = Array(cols * rows).fill(null);
  for (const c of [13, 14]) {
    base[hexIndex(cols, c, 8)] = 'Islands';
    owner[hexIndex(cols, c, 8)] = 'a';
  }
  map.layers.base.data = base;
  (map.layers.polities as { data: unknown }).data = { polities: [{ id: 'a', name: 'Lonnavar', colour: '#a33' }], owner };
  const w = SIZE * Math.sqrt(3);
  const across = name('LONNAVAR', 14 * w + w, SIZE * 1.5 * 8 + SIZE, 'polity', 'a');
  const issues = auditScene(map, withNames(map, [across]), SIZE);
  assert.equal(issues.filter((i) => i.kind === 'realm-name-covers-own-land').length, 1);
  // Set beside the islands instead, the same name is fine.
  const beside = name('LONNAVAR', 9 * w, SIZE * 1.5 * 5, 'polity', 'a');
  assert.deepEqual(auditScene(map, withNames(map, [beside]), SIZE), []);
});

test('the audit reports furniture that has been placed over land, a name or another piece', () => {
  const map = seaMap();
  const scene = sceneOf(map, DEFAULT_MARGINALIA);
  const title = scene.furniture!.find((f) => f.kind === 'title')!;
  const compass = scene.furniture!.find((f) => f.kind === 'compass')!;
  const land = { cx: SIZE * Math.sqrt(3) * 3, cy: SIZE * 1.5 * 4, halfW: 40, halfH: 40, rotation: 0 };
  const moved = (box: typeof land, where: 'sea' | 'band' = 'sea') =>
    withLandOf({ ...scene, furniture: scene.furniture!.map((f) => (f === compass ? { ...f, box, where } : f)) }, scene);
  assert.ok(auditScene(map, moved(land), SIZE).some((i) => i.kind === 'furniture-over-land'));
  assert.ok(auditScene(map, moved({ ...title.box }), SIZE).some((i) => i.kind === 'furniture-overlaps-furniture'));
  assert.ok(auditScene(map, moved({ ...land, cx: -500, cy: -500 }), SIZE).some((i) => i.kind === 'furniture-off-page'));
  assert.ok(auditScene(map, moved({ ...land, cx: 10, cy: 10 }, 'band'), SIZE).some((i) => i.kind === 'band-furniture-over-map'));
});
