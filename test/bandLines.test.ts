import assert from 'node:assert/strict';
import test from 'node:test';
import { markBandLine, paintBandLine } from '../src/render/bandLines.js';
import type { PathCmd, Prim } from '../src/render/prims.js';

type Path = Extract<Prim, { kind: 'path' }>;
const path = (d: PathCmd[]): Path => ({ kind: 'path', d, stroke: '#123456', strokeWidth: 2, round: true });

test('only marked band primitives are thinned; shared scene commands stay intact', () => {
  const d: PathCmd[] = [['M', 0, 0], ['L', 1, .005], ['L', 2, -.005], ['L', 3, 0], ['Z']];
  const original = JSON.stringify(d), band = markBandLine(path(d), 1), other = path(d);
  const drawn = paintBandLine(band);
  assert.deepEqual(drawn, [d[0], d[3], d[4]]);
  assert.equal(paintBandLine(other), d);
  assert.equal(band.d, d);
  assert.equal(JSON.stringify(band.d), original);
  assert.equal(paintBandLine(band), drawn, 'reuse the compiled outline between paints');
});

test('subpaths, curves and closures retain their original commands', () => {
  const d: PathCmd[] = [['M', 0, 0], ['L', 1, .001], ['L', 2, 0], ['Z'],
    ['M', 5, 0], ['L', 6, 0], ['Q', 7, 1, 8, 0], ['L', 9, 0], ['C', 10, 1, 11, 1, 12, 0], ['Z']];
  assert.deepEqual(paintBandLine(markBandLine(path(d), 1)), [d[0], ...d.slice(2)]);
});

test('path sharing after an edit preserves the band marker and reuses the thinned outline', () => {
  const previous = markBandLine(path([['M', 0, 0], ['L', 1, .001], ['L', 2, 0]]), 1);
  const drawn = paintBandLine(previous);
  const next = markBandLine(path(structuredClone(previous.d)), 1);
  next.d = previous.d; // shareUnchangedPaths replaces arrays, retaining primitives.
  assert.equal(paintBandLine(next), drawn);
  assert.equal(paintBandLine(path(previous.d)), previous.d);
});

test('the same commands can be painted with different size tolerances', () => {
  const d: PathCmd[] = [['M', 0, 0], ['L', 1, .005], ['L', 2, 0]];
  assert.equal(paintBandLine(markBandLine(path(d), 1)).length, 2);
  assert.equal(paintBandLine(markBandLine(path(d), .5)).length, 3);
  assert.equal(paintBandLine(markBandLine(path(d), 1)).length, 2);
});
