import { categoryCounts } from '../../shared/customLayers.js';
import type { CustomLayer, MapState } from '../../shared/types.js';
import type { Action } from '../state/store.js';

/**
 * The inspector for a user-defined layer: its categories, and how hexes are
 * given them. A category can be armed as a brush (then dragging over the map
 * paints it, and the eraser takes hexes out), or applied to the hexes currently
 * selected.
 */
export default function CustomLayerEditor({
  map,
  layer,
  dispatch,
  selection,
  setSelection,
  brush,
  setBrush,
  newId,
  onRemoved,
}: {
  map: MapState;
  layer: CustomLayer;
  dispatch: (action: Action) => void;
  selection: Set<number>;
  setSelection: (next: Set<number>) => void;
  /** The armed category id; '' is the eraser; null is not painting. */
  brush: string | null;
  setBrush: (next: string | null) => void;
  newId: (prefix: string) => string;
  onRemoved: () => void;
}) {
  const counts = categoryCounts(layer);
  const selected = [...selection].filter((i) => i >= 0 && i < map.cols * map.rows);
  const assigned = Object.keys(layer.values).length;
  const apply = (categoryId: string | null) =>
    dispatch({ type: 'setCustomHexes', layerId: layer.id, indices: selected, categoryId });

  return (
    <div className="inspector">
      <div className="section">
        <h2>Custom layer</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          A layer of your own: sort hexes into categories you define and they are drawn over the
          map. Nothing is generated for it, and changing other layers never makes it stale.
        </p>
        <label className="field">
          Name
          <input
            type="text"
            value={layer.name}
            onChange={(e) => dispatch({ type: 'renameCustomLayer', id: layer.id, name: e.target.value })}
          />
        </label>
        <div className="row" style={{ marginTop: 8 }}>
          <label className="row" style={{ gap: 6 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={layer.shown}
              onChange={(e) => dispatch({ type: 'setCustomLayerShown', id: layer.id, shown: e.target.checked })}
            />
            shown on the map and in exports
          </label>
          <span className="grow" />
          <button
            className="tiny danger"
            onClick={() => {
              if (window.confirm(`Delete the layer "${layer.name}" and the ${assigned} hex(es) assigned in it?`)) {
                dispatch({ type: 'removeCustomLayer', id: layer.id });
                onRemoved();
              }
            }}
          >
            delete layer
          </button>
        </div>
      </div>

      <div className="section">
        <h2>Categories</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Click a category to paint with it: drag over the map to assign hexes. Or select hexes
          first (drag, or shift-drag to add) and use <b>set selected</b>.
        </p>
        <div className="list">
          {layer.categories.map((category) => {
            const armed = brush === category.id;
            return (
              <div key={category.id} className={`entry ${armed ? 'active' : ''}`} style={{ gap: 6 }}>
                <input
                  type="color"
                  aria-label={`Colour of ${category.name}`}
                  value={category.colour}
                  style={{ width: 32, padding: 0 }}
                  onChange={(e) =>
                    dispatch({ type: 'updateCustomCategory', layerId: layer.id, id: category.id, colour: e.target.value })
                  }
                />
                <input
                  type="text"
                  className="grow"
                  aria-label="Category name"
                  value={category.name}
                  onChange={(e) =>
                    dispatch({ type: 'updateCustomCategory', layerId: layer.id, id: category.id, name: e.target.value })
                  }
                />
                <span className="hint" title="Hexes in this category">{counts.get(category.id) ?? 0}</span>
                <button
                  className={`tiny ${armed ? 'primary' : ''}`}
                  aria-pressed={armed}
                  title="Arm as a brush, then drag over the map"
                  onClick={() => setBrush(armed ? null : category.id)}
                >
                  paint
                </button>
                <button
                  className="tiny"
                  disabled={selected.length === 0}
                  title="Give every selected hex this category"
                  onClick={() => apply(category.id)}
                >
                  set selected
                </button>
                <button
                  className="tiny danger"
                  title="Remove this category and unassign its hexes"
                  onClick={() => {
                    const n = counts.get(category.id) ?? 0;
                    if (n === 0 || window.confirm(`Remove "${category.name}"? Its ${n} hex(es) become unassigned.`)) {
                      if (brush === category.id) setBrush(null);
                      dispatch({ type: 'removeCustomCategory', layerId: layer.id, id: category.id });
                    }
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button
            className="tiny"
            onClick={() => dispatch({ type: 'addCustomCategory', layerId: layer.id, id: newId('cat') })}
          >
            + add category
          </button>
          <button
            className={`tiny ${brush === '' ? 'primary' : ''}`}
            aria-pressed={brush === ''}
            title="Drag over the map to take hexes out of this layer"
            onClick={() => setBrush(brush === '' ? null : '')}
          >
            eraser
          </button>
          <button
            className="tiny"
            disabled={selected.length === 0}
            onClick={() => apply(null)}
            title="Take every selected hex out of this layer"
          >
            clear selected
          </button>
          {selected.length > 0 && (
            <button className="tiny" onClick={() => setSelection(new Set())}>
              deselect ({selected.length})
            </button>
          )}
        </div>
        <p className="hint">
          {assigned} hex{assigned === 1 ? '' : 'es'} assigned, {selected.length} selected.
          {brush !== null && ' Painting is on: dragging over the map assigns hexes.'}
        </p>
      </div>
    </div>
  );
}
