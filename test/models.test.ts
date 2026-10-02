import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MODEL, TASK_BUDGET_BETA } from '../core/config.ts';
import {
  MODELS,
  effortFor,
  lowerEffortFor,
  modelInfo,
  requestShape,
} from '../core/models.ts';

test('the default model is in the list the settings offer', () => {
  assert.ok(MODELS.some((m) => m.id === DEFAULT_MODEL));
  assert.equal(new Set(MODELS.map((m) => m.id)).size, MODELS.length);
});

test('an adaptive model with a task budget gets effort, thinking and the budget', () => {
  const shape = requestShape('claude-opus-5-5', 'high', 96000);
  assert.deepEqual(shape, {
    max_tokens: 128000,
    betas: [TASK_BUDGET_BETA],
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', task_budget: { type: 'tokens', total: 96000 } },
  });
});

test('Opus 4.8 is asked to think, since it does not unless asked', () => {
  assert.deepEqual(requestShape('claude-opus-4-8', 'high', 96000).thinking, { type: 'adaptive' });
});

test('a model without task budgets is sent neither the budget nor its beta', () => {
  for (const id of ['claude-sonnet-5', 'claude-sonnet-4-6']) {
    const shape = requestShape(id, 'high', 96000);
    assert.equal(shape.betas, undefined, id);
    assert.equal(shape.output_config.task_budget, undefined, id);
    assert.equal(shape.output_config.effort, 'high', id);
  }
});

test('Haiku gets a fixed thinking budget under its own output cap, and no effort', () => {
  const shape = requestShape('claude-haiku-4-5', 'high', 96000);
  assert.equal(shape.max_tokens, 64000);
  assert.equal(shape.output_config.effort, undefined);
  assert.equal(shape.output_config.task_budget, undefined);
  assert.equal(shape.betas, undefined);
  assert.equal(shape.thinking?.type, 'enabled');
  const budget = shape.thinking?.type === 'enabled' ? shape.thinking.budget_tokens : 0;
  assert.ok(budget >= 1024 && budget < shape.max_tokens, `budget ${budget}`);
  const halved = requestShape('claude-haiku-4-5', 'high', budget / 2).thinking;
  assert.equal(halved?.type === 'enabled' ? halved.budget_tokens : 0, budget / 2);
});

test('an effort a model does not accept is stepped down to one it does', () => {
  const sonnet46 = modelInfo('claude-sonnet-4-6');
  assert.equal(effortFor(sonnet46, 'xhigh'), 'high');
  assert.equal(effortFor(sonnet46, 'max'), 'max');
  assert.equal(lowerEffortFor(sonnet46, 'max'), 'high');
  assert.equal(lowerEffortFor(sonnet46, 'low'), null);
  assert.equal(effortFor(modelInfo('claude-haiku-4-5'), 'high'), null);
  assert.equal(requestShape('claude-sonnet-4-6', 'xhigh', 96000).output_config.effort, 'high');
});

test('a model the table does not know is sent the request the app always sent', () => {
  const shape = requestShape('claude-something-new', 'medium', 50000);
  assert.equal(shape.thinking, undefined);
  assert.deepEqual(shape.betas, [TASK_BUDGET_BETA]);
  assert.deepEqual(shape.output_config, { effort: 'medium', task_budget: { type: 'tokens', total: 50000 } });
});

test('the task budget can be dropped for the retry after a model refuses it', () => {
  const shape = requestShape('claude-fable-5-1', 'high', 96000, false);
  assert.equal(shape.betas, undefined);
  assert.equal(shape.output_config.task_budget, undefined);
  assert.equal(shape.output_config.effort, 'high');
});
