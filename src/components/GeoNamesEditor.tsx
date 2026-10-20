import { useMemo, useState } from 'react';
import { GEO_KIND_LABEL, GEO_NAME_KINDS, geoEligibility, geoNamesOf, liveHexes } from '../../shared/geoNames.js';
import type { GeoNameKind, MapState } from '../../shared/types.js';
import type { Action } from '../state/store.js';
import CommitInput from './CommitInput.js';

export default function GeoNamesEditor(props: {
  map: MapState;
  dispatch: (action: Action) => void;
  selected: number[];
  setSelection: (next: Set<number>) => void;
  /** Active feature, independently of the map's selection. */
  paintId: string | null;
  setPaintId: (id: string | null) => void;
  editMode: 'select' | 'add' | 'remove';
  setEditMode: (mode: 'select' | 'add' | 'remove') => void;
}) {
  const { map, dispatch, selected, paintId, editMode } = props;
  const [kind, setKind] = useState<GeoNameKind>('sea');
  const [name, setName] = useState('');
  const base = map.layers.base.data;
  const eligible = useMemo(
    () => (base ? geoEligibility(kind, base, map.cols, map.rows) : () => false),
    [base, kind, map.cols, map.rows],
  );
  const names = useMemo(() => geoNamesOf(map).filter((n) => n.kind === kind), [map, kind]);
  const picked = selected.filter(eligible);
  const label = GEO_KIND_LABEL[kind];
  const choose = (id: string) => props.setPaintId(id);
  const create = () => {
    if (!name.trim() || !picked.length) return;
    const id = `geo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    dispatch({ type: 'nameGeo', id, kind, name: name.trim(), indices: picked });
    props.setPaintId(id);
    props.setSelection(new Set());
    setName('');
  };

  return (
    <div className="section geo-editor">
      <h2>Name places</h2>
      <div className="geo-kinds" role="group" aria-label="Feature type">
        {GEO_NAME_KINDS.map((k) => (
          <button key={k} aria-pressed={k === kind} onClick={() => {
            setKind(k);
            props.setPaintId(null);
          }}>{GEO_KIND_LABEL[k].plural}</button>
        ))}
      </div>
      <details className="geo-help">
        <summary>Which hexes can belong to a {label.singular.toLowerCase()}?</summary>
        <p>{label.accepts}</p>
      </details>

      <div className="geo-create stack">
        <label htmlFor="new-geo-name">New {label.singular.toLowerCase()}</label>
        <input id="new-geo-name" placeholder="Feature name" value={name}
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
        <div className="geo-selection-summary" role="status">
          <b>{selected.length} hexes selected</b>
          {selected.length > 0 && <span>{picked.length} eligible · {selected.length - picked.length} excluded</span>}
        </div>
        <button className="primary" disabled={!picked.length || !name.trim()} onClick={create}>
          Create {label.singular.toLowerCase()}{picked.length > 0 ? ` with ${picked.length} hexes` : ''}
        </button>
        {!selected.length && <span className="hint">Select hexes on the map to create a feature.</span>}
      </div>


      <div className="geo-list">
        {names.map((n) => {
          const live = liveHexes(n, eligible);
          const inName = new Set(n.hexes);
          const addable = picked.filter((i) => !inName.has(i));
          const removable = selected.filter((i) => inName.has(i));
          const isActive = n.id === paintId;
          return (
            <article key={n.id} className={`geo-card ${isActive ? 'active' : ''}`} aria-label={n.name}>
              <button className="geo-title" aria-pressed={isActive} onClick={() => choose(n.id)}>{n.name}</button>
              <div className="geo-area">{isActive && <span className="area-key" />}Current area: <b>{live.length} hexes</b>{isActive && <span className="geo-badge">Active</span>}</div>
              {live.length < n.hexes.length && <details className="geo-help geo-excluded">
                <summary>{n.hexes.length - live.length} assigned hexes excluded</summary>
                <p>{n.hexes.length} assigned in total. Excluded hexes no longer match this feature’s terrain and are not part of its displayed area.</p>
              </details>}
              {isActive && <>
                <div className="geo-edit-tools">
                  <div className="geo-modes" role="group" aria-label="Edit feature area">
                    {(['select', 'add', 'remove'] as const).map((mode) => (
                      <button key={mode} aria-pressed={editMode === mode} onClick={() => props.setEditMode(mode)}>
                        {mode === 'select' ? 'Select hexes' : mode === 'add' ? '+ Add to area' : '− Remove from area'}
                      </button>
                    ))}
                  </div>
                  <p>{editMode === 'select' ? 'Select hexes, then apply them below.' : `Click or drag on the map to ${editMode === 'add' ? 'add eligible hexes' : 'remove hexes'}. Changes apply on release.`}</p>
                </div>
                <label htmlFor={`geo-name-${n.id}`}>Name</label>
                <CommitInput id={`geo-name-${n.id}`} aria-label={`${label.singular} name`} value={n.name}
                  onCommit={(next) => dispatch({ type: 'renameGeo', id: n.id, name: next })} />
                <div className="geo-batch">
                  <span>Apply selection · {selected.length} hexes</span>
                  <div className="geo-actions">
                    <button disabled={!addable.length} onClick={() => dispatch({ type: 'nameGeo', id: n.id, kind, name: n.name, indices: addable })}>Add {addable.length} to area</button>
                    <button disabled={!removable.length} onClick={() => dispatch({ type: 'unnameGeoHexes', id: n.id, indices: removable })}>Remove {removable.length} from area</button>
                  </div>
                </div>
              </>}
              <div className="geo-actions">
                <button onClick={() => { choose(n.id); props.setSelection(new Set(live)); }}>Select area</button>
                {!isActive && <button onClick={() => choose(n.id)}>Edit area</button>}
                <label className="check"><input type="checkbox" checked={!n.hidden}
                  onChange={(e) => dispatch({ type: 'setGeoNameHidden', id: n.id, hidden: !e.target.checked })} />Show label</label>
                {isActive && <button onClick={() => props.setPaintId(null)}>Done editing</button>}
                {isActive && <button className="danger" onClick={() => { dispatch({ type: 'removeGeo', id: n.id }); props.setPaintId(null); }}>Delete feature</button>}
              </div>
            </article>
          );
        })}
      </div>
      {!names.length && <p className="hint">No {label.plural.toLowerCase()} named yet.</p>}
    </div>
  );
}
