import assert from 'node:assert/strict';
import test from 'node:test';
import { hexCenter } from '../shared/hex.ts';
import type { BaseGeo } from '../shared/types.ts';
import { placeWaterLabels } from '../src/render/featureLabels.ts';

const SIZE = 20;

/** A `cols` x `rows` map that is sea where `isSea` says so and land elsewhere. */
function seaWhere(cols: number, rows: number, isSea: (col: number, row: number) => boolean) {
  const base: BaseGeo[] = [];
  const hexes: number[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const sea = isSea(i % cols, Math.floor(i / cols));
    base.push(sea ? 'Sea' : 'Land');
    if (sea) hexes.push(i);
  }
  return { base, hexes };
}

function centreOf(hexes: number[], cols: number) {
  const pts = hexes.map((i) => hexCenter(i % cols, Math.floor(i / cols), SIZE));
  return { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
}

test('an ocean is named in larger type than a pond, near the middle of its body', () => {
  const cols = 40;
  const rows = 30;
  const ocean = seaWhere(cols, rows, (c) => c >= 4);
  const [label] = placeWaterLabels([{ name: 'Tovayan Ocean', hexes: ocean.hexes }], cols, SIZE, undefined, ocean.base, rows);
  assert.ok(label, 'the ocean is named');
  assert.ok(label.size > SIZE * 0.85, `type ${label.size.toFixed(1)} should exceed the old cap of ${SIZE * 0.85}`);
  const middle = centreOf(ocean.hexes, cols);
  const radius = Math.sqrt(ocean.hexes.length) * SIZE;
  assert.ok(Math.hypot(label.at.x - middle.x, label.at.y - middle.y) < radius * 0.5, 'the name sits near the middle of the body, not at its edge');

  const pond = seaWhere(cols, rows, (c, r) => c >= 10 && c <= 12 && r >= 10 && r <= 12);
  const [small] = placeWaterLabels([{ name: 'Mere', hexes: pond.hexes }], cols, SIZE, undefined, pond.base, rows);
  assert.ok(small && small.size <= SIZE * 0.85 + 1e-6, 'a body only a few hexes across keeps modest type');
});

test('a long narrow ocean along the map edge is named from its middle, not from one end', () => {
  const cols = 40;
  const rows = 60;
  const strip = seaWhere(cols, rows, (c) => c >= 36);
  const [label] = placeWaterLabels([{ name: 'Sinafinian Ocean', hexes: strip.hexes }], cols, SIZE, undefined, strip.base, rows);
  assert.ok(label, 'the strip is named');
  const middle = centreOf(strip.hexes, cols);
  const length = rows * 1.5 * SIZE;
  assert.ok(Math.abs(label.at.y - middle.y) < length * 0.2, `name at y=${label.at.y.toFixed(0)} should be near the strip's middle y=${middle.y.toFixed(0)}`);
});
