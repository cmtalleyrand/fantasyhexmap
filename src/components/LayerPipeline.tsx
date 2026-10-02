import {
  LAYER_META,
  excludedInfluences,
  isUnlocked,
  missingRequirements,
  plannedLayers,
  stalenessOf,
} from '../../shared/layers.js';
import { generationOrder } from '../../shared/generationQueue.js';
import { type LayerId, type MapState } from '../../shared/types.js';
import type { VisibleLayers } from '../render/scene.js';

export interface LayerPipelineProps {
  map: MapState;
  activeLayer: LayerId;
  visible: VisibleLayers;
  selectedLayers: ReadonlySet<LayerId>;
  busyLayers: ReadonlySet<LayerId>;
  onSelect: (layer: LayerId) => void;
  onToggleVisible: (layer: LayerId) => void;
  onToggleSelected: (layer: LayerId) => void;
  concurrency: number;
  onConcurrencyChange: (value: number) => void;
  onGenerateSelected: () => void;
  /** Generate exactly these layers, in dependency order. */
  onGenerateLayers: (layers: LayerId[]) => void;
  onEditPlan: () => void;
}

/** An eye, open or struck through: whether a layer is drawn on the map. */
function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {!open && <path d="M4 20 20 4" />}
    </svg>
  );
}

export default function LayerPipeline(props: LayerPipelineProps) {
  const { map, activeLayer, visible, selectedLayers, busyLayers } = props;
  const planned = plannedLayers(map);
  const omitted = 8 - planned.length;
  const busy = busyLayers.size > 0;
  // Layers in the plan with nothing generated yet, in the order they would be made.
  const remaining = generationOrder(planned.filter((id) => !map.layers[id].data));

  return (
    <div className="section">
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h2 style={{ flex: 1 }}>Layers</h2>
        <button className="tiny" onClick={props.onEditPlan} title="Choose which layers this map has">
          plan{omitted > 0 ? ` (${omitted} left out)` : ''}
        </button>
      </div>

      {remaining.length > 0 && !busy && (
        <div className="next-step">
          <span>
            {remaining.length === planned.length ? 'Nothing generated yet.' : 'Still to generate:'}{' '}
            {remaining.map((id) => LAYER_META[id].label).join(', ')}.
          </span>
          <button className="primary" onClick={() => props.onGenerateLayers(remaining)}>
            {remaining.length === 1
              ? `Generate ${LAYER_META[remaining[0]!].label}`
              : `Generate ${remaining.length === planned.length ? 'all' : 'the'} ${remaining.length} layers`}
          </button>
        </div>
      )}

      <div className="layer-head" aria-hidden="true">
        <span title="Show the layer on the map">show</span>
        <span title="Tick layers to generate or rewrite together">batch</span>
      </div>
      {planned.map((id) => {
        const meta = LAYER_META[id];
        const layer = map.layers[id];
        const unlocked = isUnlocked(map, id);
        const staleness = stalenessOf(map, id);
        const missing = missingRequirements(map, id);
        const gaps = excludedInfluences(map, id);
        const shown = visible[id] && Boolean(layer.data);
        return (
          <div
            key={id}
            className={['layer-row', id === activeLayer ? 'active' : '', unlocked ? '' : 'locked'].join(' ')}
            onClick={() => unlocked && props.onSelect(id)}
            title={unlocked ? meta.blurb : `Needs ${missing.map((m) => LAYER_META[m].label).join(', ')} first`}
          >
            <button
              type="button"
              className="eye"
              aria-pressed={shown}
              aria-label={`${shown ? 'Hide' : 'Show'} ${meta.label} on the map`}
              title={layer.data ? (shown ? 'Shown on the map - click to hide' : 'Hidden - click to show') : 'Nothing to show yet'}
              disabled={!layer.data}
              onClick={(e) => {
                e.stopPropagation();
                props.onToggleVisible(id);
              }}
            >
              <EyeIcon open={shown} />
            </button>
            <input
              type="checkbox"
              checked={selectedLayers.has(id)}
              disabled={busy}
              onClick={(e) => e.stopPropagation()}
              onChange={() => props.onToggleSelected(id)}
              title="Tick to generate or rewrite this layer together with other ticked layers"
              aria-label={`Select ${meta.label} for generation`}
            />
            <span className="name">
              <b>{meta.label}</b>
              <small>
                {busyLayers.has(id)
                  ? 'Generating…'
                  : layer.data
                    ? staleness.stale
                      ? staleness.reasons.join('; ')
                      : gaps.length > 0
                        ? `Made without ${gaps.map((g) => LAYER_META[g].label).join(', ')}`
                        : meta.blurb
                    : unlocked
                      ? 'Not generated yet'
                      : `Locked - needs ${missing.map((m) => LAYER_META[m].label).join(', ')}`}
              </small>
            </span>
            {busyLayers.has(id) ? (
              <span className="badge">working</span>
            ) : layer.data ? (
              <span className={`badge ${staleness.stale ? 'stale' : 'ok'}`}>{staleness.stale ? 'stale' : 'ready'}</span>
            ) : (
              <span className="badge empty">empty</span>
            )}
          </div>
        );
      })}

      <div className="row layer-batch-controls">
        <button
          className="tiny grow"
          disabled={busy || selectedLayers.size === 0}
          onClick={props.onGenerateSelected}
          title="Generate every ticked layer, each after the layers it reads"
        >
          {selectedLayers.size === 0 ? 'tick layers to generate them together' : `generate ${selectedLayers.size} ticked`}
        </button>
        <label title="Maximum layer requests run at the same time">
          at once
          <select
            value={props.concurrency}
            disabled={busy}
            onChange={(event) => props.onConcurrencyChange(Number(event.target.value))}
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
          </select>
        </label>
      </div>
    </div>
  );
}
