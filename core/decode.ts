/**
 * Decoding a model response into layer data, then repairing and validating it.
 *
 * This is the second half of the generation pipeline, split out from the call to
 * the API because it is a pure function of (layer, parsed response, context) and
 * touches no network. Three things need it and only one of them makes a request:
 *
 *  - `generateLayer`, on the response it just streamed;
 *  - the offline generator, on a procedurally produced response;
 *  - the webchat import, on JSON the user pasted in from somewhere else.
 *
 * Keeping it here rather than inside `pipeline.ts` also keeps it free of the
 * Anthropic SDK, so the browser can validate a pasted layer without downloading
 * a client it is never going to call. Server and proxy deployments continue to
 * ship no SDK at all.
 */

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
import type {
  City,
  Decision,
  LayerDataMap,
  LayerId,
  Polity,
  River,
} from '../shared/types.js';
import type { PromptContext } from './prompts.js';
import type {
  BaseResponse,
  CitiesResponse,
  ClimateResponse,
  ElevationResponse,
  PolitiesResponse,
  PopulationResponse,
  RiversResponse,
  VegetationResponse,
} from './schemas.js';

/** Existing feature lists, so ids survive a regeneration where names match. */
export interface ExistingFeatures {
  rivers?: River[];
  cities?: City[];
  polities?: Polity[];
}

export interface DecodedLayer<K extends LayerId = LayerId> {
  data: LayerDataMap[K];
  warnings: string[];
  notes: string | null;
  decisions: Decision[];
}

/* ----------------------------------------------------------- loose JSON in */

/**
 * Find the first complete JSON object in a block of text.
 *
 * The API path barely needs this - structured outputs constrain the response to
 * the schema - but the webchat path has no such guarantee. A chat model will
 * happily wrap the answer in a fenced block, introduce it with a sentence, or
 * follow it with an offer to explain itself. Scanning for a balanced object
 * handles all three, and string-awareness keeps a brace inside a name (or an
 * escaped quote) from ending the scan early.
 *
 * Returns null when there is no object at all, which the caller reports as an
 * empty response rather than a parse failure.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/* --------------------------------------------------------- id reuse helpers */

export function stableId(prefix: string, name: string, index: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  return `${prefix}_${slug || 'x'}_${index}`;
}

export function reuseIdByName<T extends { id: string; name: string }>(
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

export function normaliseColour(input: string | undefined, index: number): string {
  const value = (input ?? '').trim();
  if (/^#[0-9a-f]{6}$/i.test(value)) return value.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(value)) {
    const [r, g, b] = value.slice(1).split('');
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return FALLBACK_COLOURS[index % FALLBACK_COLOURS.length]!;
}

/* ------------------------------------------------------------------ decode */

/**
 * Turn a complete layer response into layer data. Two-pass generations combine
 * their roster and geometry into this same shape first (see `core/passes.ts`),
 * so there is one decode implementation regardless of how the response was
 * produced or how many requests it took.
 */
export function decodeLayer(
  layer: LayerId,
  parsed: unknown,
  ctx: PromptContext,
  existing?: ExistingFeatures,
): DecodedLayer {
  const { cols, rows } = ctx;
  const warnings: string[] = [];
  let data: LayerDataMap[LayerId];
  let notes: string | null = null;

  switch (layer) {
    case 'base': {
      const r = parsed as BaseResponse;
      notes = r.notes;
      const decoded = decodeBase(r.rows, cols, rows);
      warnings.push(...decoded.warnings);
      data = decoded.data;
      break;
    }
    case 'elevation': {
      const r = parsed as ElevationResponse;
      notes = r.notes;
      const decoded = decodeElevation(r.rows, cols, rows);
      const checked = validateElevation(decoded.data, ctx.base!, cols, rows);
      warnings.push(...decoded.warnings, ...checked.warnings);
      data = checked.data;
      break;
    }
    case 'climate': {
      const r = parsed as ClimateResponse;
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
      const r = parsed as VegetationResponse;
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
      const r = parsed as RiversResponse;
      notes = r.notes;
      const built: River[] = [];
      r.rivers.forEach((input, i) => {
        const id = reuseIdByName(existing?.rivers, input.name) ?? stableId('riv', input.name, i);
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
      const r = parsed as CitiesResponse;
      notes = r.notes;
      const cities: City[] = r.cities.map((c, i) => ({
        id: reuseIdByName(existing?.cities, c.name) ?? stableId('city', c.name, i),
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
      const r = parsed as PolitiesResponse;
      notes = r.notes;
      const byKey = new Map<string, Polity>();
      const polities: Polity[] = r.polities.map((p, i) => {
        const polity: Polity = {
          id: reuseIdByName(existing?.polities, p.name) ?? stableId('pol', p.name, i),
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
      const r = parsed as PopulationResponse;
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

  // Every response schema carries `decisions`, so it is lifted once here rather
  // than repeated in all eight branches above.
  const decisions = normaliseDecisions((parsed as { decisions?: unknown }).decisions);

  return { data, warnings, notes: notes || null, decisions };
}

/** Trust the schema for shape, but not for emptiness or stray whitespace. */
export function normaliseDecisions(raw: unknown): Decision[] {
  if (!Array.isArray(raw)) return [];
  const out: Decision[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { title, detail, hexes } = item as Partial<Decision>;
    const cleanTitle = typeof title === 'string' ? title.trim() : '';
    const cleanDetail = typeof detail === 'string' ? detail.trim() : '';
    if (!cleanTitle && !cleanDetail) continue;
    const cleanHexes = Array.isArray(hexes)
      ? hexes.filter((h): h is string => typeof h === 'string' && /^\d+,\d+$/.test(h.trim())).map((h) => h.trim())
      : [];
    out.push({
      title: cleanTitle || 'Untitled decision',
      detail: cleanDetail,
      ...(cleanHexes.length > 0 ? { hexes: cleanHexes } : {}),
    });
  }
  return out;
}
