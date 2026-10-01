import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRegularHex,
  measuresFromWidth,
  politySurfaceAreas,
  regularHexSize,
  type HexMeasure,
} from '../shared/surfaceArea.ts';
import { DEFAULT_HEX_DIMENSIONS } from '../shared/types.ts';

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} !~ ${b}`);

test('every single measurement round-trips to the same regular hex', () => {
  const reference = measuresFromWidth(10);
  for (const measure of ['width', 'corners', 'side', 'area'] as HexMeasure[]) {
    const size = regularHexSize(measure, reference[measure === 'corners' ? 'corners' : measure]);
    close(size.width, 10);
    close(size.height, reference.corners);
  }
});

test('regular hex area agrees with the polity area formula', () => {
  const size = regularHexSize('width', 10);
  const areas = politySurfaceAreas(
    ['Land'],
    { polities: [{ id: 'a', name: 'A', colour: '#111111' }], owner: ['a'] },
    { ...DEFAULT_HEX_DIMENSIONS, ...size },
  );
  close(areas.get('a')!, measuresFromWidth(10).area);
});

test('default hex dimensions are regular; an old 10 x 8.66 hex is flagged irregular', () => {
  assert.ok(isRegularHex(DEFAULT_HEX_DIMENSIONS));
  assert.ok(!isRegularHex({ width: 10, height: 8.66 }));
});
