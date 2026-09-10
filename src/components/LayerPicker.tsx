import {
  LAYER_META,
  LAYER_PRESETS,
  excludedInfluences,
  normaliseSelection,
} from '../../shared/layers.js';
import { LAYER_ORDER, type LayerId, type MapState } from '../../shared/types.js';

/**
 * Choosing which layers a map will have.
 *
 * Each layer is one generation over the whole grid, so on a large map the
 * difference between three layers and eight is the difference between a few
 * minutes and most of an hour. Picking a subset up front is the main lever a
 * user has over that, so it is offered at creation rather than buried later.
 */
export default function LayerPicker({
  selection,
  onChange,
  map,
  cols,
  rows,
}: {
  selection: LayerId[];
  onChange: (next: LayerId[]) => void;
  /** When editing an existing map, used to warn about layers that already hold data. */
  map?: MapState;
  cols: number;
  rows: number;
}) {
  const chosen = new Set(selection);

  const toggle = (id: LayerId) => {
    if (id === 'base') return; // nothing works without it
    const next = new Set(chosen);
    if (next.has(id)) {
      next.delete(id);
      // Anything that hard-requires this layer has to go too.
      for (const other of LAYER_ORDER) {
        if (next.has(other) && LAYER_META[other].requires.includes(id)) next.delete(other);
      }
    } else {
      next.add(id);
    }
    onChange(normaliseSelection(next));
  };

  const activePreset = LAYER_PRESETS.find(
    (p) =>
      p.layers.length === selection.length &&
      p.layers.every((id) => chosen.has(id)),
  );

  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        {LAYER_PRESETS.map((preset) => (
          <button
            key={preset.id}
            className={`tiny ${activePreset?.id === preset.id ? 'primary' : ''}`}
            title={preset.blurb}
            onClick={() => onChange(normaliseSelection(preset.layers))}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="list">
        {LAYER_ORDER.map((id) => {
          const meta = LAYER_META[id];
          const on = chosen.has(id);
          const holdsData = map ? map.layers[id].data !== null : false;
          const missing = on
            ? meta.uses.filter((dep) => !chosen.has(dep))
            : [];
          return (
            <label key={id} className={`entry picker ${on ? '' : 'off'}`} style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={on}
                disabled={id === 'base'}
                onChange={() => toggle(id)}
              />
              <span className="grow">
                <b>{meta.label}</b>
                {id === 'base' && <span className="badge" style={{ marginLeft: 6 }}>always</span>}
                <div className="hint">{meta.blurb}</div>
                {missing.length > 0 && (
                  <div className="hint" style={{ color: 'var(--warn)' }}>
                    Generated without {missing.map((d) => LAYER_META[d].label).join(', ')} — the model
                    will have to infer what it needs and commit to it.
                  </div>
                )}
                {!on && holdsData && (
                  <div className="hint" style={{ color: 'var(--warn)' }}>
                    Already has data. Leaving it out hides it from the map and exports; the data is
                    kept and comes back if you add the layer again.
                  </div>
                )}
              </span>
            </label>
          );
        })}
      </div>

      <p className="hint" style={{ margin: 0 }}>
        <b>{selection.length} layer{selection.length === 1 ? '' : 's'}</b> — {selection.length}{' '}
        generation{selection.length === 1 ? '' : 's'}, each covering all{' '}
        {(cols * rows).toLocaleString()} hexes. Every layer is one pass over the whole grid, so a
        large map is slower and costlier per layer as well as having more of them.
      </p>
    </div>
  );
}

/** Soft dependencies of a layer that this map will never have; used for a UI hint. */
export function influenceGaps(map: MapState, id: LayerId): LayerId[] {
  return excludedInfluences(map, id);
}
