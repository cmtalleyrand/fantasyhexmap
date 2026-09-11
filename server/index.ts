/**
 * Local Express server.
 *
 * It holds the Anthropic API key (from .env) and is the only thing that talks to
 * api.anthropic.com; the browser never sees the key. Generation is delivered
 * over SSE so a long run streams progress instead of sitting on an open request
 * until something times out.
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

import { LAYER_ORDER } from '../shared/types.js';
import { LAYER_META } from '../shared/layers.js';
import { validateGenerateBody, type GenerateBody } from '../core/request.js';
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  generateLayer,
  type Effort,
  type GenerationConfig,
} from '../core/pipeline.js';

const MODEL = process.env.HEXMAP_MODEL ?? DEFAULT_MODEL;
const EFFORT = (process.env.HEXMAP_EFFORT ?? DEFAULT_EFFORT) as Effort;

const isMockMode = () => process.env.HEXMAP_MOCK === '1';
const hasCredentials = () =>
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let anthropic: Anthropic | null = null;
/**
 * The credential is read here and nowhere else. It never enters a response
 * body, never reaches the pipeline as anything but a configured client, and
 * never leaves this process.
 */
function generationConfig(): GenerationConfig {
  if (isMockMode()) return { client: null, model: MODEL, effort: EFFORT };
  if (!anthropic) anthropic = new Anthropic();
  return { client: anthropic, model: MODEL, effort: EFFORT };
}

const app = express();
const PORT = Number(process.env.PORT ?? 8787);

// A browser on another origin (a GitHub Pages build pointed at this server via
// VITE_API_BASE) has to be able to reach it. HEXMAP_ALLOWED_ORIGINS narrows that
// to a list when the server is not just a local dev convenience.
const allowedOrigins = (process.env.HEXMAP_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(cors({ origin: allowedOrigins.length > 0 ? allowedOrigins : true }));
app.use(express.json({ limit: '32mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    model: MODEL,
    mock: isMockMode(),
    credentials: hasCredentials(),
    layers: LAYER_ORDER.map((id) => LAYER_META[id]),
  });
});

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'The Anthropic API rejected the credentials. Check ANTHROPIC_API_KEY in your .env file.';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Rate limited by the Anthropic API. Wait a moment and try again.';
  }
  if (err instanceof Anthropic.BadRequestError) {
    return `The API rejected the request: ${err.message}`;
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Could not reach api.anthropic.com. Check your network connection.';
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API error ${err.status}: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * SSE endpoint. Events: `progress`, then exactly one of `result` or `error`.
 * POST rather than GET because the request carries the whole map state.
 */
app.post('/api/generate', async (req, res) => {
  const checked = validateGenerateBody(req.body as GenerateBody);
  if ('error' in checked) {
    res.status(400).json({ error: checked.error });
    return;
  }
  if (!isMockMode() && !hasCredentials()) {
    res.status(503).json({
      error:
        'No Anthropic credentials configured. Copy .env.example to .env and set ANTHROPIC_API_KEY, or run with HEXMAP_MOCK=1 to use the offline procedural generator.',
    });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // High-effort generations can spend minutes thinking without emitting text.
  // Keep every intermediary's idle timer from mistaking that silence for a
  // dead connection. SSE comment frames carry no application-level event.
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15_000);

  // Listen on the RESPONSE, not the request: `req`'s 'close' fires as soon as the
  // request body has been read, which is immediately, and would suppress every result.
  let closed = false;
  const controller = new AbortController();
  res.on('close', () => {
    clearInterval(heartbeat);
    closed = true;
    controller.abort();
  });

  const started = Date.now();
  send('progress', { phase: 'starting', layer: checked.req.layer, model: isMockMode() ? 'mock' : MODEL });

  try {
    const result = await generateLayer(generationConfig(), checked.req, (event) => {
      if (!closed) send('progress', event);
    }, controller.signal);
    if (!closed) {
      send('result', { ...result, elapsedMs: Date.now() - started });
      res.end();
    }
  } catch (err) {
    console.error(`[generate:${checked.req.layer}]`, err);
    if (!closed) {
      send('error', { error: describeError(err) });
      res.end();
    }
  } finally {
    clearInterval(heartbeat);
  }
});

app.listen(PORT, () => {
  const mode = isMockMode()
    ? 'MOCK (offline procedural generator)'
    : hasCredentials()
      ? `Anthropic API, model ${MODEL}`
      : 'NO CREDENTIALS - set ANTHROPIC_API_KEY in .env, or HEXMAP_MOCK=1';
  console.log(`fantasyhexmap server listening on http://localhost:${PORT}`);
  console.log(`  generation mode: ${mode}`);
});
