import assert from 'node:assert/strict';
import test from 'node:test';
import { createMapState } from '../shared/layers.ts';
import { detectTransport, generateLayer } from '../src/api/client.ts';

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

test('an interrupted generation stream reports the actionable transport failure', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('event: progress\ndata: {"phase":"thinking"}\n\n'));
      controller.error(new TypeError('network error'));
    },
  }), { headers: { 'content-type': 'text/event-stream' } });

  const map = createMapState('test map', 8, 8, 'Test');
  map.layers.base.data = new Array(64).fill('Land');

  await assert.rejects(
    generateLayer(
      map,
      'polities',
      null,
      'server',
      { apiKey: null, model: 'test-model', effort: 'high', offline: false },
      () => undefined,
    ),
    /connection to the generation server was interrupted.*long-lived streaming/i,
  );
});
