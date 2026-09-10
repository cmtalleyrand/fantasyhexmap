import {
  LAYER_META,
  excludedInfluences,
  isUnlocked,
  missingRequirements,
  plannedLayers,
  stalenessOf,
} from '../../shared/layers.js';
import { type LayerId, type MapState } from '../../shared/types.js';
import type { VisibleLayers } from '../render/scene.js';

export interface LayerPipelineProps {
  map: MapState;
  activeLayer: LayerId;
  visible: VisibleLayers;
  busyLayers: ReadonlySet<LayerId>;
  onSelect: (layer: LayerId) => void;
  onToggleVisible: (layer: LayerId) => void;
  onGenerate: (layer: LayerId) => void;
  concurrency: number;
  onConcurrencyChange: (value: number) => void;
  onGenerateRemaining: () => void;
  onEditPlan: () => void;
}

export default function LayerPipeline(props: LayerPipelineProps) {
  const { map, activeLayer, visible, busyLayers } = props;
  const planned = plannedLayers(map);
  const omitted = 8 - planned.length;
  return (
    <div className="section">
      <div className="row" style={{ alignItems: 'baseline' }}>
        <h2 style={{ flex: 1 }}>Layers</h2>
        <button className="tiny" onClick={props.onEditPlan} title="Choose which layers this map has">
          plan{omitted > 0 ? ` (${omitted} left out)` : ''}
        </button>
      </div>
      <div className="row layer-batch-controls">
        <button
          className="tiny grow"
          disabled={busyLayers.size > 0 || planned.every((id) => map.layers[id].data)}
          onClick={props.onGenerateRemaining}
        >
          generate empty layers
        </button>
        <label title="Maximum layer requests run at the same time">
          at once
          <select
            value={props.concurrency}
            disabled={busyLayers.size > 0}
            onChange={(event) => props.onConcurrencyChange(Number(event.target.value))}
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
          </select>
        </label>
      </div>
      {planned.map((id) => {
        const meta = LAYER_META[id];
        const layer = map.layers[id];
        const unlocked = isUnlocked(map, id);
        const staleness = stalenessOf(map, id);
        const missing = missingRequirements(map, id);
        const gaps = excludedInfluences(map, id);
        return (
          <div
            key={id}
            className={[
              'layer-row',
              id === activeLayer ? 'active' : '',
              unlocked ? '' : 'locked',
            ].join(' ')}
            onClick={() => unlocked && props.onSelect(id)}
            title={
              unlocked
                ? meta.blurb
                : `Needs ${missing.map((m) => LAYER_META[m].label).join(', ')} first`
            }
          >
            <input
              type="checkbox"
              checked={visible[id]}
              disabled={!layer.data}
              onClick={(e) => e.stopPropagation()}
              onChange={() => props.onToggleVisible(id)}
              title="Show this layer on the map"
            />
            <span className="name">
              <b>{meta.label}</b>
              <small>
                {layer.data
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
            {layer.data ? (
              <span className={`badge ${staleness.stale ? 'stale' : 'ok'}`}>
                {staleness.stale ? 'stale' : 'ready'}
              </span>
            ) : (
              <span className="badge empty">empty</span>
            )}
            <button
              className="tiny"
              disabled={!unlocked || busyLayers.has(id)}
              onClick={(e) => {
                e.stopPropagation();
                props.onGenerate(id);
              }}
              title={layer.data ? 'Regenerate this layer from scratch' : 'Generate this layer'}
            >
              {busyLayers.has(id) ? '…' : layer.data ? 'regen' : 'generate'}
            </button>
          </div>
        );
      })}
    </div>
  );
}
