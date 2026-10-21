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
import { pruneShares } from '../shared/polityShares.js';
import { applyAutoShade } from '../shared/polityShade.js';
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
import { isRangeElevation, isIslandType, islandSpecFor } from '../shared/types.js';
import type {
  City,
  BaseData,
  ElevationData,
  GeoName,
  GeoNameKind,
  LayerDataMap,
  LayerId,
  MountainRange,
  Polity,
  River,
  HexShare,
  GeneratedIslandSettings,
} from '../shared/types.js';
import type { PromptContext } from './prompts.js';
import { keyedToRows, type CellKind } from './grid.js';
import { GEO_NAME_KINDS, geoEligibility } from '../shared/geoNames.js';
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

export interface DecodedLayer<K extends LayerId = LayerId> extends GeneratedIslandSettings {
  data: LayerDataMap[K];
  warnings: string[];
  /** Names the response gave to seas, lakes, islands and land regions (base layer). */
  geoNames?: GeoName[];
  /** Names the response gave to mountain ranges (elevation layer). */
  mountainRanges?: MountainRange[];
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
  // it first keeps a brace in the prose around it from being mistaken for the
  // start of the object.
  for (const fence of text.matchAll(/```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/g)) {
    const inside = scanForObject(fence[1] ?? '');
    if (inside) return inside;
  }
  return scanForObject(text);
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
  existing ??= { rivers: ctx.rivers?.rivers, cities: ctx.cities?.cities, polities: ctx.polities?.polities };
  const warnings: string[] = [];
  let data: LayerDataMap[LayerId];
  let geoNames: GeoName[] | undefined;
  let mountainRanges: MountainRange[] | undefined;
  const islandSettings: GeneratedIslandSettings = {};

  switch (layer) {
    case 'base': {
      const r = parsed as BaseResponse;
      const decoded = decodeBase(r.rows, cols, rows);
      warnings.push(...decoded.warnings);
      data = decoded.data;
      geoNames = decodeGeoNames(r.names, decoded.data, ctx.geoNames ?? [], cols, rows, warnings);
      const seen = new Set<number>();
      for (const edit of r.islands ?? []) {
        const { col, row } = edit;
        const i = row * cols + col;
        if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || col >= cols || row < 0 || row >= rows ||
          !isIslandType(decoded.data[i]) || seen.has(i)) {
          warnings.push(`Ignored invalid or duplicate island settings at ${col},${row}.`);
          continue;
        }
        seen.add(i);
        const key = String(i);
        const previous = ctx.base?.[i] === decoded.data[i] ? ctx.islandSpecs?.[key] : undefined;
        const spec = { ...islandSpecFor(decoded.data[i], previous) };
        if (edit.large !== undefined) spec.large = edit.large;
        if (edit.small !== undefined) spec.small = edit.small;
        if (!Number.isInteger(spec.large) || spec.large < 0 || spec.large > 2 ||
          !Number.isInteger(spec.small) || spec.small < 0 || spec.small > 6 || spec.large + spec.small === 0) {
          warnings.push(`Ignored empty or invalid island counts at ${col},${row}.`);
          continue;
        }
        if (edit.arrangement !== undefined) spec.arrangement = edit.arrangement;
        if (edit.orientation !== undefined) spec.orientation = edit.orientation;
        if (edit.large !== undefined || edit.small !== undefined || edit.arrangement !== undefined || edit.orientation !== undefined) {
          (islandSettings.islandSpecs ??= {})[key] = spec;
        }
        if (edit.irregular !== undefined) {
          (islandSettings.hexShapes ??= {})[key] = { type: decoded.data[i]!, irregular: edit.irregular };
        }
      }
      break;
    }
    case 'elevation': {
      const r = parsed as ElevationResponse;
      const decoded = decodeElevation(r.rows, cols, rows);
      const checked = validateElevation(decoded.data, ctx.base!, cols, rows);
      warnings.push(...decoded.warnings, ...checked.warnings);
      data = checked.data;
      mountainRanges = decodeRanges(r.ranges, checked.data, ctx.mountainRanges ?? [], cols, rows, warnings);
      break;
    }
    case 'climate': {
      const r = parsed as ClimateResponse;
      const decoded = decodeClimate(r.rows, cols, rows);
      const checked = validateClimate(decoded.data, ctx.base!, ctx.elevation, cols, rows);
      warnings.push(...decoded.warnings, ...checked.warnings);
      data = checked.data;
      break;
    }
    case 'vegetation': {
      const r = parsed as VegetationResponse;
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
      // Roster-only is an internal operation, not model-supplied geometry.
      // Keep exact entry/exit edges, mouths, links and manual reach guidance.
      if ((parsed as { rosterOnly?: boolean }).rosterOnly && ctx.rivers) {
        data = { rivers: ctx.rivers.rivers.map((river, i) => ({ ...river, name: r.rivers[i]?.name ?? river.name })) };
        break;
      }
      // A distributary may be unnamed: it has no name to reuse an id by or to be referred to by.
      const ids = r.rivers.map(
        (input, i) =>
          (input.previousName ? reuseIdByName(existing?.rivers, input.previousName) : null) ??
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
      // Manual guidance belongs to the app. Keep it on unchanged reaches, including a rename.
      checked.data = checked.data.map((river) => {
        const before = existing?.rivers?.find((r) => r.id === river.id);
        if (!before) return river;
        return { ...river, segments: river.segments.map((segment) => {
          const old = before.segments.find((s) => s.col === segment.col && s.row === segment.row &&
            s.entryEdge === segment.entryEdge && s.exitEdge === segment.exitEdge);
          return old?.reach ? { ...segment, reach: old.reach } : segment;
        }) };
      });
      warnings.push(...checked.warnings);
      data = { rivers: checked.data };
      break;
    }
    case 'cities': {
      const r = parsed as CitiesResponse;
      const cities: City[] = r.cities.map((c, i) => ({
        // A city regenerated in the same hex keeps the site it was given by hand.
        ...(() => {
          const before = existing?.cities?.find((e) => e.name === (c.previousName ?? c.name) && e.col === c.col && e.row === c.row);
          return before?.site ? { site: before.site } : {};
        })(),
        id: reuseIdByName(existing?.cities, c.previousName ?? c.name) ?? stableId('city', c.name, i),
        col: c.col,
        row: c.row,
        name: c.name,
        population: c.population,
        ...((c.capital ?? (ctx.instruction ? existing?.cities?.find((e) => e.name === (c.previousName ?? c.name))?.capital : false)) ? { capital: true } : {}),
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
      const byKey = new Map<string, Polity>();
      const polities: Polity[] = r.polities.map((p, i) => {
        const before = existing?.polities?.find((e) => e.name.trim().toLowerCase() === (p.previousName ?? p.name).trim().toLowerCase()) ??
          (ctx.instruction ? existing?.polities?.['ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(p.key)] : undefined);
        const polity: Polity = {
          ...(before?.cityState !== undefined ? { cityState: before.cityState } : {}),
          ...(before?.autoShade !== undefined && before.colour === normaliseColour(p.colour, i) ? { autoShade: before.autoShade } : {}),
          ...(ctx.instruction && p.parent === undefined && before?.parentId ? { parentId: before.parentId } : {}),
          id: before?.id ?? stableId('pol', p.name, i),
          name: p.name,
          ...(p.shortName?.trim() ? { shortName: p.shortName.trim() } :
            ctx.instruction && p.shortName === undefined && before?.shortName ? { shortName: before.shortName } : {}),
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
      const previous = ctx.polities;
      const shares: Record<string, HexShare> = {};
      // Omission preserves a manual share only when its primary owner is unchanged.
      for (const [index, share] of Object.entries(previous?.shares ?? {})) {
        if (previous?.owner[Number(index)] === checked.data.owner[Number(index)]) shares[index] = share;
      }
      const seenShared = new Set<number>();
      for (const shared of r.sharedHexes ?? []) {
        if (!Number.isInteger(shared.col) || !Number.isInteger(shared.row) || shared.col < 0 || shared.col >= cols || shared.row < 0 || shared.row >= rows) {
          warnings.push('Ignored an off-map shared polity hex.');
          continue;
        }
        const index = shared.row * cols + shared.col;
        const other = shared.with === null ? null : byKey.get(shared.with);
        if (seenShared.has(index) || shared.share !== 0.5 || !checked.data.owner[index] ||
          (shared.with !== null && (!other || other.id === checked.data.owner[index]))) {
          warnings.push(`Ignored invalid shared ownership at ${shared.col},${shared.row}.`);
          continue;
        }
        seenShared.add(index);
        if (other) shares[String(index)] = { polityId: other.id, share: 0.5 };
        else delete shares[String(index)];
      }
      const shaded = applyAutoShade(checked.data.polities);
      data = pruneShares({ ...checked.data, polities: shaded, ...(Object.keys(shares).length ? { shares } : {}) });
      break;
    }
    case 'population': {
      const r = parsed as PopulationResponse;
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

  return {
    data,
    warnings,
    ...islandSettings,
    ...(geoNames?.length ? { geoNames } : {}),
    ...(mountainRanges?.length ? { mountainRanges } : {}),
  };
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
    if (!target || target <= 1 || polities.some((p) => p.parentId === polity.id)) return;
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

/* ------------------------------------------------------------------- names */

type NameSpan = { row?: unknown; from?: unknown; to?: unknown };

/** The flat hex indices of runs along rows; runs off the map are clipped. */
function spanHexes(spans: unknown, cols: number, rows: number): number[] {
  const out = new Set<number>();
  for (const span of Array.isArray(spans) ? (spans as NameSpan[]) : []) {
    const { row, from, to } = span ?? {};
    if (!Number.isInteger(row) || !Number.isInteger(from) || !Number.isInteger(to)) continue;
    const r = row as number;
    if (r < 0 || r >= rows) continue;
    const lo = Math.max(0, Math.min(from as number, to as number));
    const hi = Math.min(cols - 1, Math.max(from as number, to as number));
    for (let c = lo; c <= hi; c++) out.add(r * cols + c);
  }
  return [...out].sort((a, b) => a - b);
}

/** Names of seas, lakes, islands and land regions, kept to the hexes each kind may hold on the new base. */
function decodeGeoNames(raw: BaseResponse['names'], base: BaseData, existing: GeoName[], cols: number, rows: number, warnings: string[]): GeoName[] {
  const eligible = new Map<GeoNameKind, (index: number) => boolean>();
  const out: GeoName[] = [];
  (raw ?? []).forEach((entry, i) => {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (!name || !GEO_NAME_KINDS.includes(entry.kind)) return;
    if (!eligible.has(entry.kind)) eligible.set(entry.kind, geoEligibility(entry.kind, base, cols, rows));
    const hexes = spanHexes(entry.spans, cols, rows).filter(eligible.get(entry.kind)!);
    if (hexes.length === 0) {
      warnings.push(`The ${entry.kind} name "${name}" covers no hex that can hold it and was dropped.`);
      return;
    }
    const before = existing.filter((n) => n.kind === entry.kind);
    out.push({ id: reuseIdByName(before, entry.previousName ?? name) ?? stableId('geo', name, i), name, kind: entry.kind, hexes });
  });
  return out;
}

/** Names of mountain ranges, kept to Mountains and Highland hexes on the new elevation. */
function decodeRanges(raw: ElevationResponse['ranges'], elevation: ElevationData, existing: MountainRange[], cols: number, rows: number, warnings: string[]): MountainRange[] {
  const out: MountainRange[] = [];
  (raw ?? []).forEach((entry, i) => {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
    if (!name) return;
    const hexes = spanHexes(entry.spans, cols, rows).filter((index) => isRangeElevation(elevation[index]));
    if (hexes.length === 0) {
      warnings.push(`The range name "${name}" covers no Mountains or Highland hex and was dropped.`);
      return;
    }
    out.push({ id: reuseIdByName(existing, entry.previousName ?? name) ?? stableId('rng', name, i), name, hexes });
  });
  return out;
}
