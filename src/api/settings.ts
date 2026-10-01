/**
 * Browser-side settings, including the API key when the app is deployed as a
 * static site with no server of its own.
 *
 * The key is typed in by the person using the page and stays in that browser.
 * It is never bundled, never committed, and never sent anywhere except
 * api.anthropic.com. "Remember" chooses localStorage (survives a restart) over
 * sessionStorage (gone when the tab closes) - localStorage is the convenient
 * default, sessionStorage the cautious one, and neither is safe against script
 * running on this origin, which is why the page loads no third-party code.
 */

import {
  clampTaskBudget,
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  DEFAULT_TASK_BUDGET,
  PREVIOUS_DEFAULTS,
  type Effort,
} from '../../core/config.js';

import type { EncryptedKey } from './keyvault.js';

const KEY_NAME = 'fantasyhexmap.apiKey';
const LOCKED_NAME = 'fantasyhexmap.apiKey.locked';
const PREFS_NAME = 'fantasyhexmap.prefs';

export interface Prefs {
  model: string;
  effort: Effort;
  /**
   * Advisory token budget the model paces its reasoning against. Reasoning and
   * answer share one output budget, so this is the knob that decides whether a
   * hard layer thinks its way past the end of the response.
   */
  taskBudget: number;
  /** Use the offline procedural generator instead of calling the API. */
  offline: boolean;
  remember: boolean;
  /** How elevation is drawn on the map: tinted hexes or terrain marks. */
  elevationStyle: 'colour' | 'contours';
  /** Draw polity/city names on the map. */
  labels: boolean;
  /**
   * Which generation of defaults these prefs were saved under. Prefs saved
   * before this existed carry the old effort and budget whether or not anyone
   * chose them, so those two values are refreshed when they still equal the old
   * defaults exactly.
   */
  defaultsVersion?: number;
}

const DEFAULTS_VERSION = 2;

export const DEFAULT_PREFS: Prefs = {
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
  taskBudget: DEFAULT_TASK_BUDGET,
  offline: false,
  remember: true,
  elevationStyle: 'colour',
  labels: true,
  defaultsVersion: DEFAULTS_VERSION,
};

function safeGet(store: Storage | undefined, name: string): string | null {
  try {
    return store?.getItem(name) ?? null;
  } catch {
    return null; // private mode, blocked storage
  }
}

export function loadApiKey(): string {
  return (
    safeGet(window.localStorage, KEY_NAME) ?? safeGet(window.sessionStorage, KEY_NAME) ?? ''
  );
}

/** The passphrase-protected key, when one is stored. */
export function loadLockedKey(): EncryptedKey | null {
  const raw = safeGet(window.localStorage, LOCKED_NAME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as EncryptedKey;
    return parsed?.v === 1 && parsed.salt && parsed.iv && parsed.data ? parsed : null;
  } catch {
    return null;
  }
}

function clearStored(): void {
  try {
    window.localStorage.removeItem(KEY_NAME);
    window.localStorage.removeItem(LOCKED_NAME);
    window.sessionStorage.removeItem(KEY_NAME);
  } catch {
    /* ignore */
  }
}

export function saveApiKey(key: string, remember: boolean): void {
  const trimmed = key.trim();
  clearStored();
  if (!trimmed) return;
  try {
    (remember ? window.localStorage : window.sessionStorage).setItem(KEY_NAME, trimmed);
  } catch {
    /* storage unavailable; the key stays in memory for this page load only */
  }
}

/** Replaces any plaintext copy: a locked key is the only one on disk. */
export function saveLockedKey(payload: EncryptedKey): void {
  clearStored();
  try {
    window.localStorage.setItem(LOCKED_NAME, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

export function forgetKey(): void {
  clearStored();
}

/** A page served over plain HTTP cannot protect a key in transit or at rest. */
export function insecureOrigin(): boolean {
  return typeof window !== 'undefined' && !window.isSecureContext;
}

export function loadPrefs(): Prefs {
  const raw = safeGet(window.localStorage, PREFS_NAME);
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    const stored = JSON.parse(raw) as Partial<Prefs>;
    if (
      (stored.defaultsVersion ?? 1) < DEFAULTS_VERSION &&
      stored.effort === PREVIOUS_DEFAULTS.effort &&
      stored.taskBudget === PREVIOUS_DEFAULTS.taskBudget
    ) {
      delete stored.effort;
      delete stored.taskBudget;
    }
    return {
      ...DEFAULT_PREFS,
      ...stored,
      taskBudget: clampTaskBudget(stored.taskBudget ?? DEFAULT_PREFS.taskBudget),
      elevationStyle: stored.elevationStyle === 'contours' ? 'contours' : 'colour',
      labels: stored.labels !== false,
      defaultsVersion: DEFAULTS_VERSION,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(PREFS_NAME, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

/** An Anthropic key looks like sk-ant-...; a wrong paste is worth catching early. */
export function looksLikeKey(key: string): boolean {
  return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}
