import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateCost } from '../core/models.ts';
import { describeUsage, formatDuration } from '../src/api/usageText.ts';

test('durations read as seconds, then minutes and seconds', () => {
  assert.equal(formatDuration(4_200), '4s');
  assert.equal(formatDuration(65_000), '1m 05s');
});

test('cost is estimated from list prices, with cache reads at a tenth', () => {
  const usage = { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, thinking: 80_000 };
  // Opus 5.5: $4 in, $20 out per million.
  assert.ok(Math.abs(estimateCost('claude-opus-5-5', usage)! - (4 + 0.4 + 2)) < 1e-9);
  assert.equal(estimateCost('claude-unknown', usage), null);
  assert.equal(estimateCost(null, usage), null);
});

test('a usage line names time, tokens, reasoning and cost', () => {
  const line = describeUsage('claude-sonnet-5-5', { input: 20_000, output: 30_000, cacheRead: 0, thinking: 25_000 }, 95_000);
  assert.equal(line, '1m 35s · 30,000 tokens out (25,000 reasoning), 20,000 in · about $0.34');
  assert.equal(describeUsage(null, null, 3_000), '3s');
});
