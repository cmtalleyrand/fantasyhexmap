import assert from 'node:assert/strict';
import test from 'node:test';
import { detectTransport } from '../src/api/client.ts';

test('a static production deployment does not request a nonexistent health endpoint', async () => {
  let requests = 0;
  const fetchHealth: typeof fetch = async () => {
    requests += 1;
    throw new Error('unexpected network request');
  };

  const transport = await detectTransport(100, fetchHealth, false);

  assert.equal(requests, 0);
  assert.equal(transport.mode, 'browser');
  assert.equal(transport.health, null);
});

test('development still probes its same-origin server', async () => {
  let requestedUrl = '';
  const fetchHealth: typeof fetch = async (input) => {
    requestedUrl = String(input);
    return Response.json({ ok: true, model: 'test-model', mock: true, credentials: false });
  };

  const transport = await detectTransport(100, fetchHealth, true);

  assert.equal(requestedUrl, '/api/health');
  assert.equal(transport.mode, 'server');
  assert.equal(transport.health?.model, 'test-model');
});
