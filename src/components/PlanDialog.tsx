import { useState } from 'react';
import { plannedLayers } from '../../shared/layers.js';
import type { LayerId, MapState } from '../../shared/types.js';
import LayerPicker from './LayerPicker.js';

/** Change which layers this map has, after it has been created. */
export default function PlanDialog({
  map,
  onSave,
  onClose,
}: {
  map: MapState;
  onSave: (layers: LayerId[]) => void;
  onClose: () => void;
}) {
  const [selection, setSelection] = useState<LayerId[]>(plannedLayers(map));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Layer plan</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Add a layer you skipped, or drop one you decided you do not want. Removing a layer that
          already has data hides it rather than deleting it — add it back and the data returns.
        </p>
        <LayerPicker
          selection={selection}
          onChange={setSelection}
          map={map}
          cols={map.cols}
          rows={map.rows}
        />
        <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>cancel</button>
          <button
            className="primary"
            onClick={() => {
              onSave(selection);
              onClose();
            }}
          >
            save plan
          </button>
        </div>
      </div>
    </div>
  );
}
