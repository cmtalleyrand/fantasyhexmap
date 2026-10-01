/**
 * Autosave to IndexedDB. A refresh must not lose work, so every committed change
 * is written back (debounced just enough to coalesce a drag).
 */

import type { MapState } from '../../shared/types.js';

const DB_NAME = 'fantasyhexmap';
const DB_VERSION = 2;
const STORE = 'maps';
const SAVES_STORE = 'saves';
const CURRENT_KEY = 'current';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(SAVES_STORE)) db.createObjectStore(SAVES_STORE, { keyPath: 'id' });
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

/** A named, explicit save kept in the browser alongside the autosave. */
export interface SavedMapRecord {
  id: string;
  name: string;
  savedAt: number;
  cols: number;
  rows: number;
  map: MapState;
}

export type SavedMapSummary = Omit<SavedMapRecord, 'map'>;

function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(SAVES_STORE, mode);
        const req = run(tx.objectStore(SAVES_STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onerror = tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('IndexedDB transaction failed'));
        };
      }),
  );
}

/** Save a snapshot under `id` (a new id is generated when omitted); returns the id. */
export async function putSave(map: MapState, name: string, id?: string): Promise<string> {
  const key = id ?? `save-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const record: SavedMapRecord = {
    id: key,
    name: name.trim() || 'Untitled map',
    savedAt: Date.now(),
    cols: map.cols,
    rows: map.rows,
    map,
  };
  await request('readwrite', (store) => store.put(record));
  return key;
}

/** Newest first, without the (large) map payloads' consumers needing to hold them. */
export async function listSaves(): Promise<SavedMapSummary[]> {
  const records = await request<SavedMapRecord[]>('readonly', (store) => store.getAll());
  return records
    .map(({ map: _map, ...summary }) => summary)
    .sort((a, b) => b.savedAt - a.savedAt);
}

export async function loadSave(id: string): Promise<MapState | null> {
  const record = await request<SavedMapRecord | undefined>('readonly', (store) => store.get(id));
  return record?.map ?? null;
}

export async function deleteSave(id: string): Promise<void> {
  await request('readwrite', (store) => store.delete(id));
}
