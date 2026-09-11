/**
 * Optional Cloudflare Worker: the same /api contract as the local Express
 * server, for when the deployed page should work for people who do not have
 * their own Anthropic key.
 *
 * This is the arrangement to use if you want to share the site. The key lives
 * as a Worker secret, is read only here, and never reaches the browser. The
 * static build on GitHub Pages is pointed at this origin with the VITE_API_BASE
 * repository variable and then behaves exactly as it does in local development.
 *
 * A worker with no access control is an open relay to your Anthropic account
 * for anyone who learns its URL. ALLOWED_ORIGINS keeps casual browser traffic
 * out; it is not authentication, and a spend limit on the key is the backstop
 * that actually bounds the damage. See worker/README.md.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  generateLayer,
  type Effort,
} from '../core/pipeline.js';
import { validateGenerateBody, type GenerateBody } from '../core/request.js';

export interface Env {
  ANTHROPIC_API_KEY: string;
  /** Comma-separated list of origins allowed to call this worker. */
  ALLOWED_ORIGINS?: string;
  HEXMAP_MODEL?: string;
  HEXMAP_EFFORT?: string;
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ok = allowed.length === 0 || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin || '*' : 'null',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body: unknown, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const cors = corsHeaders(request, env);
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const model = env.HEXMAP_MODEL ?? DEFAULT_MODEL;
    const effort = (env.HEXMAP_EFFORT ?? DEFAULT_EFFORT) as Effort;

    if (url.pathname === '/api/health') {
      return json({ ok: true, model, mock: false, credentials: Boolean(env.ANTHROPIC_API_KEY) }, 200, cors);
    }

    if (url.pathname !== '/api/generate' || request.method !== 'POST') {
      return json({ error: 'Not found' }, 404, cors);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: 'This worker has no ANTHROPIC_API_KEY secret set.' }, 503, cors);
    }

    let body: GenerateBody;
    try {
      body = (await request.json()) as GenerateBody;
    } catch {
      return json({ error: 'Request body was not valid JSON.' }, 400, cors);
    }

    const checked = validateGenerateBody(body);
    if ('error' in checked) return json({ error: checked.error }, 400, cors);

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: string, data: unknown) => {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const started = Date.now();
        // Extended thinking may produce no user-visible model text for long
        // enough that a browser or intermediary closes an apparently idle SSE
        // response. Comments keep the byte stream active without becoming UI
        // events.
        const heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        }, 15_000);
        send('progress', { phase: 'starting', layer: checked.req.layer, model });
        try {
          const config = {
            client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
            model,
            effort,
          };
          const result = await generateLayer(config, checked.req, (event) => send('progress', event), request.signal);
          send('result', { ...result, elapsedMs: Date.now() - started });
        } catch (err) {
          send('error', { error: err instanceof Error ? err.message : String(err) });
        } finally {
          clearInterval(heartbeat);
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        ...cors,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
      },
    });
  },
};
