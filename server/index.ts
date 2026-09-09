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

import { MAX_DIM, MIN_DIM, LAYER_ORDER, type LayerId } from '../shared/types.js';
import { LAYER_META } from '../shared/layers.js';
import {
  generateLayer,
  hasCredentials,
  isMockMode,
  MODEL,
  type GenerateRequest,
} from './generate.js';
import type { PromptContext } from './prompts.js';

const app = express();
const PORT = Number(process.env.PORT ?? 8787);

app.use(cors({ origin: true }));
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

interface GenerateBody {
  layer?: string;
  description?: string;
  cols?: number;
  rows?: number;
  instruction?: string | null;
  layers?: Partial<Record<LayerId, unknown>>;
}

function validateBody(body: GenerateBody): { error: string } | { req: GenerateRequest } {
  const layer = body.layer as LayerId | undefined;
  if (!layer || !LAYER_ORDER.includes(layer)) {
    return { error: `Unknown layer "${String(body.layer)}".` };
  }
  const cols = Number(body.cols);
  const rows = Number(body.rows);
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
    return { error: 'cols and rows must be integers.' };
  }
  if (cols < MIN_DIM || rows < MIN_DIM || cols > MAX_DIM || rows > MAX_DIM) {
    return { error: `Grid must be between ${MIN_DIM}x${MIN_DIM} and ${MAX_DIM}x${MAX_DIM}.` };
  }

  const supplied = (body.layers ?? {}) as Record<string, unknown>;
  const ctx: PromptContext = {
    description: String(body.description ?? ''),
    cols,
    rows,
    base: (supplied.base as PromptContext['base']) ?? null,
    elevation: (supplied.elevation as PromptContext['elevation']) ?? null,
    climate: (supplied.climate as PromptContext['climate']) ?? null,
    vegetation: (supplied.vegetation as PromptContext['vegetation']) ?? null,
    rivers: (supplied.rivers as PromptContext['rivers']) ?? null,
    cities: (supplied.cities as PromptContext['cities']) ?? null,
    polities: (supplied.polities as PromptContext['polities']) ?? null,
    population: (supplied.population as PromptContext['population']) ?? null,
    instruction: body.instruction ?? null,
  };

  for (const dep of LAYER_META[layer].requires) {
    if (!ctx[dep as keyof PromptContext]) {
      return { error: `Layer "${layer}" requires the ${LAYER_META[dep].label} layer, which was not supplied.` };
    }
  }
  if (ctx.base && ctx.base.length !== cols * rows) {
    return { error: `Base geography has ${ctx.base.length} hexes but the grid is ${cols * rows}.` };
  }

  return {
    req: {
      layer,
      ctx,
      existing: {
        rivers: ctx.rivers?.rivers,
        cities: ctx.cities?.cities,
        polities: ctx.polities?.polities,
      },
    },
  };
}

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
  const checked = validateBody(req.body as GenerateBody);
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

  // Listen on the RESPONSE, not the request: `req`'s 'close' fires as soon as the
  // request body has been read, which is immediately, and would suppress every result.
  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  const started = Date.now();
  send('progress', { phase: 'starting', layer: checked.req.layer, model: isMockMode() ? 'mock' : MODEL });

  try {
    const result = await generateLayer(checked.req, (event) => {
      if (!closed) send('progress', event);
    });
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
