/**
 * Rosters: the cast of a layer, separated from its geometry.
 *
 * Two layers invent a vocabulary and apply it to the grid in the same breath -
 * polities name their realms and partition the land, rivers name their waters
 * and trace them hex by hex. Those are mutually constraining problems, and
 * asking for both at once is expensive: the model cannot settle the roster
 * without a sense of the geography, or the geography without the roster.
 *
 * Naming the roster as a thing in its own right lets it be produced on its own,
 * reused from a layer that already exists, or written by hand - and then the
 * geometry pass has a fixed, closed set to work against instead of an open
 * design problem.
 *
 * This module is dependency-free beyond shared types, so the import UI, the
 * prompt builders and the webchat flow all read the same parser.
 */

import type { PolitiesData, RiversData } from '../shared/types.js';

/** Keys are assigned by position, which is also how the prompts encode them. */
export const ROSTER_KEYS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/**
 * The most polities a map can carry.
 *
 * Twelve, for three reasons that happen to agree: it is the ceiling of
 * `suggestedPolityCount`, so the prompt can never ask for more than the schema
 * accepts; it is the length of FALLBACK_COLOURS, so colours never repeat; and it
 * is well inside the 26-character key space, so keys never run out and collapse
 * onto `keyAt`'s '?' fallback.
 *
 * Rivers are not capped: they are named features, not a partition, and nothing
 * about them is keyed to a single character.
 */
export const MAX_POLITIES = 12;

export interface PolityRosterEntry {
  key: string;
  name: string;
  colour: string;
}

export interface RiverRosterEntry {
  name: string;
  /** One clause on where it rises, runs and ends. No hex coordinates. */
  course: string;
}

export type Roster =
  | { kind: 'polities'; entries: PolityRosterEntry[] }
  | { kind: 'rivers'; entries: RiverRosterEntry[] };

export type RosterKind = Roster['kind'];

/**
 * Which half of a split layer a request is for.
 *
 * `full` is the one-request form every layer supports and the only one most
 * layers have. Lives here rather than in `passes.ts` so the prompt builders can
 * name it without importing the registry that imports them.
 */
export type PassId = 'full' | 'roster' | 'paint';

/** What the user asked for, which is not quite the same as what gets run. */
export type PassSelection = 'both' | 'roster' | 'paint';

/** Human wording for a pass, used in progress messages and the webchat dialog. */
export function passLabel(layer: string, pass: PassId): string {
  if (pass === 'full') return 'whole layer';
  if (layer === 'rivers') return pass === 'roster' ? 'river list' : 'river courses';
  return pass === 'roster' ? 'polity roster' : 'borders';
}

export function canSplit(layer: string): boolean {
  return isRosterLayer(layer);
}

/**
 * The passes to actually run.
 *
 * A layer that cannot split always runs `full`. "Paint" on its own is legitimate
 * - that is repainting against a roster you already have - and so is "roster" on
 * its own, which leaves the geometry alone.
 */
export function passesFor(layer: string, selection: PassSelection = 'both'): PassId[] {
  if (!canSplit(layer)) return ['full'];
  if (selection === 'roster') return ['roster'];
  if (selection === 'paint') return ['paint'];
  return ['roster', 'paint'];
}

/** Which layers have a roster that can be generated or supplied separately. */
export const ROSTER_LAYERS: RosterKind[] = ['polities', 'rivers'];

export function isRosterLayer(layer: string): layer is RosterKind {
  return (ROSTER_LAYERS as string[]).includes(layer);
}

export function keyAt(index: number): string {
  return ROSTER_KEYS[index] ?? '?';
}

/* ------------------------------------------------------- from existing data */

/**
 * Read the roster straight off a layer that already exists. This is how you
 * redraw borders without renaming anything - and because ids are matched back
 * by name when the layer is decoded, the polity ids survive the repaint.
 */
export function rosterFromPolities(data: PolitiesData): Roster {
  return {
    kind: 'polities',
    entries: data.polities.map((p, i) => ({ key: keyAt(i), name: p.name, colour: p.colour })),
  };
}

