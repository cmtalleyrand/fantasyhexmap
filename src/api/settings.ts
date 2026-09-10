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

import { DEFAULT_EFFORT, DEFAULT_MODEL, type Effort } from '../../core/config.js';

const KEY_NAME = 'fantasyhexmap.apiKey';
const PREFS_NAME = 'fantasyhexmap.prefs';

export interface Prefs {
  model: string;
  effort: Effort;
  /** Use the offline procedural generator instead of calling the API. */
  offline: boolean;
  remember: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
  offline: false,
  remember: true,
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

export function saveApiKey(key: string, remember: boolean): void {
  const trimmed = key.trim();
  try {
    window.localStorage.removeItem(KEY_NAME);
    window.sessionStorage.removeItem(KEY_NAME);
    if (trimmed) {
      (remember ? window.localStorage : window.sessionStorage).setItem(KEY_NAME, trimmed);
    }
  } catch {
    /* storage unavailable; the key stays in memory for this page load only */
  }
}

export function loadPrefs(): Prefs {
  const raw = safeGet(window.localStorage, PREFS_NAME);
  if (!raw) return { ...DEFAULT_PREFS };
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) };
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
