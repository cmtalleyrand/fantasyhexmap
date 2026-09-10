/**
 * Autosave to IndexedDB. A refresh must not lose work, so every committed change
 * is written back (debounced just enough to coalesce a drag).
 */

import type { MapState } from '../../shared/types.js';

const DB_NAME = 'fantasyhexmap';
const DB_VERSION = 1;
const STORE = 'maps';
const CURRENT_KEY = 'current';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  });
}

export async function saveMap(map: MapState): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(map, CURRENT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
  });
  db.close();
}

export async function loadMap(): Promise<MapState | null> {
  const db = await openDb();
  const result = await new Promise<MapState | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(CURRENT_KEY);
    request.onsuccess = () => resolve((request.result as MapState | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed'));
  });
  db.close();
  return result;
}

export async function clearMap(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(CURRENT_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'));
  });
  db.close();
}

/** Debounced autosave; the last state wins. */
export function makeAutosaver(delay = 400) {
  let timer: number | null = null;
  let pending: MapState | null = null;
  let onError: ((e: unknown) => void) | null = null;
  return {
    onError(handler: (e: unknown) => void) {
      onError = handler;
    },
    save(map: MapState) {
      pending = map;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        const snapshot = pending;
        pending = null;
        if (snapshot) saveMap(snapshot).catch((e) => onError?.(e));
      }, delay);
    },
    flush() {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      const snapshot = pending;
      pending = null;
      return snapshot ? saveMap(snapshot) : Promise.resolve();
    },
  };
}
