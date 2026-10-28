import { hexCount } from './selectionText.js';
import { useMemo, useState } from 'react';
import { GEO_KIND_LABEL, GEO_NAME_KINDS, geoEligibility, geoNamesOf, liveHexes } from '../../shared/geoNames.js';
import { formatArea, geoNameSurfaceAreas, normaliseHexDimensions } from '../../shared/surfaceArea.js';
import { geoNameDisplay, type GeoNameKind, type MapState } from '../../shared/types.js';
import type { Action } from '../state/store.js';
import AreaEditControls from './AreaEditControls.js';
import CommitInput from './CommitInput.js';
import LabelDisplaySelect from './LabelDisplaySelect.js';

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
  const areas = useMemo(() => new Map(geoNameSurfaceAreas(map).map((a) => [a.id, a.area])), [map]);
  const dimensions = normaliseHexDimensions(map.hexDimensions);
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
          <b>{hexCount(selected.length)} selected</b>
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
          const isActive = n.id === paintId;
          return (
            <article key={n.id} className={`geo-card ${isActive ? 'active' : ''}`} aria-label={n.name}>
              <button className="geo-title" aria-pressed={isActive} onClick={() => choose(n.id)}>{n.name}</button>
              <div className="geo-area">{isActive && <span className="area-key" />}Current area: <b>{hexCount(live.length)}</b> · {formatArea(areas.get(n.id) ?? 0, dimensions.unit, dimensions.areaRounding)} of {kind === 'sea' || kind === 'lake' ? 'water' : 'land'}{isActive && <span className="geo-badge">Active</span>}</div>
              {live.length < n.hexes.length && <details className="geo-help geo-excluded">
                <summary>{n.hexes.length - live.length} assigned hex{n.hexes.length - live.length === 1 ? '' : 'es'} excluded</summary>
                <p>{n.hexes.length} assigned in total. Excluded hexes no longer match this feature’s terrain and are not part of its displayed area.</p>
              </details>}
              {isActive && <>
                <AreaEditControls label={label.singular.toLowerCase()} selected={selected} hexes={n.hexes} eligible={eligible}
                  mode={editMode} setMode={props.setEditMode}
                  onAdd={indices => dispatch({ type: 'nameGeo', id: n.id, kind, name: n.name, indices })}
                  onRemove={indices => dispatch({ type: 'unnameGeoHexes', id: n.id, indices })} />
                <label htmlFor={`geo-name-${n.id}`}>Name</label>
                <CommitInput id={`geo-name-${n.id}`} aria-label={`${label.singular} name`} value={n.name}
                  onCommit={(next) => dispatch({ type: 'renameGeo', id: n.id, name: next })} />
              </>}
              <div className="geo-actions">
                <button onClick={() => { choose(n.id); props.setSelection(new Set(live)); }}>Select area</button>
                {!isActive && <button onClick={() => choose(n.id)}>Edit area</button>}
                <LabelDisplaySelect of={n.name} value={geoNameDisplay(n)}
                  onChange={(display) => dispatch({ type: 'setGeoNameDisplay', id: n.id, display })} />
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
