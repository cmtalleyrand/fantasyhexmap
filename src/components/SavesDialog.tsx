import { useCallback, useEffect, useState } from 'react';
import type { MapState } from '../../shared/types.js';
import { deleteSave, listSaves, loadSave, putSave, type SavedMapSummary } from '../state/persistence.js';
import { prepareLoadedMap } from '../state/import.js';

/** Named saves kept in this browser's IndexedDB, separate from the rolling autosave. */
export default function SavesDialog({
  map,
  onLoad,
  onClose,
}: {
  map: MapState;
  onLoad: (map: MapState) => void;
  onClose: () => void;
}) {
  const [saves, setSaves] = useState<SavedMapSummary[] | null>(null);
  const [name, setName] = useState(map.name);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listSaves()
      .then(setSaves)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(refresh, [refresh]);

  const run = (fn: () => Promise<void>) => {
    setError(null);
    fn().then(refresh, (e) => setError(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Saved maps</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Saves live in this browser only (IndexedDB) and include undo history. Clearing site data
          removes them — use export JSON for a copy you can keep elsewhere.
        </p>
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Save name" />
          <button className="primary" onClick={() => run(() => putSave(map, name).then(() => undefined))}>
            save current
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="stack" style={{ marginTop: 12 }}>
          {saves === null ? (
            <span className="hint">Loading…</span>
          ) : saves.length === 0 ? (
            <span className="hint">No saves yet.</span>
          ) : (
            saves.map((save) => (
              <div className="row" key={save.id} style={{ alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div>{save.name}</div>
                  <div className="hint">
                    {save.cols}×{save.rows} · {new Date(save.savedAt).toLocaleString()}
                  </div>
                </div>
                <button
                  className="tiny"
                  title="Overwrite this save with the current map"
                  onClick={() => {
                    if (window.confirm(`Overwrite “${save.name}” with the current map?`)) {
                      run(() => putSave(map, save.name, save.id).then(() => undefined));
                    }
                  }}
                >
                  overwrite
                </button>
                <button
                  className="tiny"
                  onClick={() => {
                    if (!window.confirm(`Load “${save.name}”? The current map is replaced (it stays in the autosave until you edit).`)) return;
                    run(async () => {
                      const loaded = await loadSave(save.id);
                      if (!loaded) throw new Error('That save no longer exists.');
                      onLoad(prepareLoadedMap(loaded));
                      onClose();
                    });
                  }}
                >
                  load
                </button>
                <button
                  className="tiny danger"
                  onClick={() => {
                    if (window.confirm(`Delete “${save.name}”?`)) run(() => deleteSave(save.id));
                  }}
                >
                  delete
                </button>
              </div>
            ))
          )}
        </div>
        <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>close</button>
        </div>
      </div>
    </div>
  );
}
