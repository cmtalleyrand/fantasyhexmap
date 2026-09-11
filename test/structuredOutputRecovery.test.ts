import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isStructuredOutputParseError,
  withStructuredOutputRetry,
} from '../core/pipeline.js';

test('malformed structured JSON is retried once and can recover', async () => {
  let attempts = 0;
  let retries = 0;
  const result = await withStructuredOutputRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error(
          "Failed to parse structured output as JSON: Expected ',' or ']' after array element in JSON at position 2136",
        );
      }
      return { valid: true };
    },
    () => {
      retries += 1;
    },
  );

  assert.deepEqual(result, { valid: true });
  assert.equal(attempts, 2);
  assert.equal(retries, 1);
});

test('unrelated failures are not retried', async () => {
  let attempts = 0;
  await assert.rejects(
    withStructuredOutputRetry(
      async () => {
        attempts += 1;
        throw new Error('Authentication failed');
      },
      () => assert.fail('retry callback should not run'),
    ),
    /Authentication failed/,
  );
  assert.equal(attempts, 1);
  assert.equal(isStructuredOutputParseError(new Error('Authentication failed')), false);
});

test('a second malformed response becomes an actionable error', async () => {
  let attempts = 0;
  await assert.rejects(
    withStructuredOutputRetry(
      async () => {
        attempts += 1;
        JSON.parse('[1 2]');
      },
      () => undefined,
    ),
    /malformed data twice.*try generating this layer again/i,
  );
  assert.equal(attempts, 2);
});
