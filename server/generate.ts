/**
 * The generation pipeline: build a prompt, stream a structured response from
 * Claude, decode the compact row-string form back into layer data, then repair
 * and validate it against the layers it depends on.
 */

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';

import {
  decodeBase,
  decodeClimate,
  decodeElevation,
  decodePopulation,
  decodeVegetation,
  POLITY_UNCLAIMED,
} from '../shared/codec.js';
import {
  buildRiverFromPath,
  validateCities,
  validateClimate,
  validateElevation,
  validatePolities,
  validatePopulation,
  validateRivers,
  validateVegetation,
} from '../shared/validate.js';
import type { City, LayerDataMap, LayerId, Polity, River } from '../shared/types.js';
import { buildPrompt, type PromptContext } from './prompts.js';
import {
  BaseResponse,
  CitiesResponse,
  ClimateResponse,
  ElevationResponse,
  PolitiesResponse,
  PopulationResponse,
  RiversResponse,
  VegetationResponse,
} from './schemas.js';
import { mockLayer } from './mock.js';

export const MODEL = process.env.HEXMAP_MODEL ?? 'claude-opus-5';
const MAX_TOKENS = 64000;
const EFFORT = (process.env.HEXMAP_EFFORT ?? 'high') as
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max';

export interface GenerateResult<K extends LayerId = LayerId> {
  layer: K;
  data: LayerDataMap[K];
  warnings: string[];
  notes: string | null;
  usage: { input: number; output: number; cacheRead: number } | null;
}

export type ProgressFn = (event: { phase: string; detail?: string; chars?: number }) => void;

const SCHEMAS = {
  base: BaseResponse,
  elevation: ElevationResponse,
  climate: ClimateResponse,
  vegetation: VegetationResponse,
  rivers: RiversResponse,
  cities: CitiesResponse,
  polities: PolitiesResponse,
  population: PopulationResponse,
} as const;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!client) client = new Anthropic();
  return client;
}

export function isMockMode(): boolean {
  return process.env.HEXMAP_MOCK === '1';
}

export function hasCredentials(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

/** One structured, streamed call to the Messages API. */
async function callModel<S extends z.ZodType>(
  schema: S,
  system: string,
  user: string,
  onProgress: ProgressFn,
): Promise<{ parsed: z.infer<S>; usage: GenerateResult['usage'] }> {
  const stream = getClient().messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    output_config: {
      effort: EFFORT,
      format: zodOutputFormat(schema),
    },
  });

  let chars = 0;
  let lastPing = 0;
  let thinking = false;
  stream.on('streamEvent', (event) => {
    if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
      thinking = true;
      onProgress({ phase: 'thinking' });
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      if (thinking) {
        thinking = false;
        onProgress({ phase: 'writing' });
      }
      chars += event.delta.text.length;
      const now = Date.now();
      if (now - lastPing > 400) {
        lastPing = now;
        onProgress({ phase: 'writing', chars });
      }
    }
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    throw new Error(
      `The model declined this request${message.stop_details && 'category' in message.stop_details ? ` (${message.stop_details.category})` : ''}. Try rewording the description.`,
    );
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error(
      'The response hit the output token limit before it finished. Try a smaller grid, or split the instruction into smaller steps.',
    );
  }

  const usage = {
    input: message.usage.input_tokens,
    output: message.usage.output_tokens,
    cacheRead: message.usage.cache_read_input_tokens ?? 0,
  };

  const parsed = (message as { parsed_output?: unknown }).parsed_output;
  if (parsed != null) return { parsed: parsed as z.infer<S>, usage };

  // The API constrains the output to the schema, so this is a belt-and-braces
  // path for a response that arrived as plain text anyway.
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '');
  if (!text) throw new Error('The model returned an empty response.');
  return { parsed: schema.parse(JSON.parse(text)) as z.infer<S>, usage };
}

/* --------------------------------------------------------- id reuse helpers */

function stableId(prefix: string, name: string, index: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  return `${prefix}_${slug || 'x'}_${index}`;
}

function reuseIdByName<T extends { id: string; name: string }>(
  existing: T[] | undefined,
  name: string,
): string | null {
  if (!existing) return null;
  const match = existing.find((e) => e.name.trim().toLowerCase() === name.trim().toLowerCase());
  return match ? match.id : null;
}

const FALLBACK_COLOURS = [
  '#b5533c', '#3f7a8c', '#7a6cae', '#5c8a4a', '#c08a2e',
  '#8c4f6d', '#4a6f9c', '#9c7b4a', '#5e8f7e', '#a2493f',
  '#6d7f3c', '#8a5ba8',
];

function normaliseColour(input: string | undefined, index: number): string {
  const value = (input ?? '').trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    const [r, g, b] = value.slice(1).split('');
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return FALLBACK_COLOURS[index % FALLBACK_COLOURS.length]!;
}

/* ------------------------------------------------------------ the pipeline */

export interface GenerateRequest {
  layer: LayerId;
  ctx: PromptContext;
  /** Existing feature lists, so ids survive a regeneration where names match. */
  existing?: {
    rivers?: River[];
    cities?: City[];
    polities?: Polity[];
  };
}

