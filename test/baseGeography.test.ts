import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeBase, encodeBase } from '../shared/codec.js';
import { isLandLike } from '../shared/derive.js';
import type { BaseGeo } from '../shared/types.js';

test('Coastal Land round-trips through the base-grid codec as land-like terrain', () => {
  const base: BaseGeo[] = ['Land', 'Coastal Land', 'Sea', 'Lake', 'Ice', 'Islands', 'Mainland and islands', 'Isthmus', 'Strait'];

  const encoded = encodeBase(base, 9, 1);
  const decoded = decodeBase(encoded, 9, 1);

  assert.deepEqual(encoded, ['tcmlgikns']);
  assert.deepEqual(decoded, { data: base, warnings: [] });
  assert.equal(isLandLike(decoded.data[1]), true);
});
