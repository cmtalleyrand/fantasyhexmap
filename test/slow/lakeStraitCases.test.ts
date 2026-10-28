import test from 'node:test';
import { LAKE_STRAIT_CASES, FAST_LAKE_STRAIT_CASES } from '../fixtures/lakeStrait.ts';
import { assertLakeStraitCase } from '../helpers/lakeStrait.ts';

// The cases the fast tier leaves out (test/lakeStraitRendering.test.ts runs the rest).
for (const [index, example] of LAKE_STRAIT_CASES.entries()) {
  if (FAST_LAKE_STRAIT_CASES.has(index)) continue;
  test(`representative lake strait ${index + 1}: ${example.width}, side=${example.side ?? 'middle'}, land=${example.land ?? 'natural'}, ${example.irregular}`, () => {
    assertLakeStraitCase(example);
  });
}