export function rosterFromRivers(data: RiversData): Roster {
  return {
    kind: 'rivers',
    entries: data.rivers.map((r) => ({ name: r.name, course: '' })),
  };
}

/* ----------------------------------------------------------------- parsing */

export class RosterParseError extends Error {}

/**
 * Accept either JSON or one entry per line, because a roster is as likely to be
 * typed out or pasted from notes as it is to come back from a model.
 *
 *   Polities:  `Name | #a33b2e`   (colour optional)
 *   Rivers:    `Name | rises in the Spine, runs south to the Bay`
 */
export function parseRoster(kind: RosterKind, input: string): Roster {
  const text = input.trim();
  if (!text) throw new RosterParseError('The roster is empty.');

  const fromJson = tryParseJson(kind, text);
  if (fromJson) return fromJson;

  const entries = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (entries.length === 0) throw new RosterParseError('The roster has no entries.');
  if (kind === 'polities' && entries.length > MAX_POLITIES) {
    throw new RosterParseError(
      `${entries.length} polities is more than a map can show: the limit is ${MAX_POLITIES}, ` +
        'above which colours repeat and single-character keys run out.',
    );
  }

  if (kind === 'polities') {
    return {
      kind,
      entries: entries.map((line, i) => {
        const [name = '', colour = ''] = splitOnce(line);
        if (!name) throw new RosterParseError(`Line ${i + 1} has no name.`);
        return { key: keyAt(i), name, colour };
      }),
    };
  }
  return {
    kind,
    entries: entries.map((line, i) => {
      const [name = '', course = ''] = splitOnce(line);
      if (!name) throw new RosterParseError(`Line ${i + 1} has no name.`);
      return { name, course };
    }),
  };
}

function splitOnce(line: string): [string, string] {
  const at = line.indexOf('|');
  if (at === -1) return [line.trim(), ''];
  return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
}

function tryParseJson(kind: RosterKind, text: string): Roster | null {
  if (!text.startsWith('{') && !text.startsWith('[')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // Accept a bare array, or the object a roster generation returns.
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as Record<string, unknown>)?.[kind] ?? (parsed as Record<string, unknown>)?.entries;
  if (!Array.isArray(list)) {
    throw new RosterParseError(
      `That JSON has no "${kind}" array. Paste the roster array, or one entry per line.`,
    );
  }
  if (kind === 'polities') {
    if (list.length > MAX_POLITIES) {
      throw new RosterParseError(
        `${list.length} polities is more than a map can show: the limit is ${MAX_POLITIES}.`,
      );
    }
    return {
      kind,
      entries: list.map((raw, i) => {
        const item = (raw ?? {}) as Record<string, unknown>;
        const name = String(item.name ?? '').trim();
        if (!name) throw new RosterParseError(`Entry ${i + 1} has no name.`);
        const key = String(item.key ?? '').trim().charAt(0) || keyAt(i);
        return { key, name, colour: String(item.colour ?? '').trim() };
      }),
    };
  }
  return {
    kind,
    entries: list.map((raw, i) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      const name = String(item.name ?? '').trim();
      if (!name) throw new RosterParseError(`Entry ${i + 1} has no name.`);
      return { name, course: String(item.course ?? '').trim() };
    }),
  };
}

/* ------------------------------------------------------------- serialising */

/** The line form, for showing a roster in a textarea the user can edit. */
export function rosterToLines(roster: Roster): string {
  if (roster.kind === 'polities') {
    return roster.entries.map((e) => `${e.name}${e.colour ? ` | ${e.colour}` : ''}`).join('\n');
  }
  return roster.entries.map((e) => `${e.name}${e.course ? ` | ${e.course}` : ''}`).join('\n');
}

/**
 * Re-key a polity roster by position. Keys are what the painted rows refer to,
 * so a hand-edited roster that reuses or skips letters would silently drop hexes;
 * assigning them here means the only source of keys is position.
 */
export function normaliseRoster(roster: Roster): Roster {
  if (roster.kind !== 'polities') return roster;
  return {
    kind: 'polities',
    entries: roster.entries.map((e, i) => ({ ...e, key: keyAt(i) })),
  };
}
