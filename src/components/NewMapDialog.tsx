import { useState } from 'react';
import type { MapState } from '../../shared/types.js';
import { exportJson } from '../render/export.js';
import { putSave } from '../state/persistence.js';
import Modal from './Modal.js';

/**
 * Starting a new map replaces the autosave, which is the only copy of the
 * current map unless it was saved or exported. So the choice is offered here,
 * rather than a yes/no that is easy to click through.
 */
export default function NewMapDialog({
  map,
  onClose,
  onConfirmed,
}: {
  map: MapState;
  onClose: () => void;
  onConfirmed: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const saveThenNew = () => {
    setBusy(true);
    setError(null);
    putSave(map, map.name)
      .then(onConfirmed)
      .catch((e) => {
        setBusy(false);
        setError(`Could not save it: ${e instanceof Error ? e.message : String(e)}`);
      });
  };

  return (
    <Modal label="Start a new map" className="narrow" onClose={onClose}>
      <h2>Start a new map?</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        “{map.name}” is kept in this browser's autosave, and a new map replaces it. Keep a copy first
        unless you are sure you are done with it.
      </p>
      {error && <div className="notice error">{error}</div>}
      <div className="stack" style={{ marginTop: 10 }}>
        <button className="primary" disabled={busy} onClick={saveThenNew}>
          Save it to Saved maps, then start a new one
        </button>
        <button
          disabled={busy}
          onClick={() => {
            exportJson(map, true);
            onConfirmed();
          }}
        >
          Download it as JSON, then start a new one
        </button>
        <button className="danger" disabled={busy} onClick={onConfirmed}>
          Discard it and start a new one
        </button>
        <button disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}