export async function generateLayer(
  req: GenerateRequest,
  onProgress: ProgressFn,
): Promise<GenerateResult> {
  const { layer, ctx } = req;
  const { cols, rows } = ctx;

  let parsed: unknown;
  let usage: GenerateResult['usage'] = null;

  if (isMockMode()) {
    onProgress({ phase: 'writing', detail: 'mock generator' });
    parsed = mockLayer(layer, ctx);
  } else {
    onProgress({ phase: 'prompting' });
    const { system, user } = buildPrompt(layer, ctx);
    const result = await callModel(SCHEMAS[layer], system, user, onProgress);
    parsed = result.parsed;
    usage = result.usage;
  }

  onProgress({ phase: 'validating' });
  const warnings: string[] = [];
  let data: LayerDataMap[LayerId];
  let notes: string | null = null;

  switch (layer) {
    case 'base': {
      const r = parsed as z.infer<typeof BaseResponse>;
      notes = r.notes;
      const decoded = decodeBase(r.rows, cols, rows);
      warnings.push(...decoded.warnings);
      data = decoded.data;
      break;
    }
    case 'elevation': {
      const r = parsed as z.infer<typeof ElevationResponse>;
      notes = r.notes;
      const decoded = decodeElevation(r.rows, cols, rows);
      const checked = validateElevation(decoded.data, ctx.base!, cols, rows);
      warnings.push(...decoded.warnings, ...checked.warnings);
      data = checked.data;
      break;
    }
    case 'climate': {
      const r = parsed as z.infer<typeof ClimateResponse>;
      notes = [r.latitudeBand ? `Latitude band: ${r.latitudeBand}.` : '', r.notes]
        .filter(Boolean)
        .join(' ');
      const decoded = decodeClimate(r.rows, cols, rows);
      const checked = validateClimate(decoded.data, ctx.base!, ctx.elevation, cols, rows);
      warnings.push(...decoded.warnings, ...checked.warnings);
      data = checked.data;
      break;
    }
    case 'vegetation': {
      const r = parsed as z.infer<typeof VegetationResponse>;
      notes = r.notes;
      const decoded = decodeVegetation(r.rows, cols, rows);
      const checked = validateVegetation(
        decoded.data,
        ctx.base!,
        ctx.climate,
        ctx.elevation,
        ctx.rivers?.rivers ?? null,
        cols,
        rows,
      );
      warnings.push(...decoded.warnings, ...checked.warnings);
      data = checked.data;
      break;
    }
    case 'rivers': {
      const r = parsed as z.infer<typeof RiversResponse>;
      notes = r.notes;
      const built: River[] = [];
      r.rivers.forEach((input, i) => {
        const id = reuseIdByName(req.existing?.rivers, input.name) ?? stableId('riv', input.name, i);
        const river = buildRiverFromPath(
          { name: input.name, path: input.path, navigable: input.navigable },
          id,
          ctx.base!,
          ctx.elevation,
          cols,
          rows,
          warnings,
        );
        if (river) built.push(river);
      });
      const checked = validateRivers(built, ctx.base!, cols, rows);
      warnings.push(...checked.warnings);
      data = { rivers: checked.data };
      break;
    }
    case 'cities': {
      const r = parsed as z.infer<typeof CitiesResponse>;
      notes = r.notes;
      const cities: City[] = r.cities.map((c, i) => ({
        id: reuseIdByName(req.existing?.cities, c.name) ?? stableId('city', c.name, i),
        col: c.col,
        row: c.row,
        name: c.name,
        population: c.population,
        onRiver: false,
        riverId: null,
        coastal: false,
        coastalEdges: [],
      }));
      const checked = validateCities(cities, ctx.base!, ctx.rivers?.rivers ?? null, cols, rows);
      warnings.push(...checked.warnings);
      data = { cities: checked.data };
      break;
    }
    case 'polities': {
      const r = parsed as z.infer<typeof PolitiesResponse>;
      notes = r.notes;
      const byKey = new Map<string, Polity>();
      const polities: Polity[] = r.polities.map((p, i) => {
        const polity: Polity = {
          id: reuseIdByName(req.existing?.polities, p.name) ?? stableId('pol', p.name, i),
          name: p.name,
          colour: normaliseColour(p.colour, i),
        };
        const key = (p.key ?? '').trim().charAt(0);
        if (key && key !== POLITY_UNCLAIMED) byKey.set(key, polity);
        return polity;
      });
      const owner: (string | null)[] = new Array(cols * rows).fill(null);
      let unknownKeys = 0;
      for (let row = 0; row < rows; row++) {
        const line = (r.rows[row] ?? '').replace(/\s+/g, '');
        for (let col = 0; col < cols; col++) {
          const ch = line[col];
          if (!ch || ch === POLITY_UNCLAIMED) continue;
          const polity = byKey.get(ch);
          if (polity) owner[row * cols + col] = polity.id;
          else unknownKeys++;
        }
      }
      if (r.rows.length !== rows) {
        warnings.push(`Expected ${rows} polity rows, model returned ${r.rows.length}.`);
      }
      if (unknownKeys > 0) {
        warnings.push(`${unknownKeys} hexes used an undeclared polity key and were left unclaimed.`);
      }
      const checked = validatePolities(polities, owner, ctx.base!, cols, rows);
      warnings.push(...checked.warnings);
      data = checked.data;
      break;
    }
    case 'population': {
      const r = parsed as z.infer<typeof PopulationResponse>;
      notes = r.notes;
      const decoded = decodePopulation(r.rows, cols, rows);
      const checked = validatePopulation(decoded.data, ctx.base!, cols, rows);
      warnings.push(...decoded.warnings, ...checked.warnings);
      data = checked.data;
      break;
    }
    default: {
      const exhaustive: never = layer;
      throw new Error(`Unknown layer ${String(exhaustive)}`);
    }
  }

  return { layer, data, warnings, notes: notes || null, usage };
}
