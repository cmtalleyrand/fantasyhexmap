import { useMemo, useState } from 'react';
import { LAYER_META } from '../../shared/layers.js';
import { LAYER_ORDER, type JournalEntry, type LayerId, type MapState } from '../../shared/types.js';
import { exportDecisions } from '../render/export.js';

const KIND_LABEL: Record<JournalEntry['kind'], string> = {
  generate: 'generated',
  instruct: 'rewritten on instruction',
  manual: 'edited by hand',
  undo: 'undone',
  redo: 'redone',
};

function when(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The record of how this map came to be: what the model decided and why, in its
 * own words, interleaved with the edits a person made. It is kept honest by
 * logging both - a reader can always tell which choices were the AI's.
 */
export default function DecisionLog({
  map,
  onClose,
  onSelectHexes,
}: {
  map: MapState;
  onClose: () => void;
  onSelectHexes: (indices: number[]) => void;
}) {
  const [layerFilter, setLayerFilter] = useState<LayerId | 'all'>('all');
  const [aiOnly, setAiOnly] = useState(true);

  const entries = useMemo(() => {
    const all = [...(map.journal ?? [])].reverse(); // newest first
    return all.filter(
      (e) =>
        (layerFilter === 'all' || e.layer === layerFilter) &&
        (!aiOnly || e.kind === 'generate' || e.kind === 'instruct'),
    );
  }, [map.journal, layerFilter, aiOnly]);

  const decisionCount = (map.journal ?? []).reduce((n, e) => n + e.decisions.length, 0);

  const jumpTo = (hexes: string[]) => {
    const indices = hexes
      .map((h) => {
        const [col, row] = h.split(',').map(Number);
        if (col === undefined || row === undefined) return -1;
        if (!Number.isFinite(col) || !Number.isFinite(row)) return -1;
        if (col < 0 || row < 0 || col >= map.cols || row >= map.rows) return -1;
        return row * map.cols + col;
      })
      .filter((i) => i >= 0);
    if (indices.length > 0) {
      onSelectHexes(indices);
      onClose();
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ alignItems: 'baseline' }}>
          <h2 style={{ marginBottom: 4 }}>How this map was decided</h2>
          <span className="grow" />
          <span className="hint">
            {decisionCount} decision{decisionCount === 1 ? '' : 's'} across{' '}
            {(map.journal ?? []).length} change{(map.journal ?? []).length === 1 ? '' : 's'}
          </span>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          What the model chose and why, as it reported at the time. Hand edits are listed too, so it
          is always clear which choices were not the AI's.
        </p>

        <div className="row" style={{ margin: '10px 0' }}>
          <select
            value={layerFilter}
            onChange={(e) => setLayerFilter(e.target.value as LayerId | 'all')}
            style={{ width: 200 }}
          >
            <option value="all">All layers</option>
            {LAYER_ORDER.map((id) => (
              <option key={id} value={id}>
                {LAYER_META[id].label}
              </option>
            ))}
          </select>
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 12, margin: 0 }}
          >
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={aiOnly}
              onChange={(e) => setAiOnly(e.target.checked)}
            />
            AI decisions only
          </label>
          <span className="grow" />
          <button className="tiny" onClick={() => exportDecisions(map, { aiOnly: false })}>
            export Markdown
          </button>
        </div>

        <div className="journal">
          {entries.length === 0 && (
            <p className="hint">
              Nothing recorded yet{aiOnly ? ' from the AI' : ''}. Generate a layer and its reasoning
              appears here.
            </p>
          )}
          {entries.map((entry) => (
            <div key={entry.id} className={`journal-entry ${entry.kind}`}>
              <div className="row" style={{ alignItems: 'baseline', gap: 6 }}>
                <b>{LAYER_META[entry.layer].label}</b>
                <span className="badge">{KIND_LABEL[entry.kind]}</span>
                <span className="grow" />
                <span className="hint">
                  {entry.model ? entry.model : entry.kind === 'manual' ? 'you' : 'offline generator'} ·{' '}
                  {when(entry.at)}
                </span>
              </div>

              {entry.instruction && (
                <div className="instruction">“{entry.instruction}”</div>
              )}
              {entry.summary && <p style={{ margin: '6px 0 0' }}>{entry.summary}</p>}

              {entry.decisions.length > 0 && (
                <ol className="decisions">
                  {entry.decisions.map((d, i) => (
                    <li key={i}>
                      <b>{d.title}</b>
                      {d.detail && <div>{d.detail}</div>}
                      {d.hexes && d.hexes.length > 0 && (
                        <button className="tiny" style={{ marginTop: 4 }} onClick={() => jumpTo(d.hexes!)}>
                          select {d.hexes.length} hex{d.hexes.length === 1 ? '' : 'es'}
                        </button>
                      )}
                    </li>
                  ))}
                </ol>
              )}

              {entry.warnings > 0 && (
                <p className="hint" style={{ marginBottom: 0 }}>
                  {entry.warnings} validation note{entry.warnings === 1 ? '' : 's'} were raised on this pass.
                </p>
              )}
            </div>
          ))}
        </div>

        <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
          <button onClick={onClose}>close</button>
        </div>
      </div>
    </div>
  );
}
