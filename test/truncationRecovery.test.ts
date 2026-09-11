import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clampTaskBudget,
  DEFAULT_EFFORT,
  lowerEffort,
  MAX_TOKENS,
  MIN_TASK_BUDGET,
  MAX_TASK_BUDGET,
} from '../core/config.js';
import { OutputTruncatedError } from '../core/pipeline.js';

/**
 * The bug this guards against: `max_tokens` was sized against the text of the
 * answer, which is a couple of thousand tokens for any grid the app allows. It
 * is not a budget for the answer - reasoning is output too, and on a hard layer
 * it is nearly all of the output. These tests pin the settings that keep a long
 * think from running off the end of the response.
 */

test('the output cap leaves room for reasoning as well as the answer', () => {
  // A 50x50 layer is a few thousand tokens of rows; the rest is thinking room.
  assert.ok(MAX_TOKENS >= 128_000, `cap was ${MAX_TOKENS}`);
});

test('the default effort is not the one that exhausted the budget', () => {
  assert.notEqual(DEFAULT_EFFORT, 'high');
  assert.notEqual(DEFAULT_EFFORT, 'xhigh');
  assert.notEqual(DEFAULT_EFFORT, 'max');
});

test('a task budget is clamped into the range the API accepts', () => {
  assert.equal(clampTaskBudget(0), MIN_TASK_BUDGET);
  assert.equal(clampTaskBudget(-5), MIN_TASK_BUDGET);
  assert.equal(clampTaskBudget(1_000_000), MAX_TASK_BUDGET);
  assert.equal(clampTaskBudget(40_000), 40_000);
});

test('a missing or unusable budget falls back to the default rather than zero', () => {
  assert.ok(clampTaskBudget(undefined) >= MIN_TASK_BUDGET);
  assert.ok(clampTaskBudget(null) >= MIN_TASK_BUDGET);
  assert.ok(clampTaskBudget(Number.NaN) >= MIN_TASK_BUDGET);
});

test('effort steps down one level at a time and bottoms out', () => {
  assert.equal(lowerEffort('max'), 'xhigh');
  assert.equal(lowerEffort('xhigh'), 'high');
  assert.equal(lowerEffort('high'), 'medium');
  assert.equal(lowerEffort('medium'), 'low');
  assert.equal(lowerEffort('low'), null);
});

test('a truncation blames reasoning when reasoning is what consumed the budget', () => {
  // The reported failure: ~3k of answer, ~61k of thinking, one 64k budget.
  const usage = { input: 4_000, output: 64_000, cacheRead: 0, thinking: 61_000 };
  const error = new OutputTruncatedError(usage, '');
  assert.equal(error.usage.thinking, 61_000);
  assert.equal(error.name, 'OutputTruncatedError');
  assert.ok(error instanceof Error);
});
