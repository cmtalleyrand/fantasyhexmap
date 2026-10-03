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

import { withValidParents } from '../shared/polityTree.js';
import {
  decodeBase,
  decodeClimate,
  decodeElevation,
  decodePopulation,
  decodeVegetation,
  POLITY_UNCLAIMED,
  stripGridView,
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
import { keyedToRows, type CellKind } from './grid.js';
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
  // A fenced block is the clearest signal of where the answer is, and reading
  // it first keeps a brace in the prose around it - which the compact webchat
  // style asks for - from being mistaken for the start of the object.
  for (const fence of text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/g)) {
    const inside = scanForObject(fence[1] ?? '');
    if (inside) return inside;
  }
  return scanForObject(text);
}

/**
 * The prose of a reply with the JSON taken out - the fenced block that held it,
 * or the object itself. In the compact webchat style this is where the plan and
 * the decisions are, so it is kept rather than discarded.
 */
export function proseAround(text: string, json: string): string {
  const fenced = [...text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n[\s\S]*?```/g)].find((m) => m[0].includes(json));
  const without = fenced ? text.replace(fenced[0], '') : text.replace(json, '');
  return without.replace(/\n{3,}/g, '\n\n').trim();
}

function scanForObject(text: string): string | null {
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

/* ------------------------------------------------------ response shaping */

const GRID_KIND: Partial<Record<LayerId, CellKind>> = {
  base: 'char',
  elevation: 'char',
  polities: 'char',
  climate: 'token',
  vegetation: 'token',
  population: 'token',
};

/** Turn a keyed grid back into the row strings every decoder reads. */
export function flattenGrid(layer: LayerId, parsed: unknown, cols: number, rows: number): unknown {
  const kind = GRID_KIND[layer];
  const response = parsed as { rows?: unknown } | null;
  if (!kind || !response || response.rows == null || Array.isArray(response.rows)) return parsed;
  return { ...response, rows: keyedToRows(response.rows, cols, rows, kind) };
}

/**
 * Carry the model's reading of the brief into the decision record, where the
 * user sees it and it is exported with the map. A requirement the model got
 * wrong is then visible as a stated target the map can be checked against,
 * rather than something that silently did not happen.
 */
export function withBriefRecorded(parsed: unknown): unknown {
  const response = parsed as { brief?: unknown; decisions?: unknown } | null;
  const brief = response?.brief as
    | { scale?: unknown; requirements?: { requirement?: unknown; target?: unknown }[] }
    | undefined;
  if (!response || !brief) return parsed;

  const fromBrief: Decision[] = [];
  const scale = typeof brief.scale === 'string' ? brief.scale.trim() : '';
  if (scale) fromBrief.push({ title: 'Scale', detail: scale });
  for (const item of Array.isArray(brief.requirements) ? brief.requirements : []) {
    const requirement = typeof item?.requirement === 'string' ? item.requirement.trim() : '';
    const target = typeof item?.target === 'string' ? item.target.trim() : '';
    if (requirement) fromBrief.push({ title: `Brief: ${requirement}`, detail: target });
  }
  const existing = Array.isArray(response.decisions) ? response.decisions : [];
  return { ...response, decisions: [...fromBrief, ...existing] };
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
      // A distributary may be unnamed: it has no name to reuse an id by or to be referred to by.
      const ids = r.rivers.map(
        (input, i) =>
          (input.name.trim() ? reuseIdByName(existing?.rivers, input.name) : null) ?? stableId('riv', input.name, i),
      );
      const idByName = new Map(
        r.rivers.flatMap((input, i): [string, string][] => (input.name.trim() ? [[input.name.trim().toLowerCase(), ids[i]!]] : [])),
      );
      const named = (name: string | undefined, of: string, link: string): string | undefined => {
        if (!name?.trim()) return undefined;
        const id = idByName.get(name.trim().toLowerCase());
        if (!id) warnings.push(`River "${of}" ${link} an unknown river "${name}".`);
        return id;
      };
      const build = (others: River[], quiet: boolean): River[] => {
        const out: River[] = [];
        r.rivers.forEach((input, i) => {
          const river = buildRiverFromPath(
            {
              name: input.name,
              path: input.path,
              navigable: input.navigable,
              joins: quiet ? undefined : named(input.joins, input.name, 'joins'),
              allowBlankName: !!input.branchOf?.trim(),
            },
            ids[i]!,
            ctx.base!,
            ctx.elevation,
            cols,
            rows,
            quiet ? [] : warnings,
            others,
          );
          if (!river) return;
          const branchOf = quiet ? undefined : named(input.branchOf, input.name, 'is a branch of');
          out.push(branchOf && branchOf !== river.id ? { ...river, branchOf } : river);
        });
        return out;
      };
      // Tributaries end on their trunk's hexes, so every river's hexes are
      // laid out once before any of them is linked to another.
      const built = build(build([], true), false);
      const checked = validateRivers(built, ctx.base!, cols, rows);
      warnings.push(...checked.warnings);
      data = { rivers: checked.data };
      break;
    }
    case 'cities': {
      const r = parsed as CitiesResponse;
      notes = r.notes;
      const cities: City[] = r.cities.map((c, i) => ({
        // A city regenerated in the same hex keeps the site it was given by hand.
        ...(() => {
          const before = existing?.cities?.find((e) => e.name === c.name && e.col === c.col && e.row === c.row);
          return before?.site ? { site: before.site } : {};
        })(),
        id: reuseIdByName(existing?.cities, c.name) ?? stableId('city', c.name, i),
        col: c.col,
        row: c.row,
        name: c.name,
        population: c.population,
        ...(c.capital ? { capital: true } : {}),
        onRiver: false,
        riverId: null,
        coastal: false,
        coastalEdges: [],
      }));
      const checked = validateCities(cities, ctx.base!, ctx.rivers?.rivers ?? null, cols, rows, ctx.allowUnderwater);
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
          ...(p.shortName?.trim() ? { shortName: p.shortName.trim() } : {}),
          colour: normaliseColour(p.colour, i),
        };
        const key = (p.key ?? '').trim().charAt(0);
        if (key && key !== POLITY_UNCLAIMED) byKey.set(key, polity);
        return polity;
      });
      // Parents are named in the response; resolve them to ids, dropping any
      // that name nothing, name the polity itself, or close a loop.
      const idByName = new Map(polities.map((p) => [p.name.trim().toLowerCase(), p.id]));
      r.polities.forEach((p, i) => {
        const parentId = p.parent?.trim() ? idByName.get(p.parent.trim().toLowerCase()) : undefined;
        if (p.parent?.trim() && !parentId) warnings.push(`Polity "${p.name}" names an unknown parent "${p.parent}"; it is treated as independent.`);
        if (parentId && parentId !== polities[i]!.id) polities[i]!.parentId = parentId;
      });
      const cleaned = withValidParents(polities);
      if (cleaned.dropped > 0) warnings.push(`${cleaned.dropped} polity parent link(s) formed a loop and were removed.`);
      polities.splice(0, polities.length, ...cleaned.polities);
      const owner: (string | null)[] = new Array(cols * rows).fill(null);
      let unknownKeys = 0;
      let misSized = 0;
      for (let row = 0; row < rows; row++) {
        const line = stripGridView(r.rows[row] ?? '').replace(/\s+/g, '');
        if (r.rows[row] !== undefined && line.length !== cols) misSized++;
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
      if (misSized > 0) {
        warnings.push(`${misSized} polity rows were not ${cols} characters long; padded as unclaimed or truncated.`);
      }
      if (unknownKeys > 0) {
        warnings.push(`${unknownKeys} hexes used an undeclared polity key and were left unclaimed.`);
      }
      const checked = validatePolities(polities, owner, ctx.base!, cols, rows, ctx.allowUnderwater);
      warnings.push(...checked.warnings);
      warnings.push(...sizeWarnings(r.polities, polities, checked.data.owner));
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

/**
 * Compare each polity's drawn size with the size it was declared to have.
 *
 * The declared size is where a brief's stated area ends up (the roster pass
 * converts it to hexes), so this is the check that says "the brief asked for
 * this and the map does not have it" instead of leaving the user to count.
 */
function sizeWarnings(
  declared: { hexes?: number }[],
  polities: Polity[],
  owner: (string | null)[],
): string[] {
  const out: string[] = [];
  polities.forEach((polity, i) => {
    const target = declared[i]?.hexes;
    if (!target || target <= 0) return;
    const actual = owner.filter((id) => id === polity.id).length;
    const tolerance = Math.max(2, Math.round(target * 0.2));
    if (Math.abs(actual - target) > tolerance) {
      out.push(
        `${polity.name} holds ${actual} hexes but was planned at ${target} (${actual > target ? '+' : ''}${Math.round(((actual - target) / target) * 100)}%).`,
      );
    }
  });
  return out;
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
