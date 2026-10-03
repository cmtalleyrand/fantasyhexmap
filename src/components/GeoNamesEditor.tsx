import { useMemo, useState } from 'react';
import {
  GEO_KIND_LABEL,
  GEO_NAME_KINDS,
  geoEligibility,
  geoNamesOf,
  liveHexes,
} from '../../shared/geoNames.js';
import type { GeoNameKind, MapState } from '../../shared/types.js';
import type { Action } from '../state/store.js';
import CommitInput from './CommitInput.js';

/**
 * Name seas, lakes, land features and islands, and edit the names already
 * given: rename one, add the selected hexes to it, take them out, or remove it.
 * Each kind accepts only the hexes it can name (see `geoEligibility`), so the
 * selection is filtered to them, and the count shown says how many were.
 */
export default function GeoNamesEditor(props: {
  map: MapState;
  dispatch: (action: Action) => void;
  selected: number[];
  setSelection: (next: Set<number>) => void;
}) {
  const { map, dispatch, selected } = props;
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

  const create = () => {
    const trimmed = name.trim();
    if (!trimmed || picked.length === 0) return;
    dispatch({
      type: 'nameGeo',
      id: `geo_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      kind,
      name: trimmed,
      indices: picked,
    });
    setName('');
  };

  return (
    <div className="section">
      <h2>Name places</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Select hexes on the map, then name them. Each kind takes only its own hexes. Turn names on in
        Settings → Display.
      </p>
      <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
        {GEO_NAME_KINDS.map((k) => (
          <button key={k} className={k === kind ? 'tiny primary' : 'tiny'} onClick={() => setKind(k)}>
            {GEO_KIND_LABEL[k].plural}
          </button>
        ))}
      </div>
      <p className="hint">{label.singular}s take: {label.accepts}</p>

      <div className="stack">
        <input
          placeholder={`New ${label.singular.toLowerCase()} name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && create()}
        />
        <button className="primary" disabled={picked.length === 0 || name.trim().length === 0} onClick={create}>
          Name {picked.length} selected hex{picked.length === 1 ? '' : 'es'} as a {label.singular.toLowerCase()}
        </button>
        {selected.length > picked.length && (
          <p className="hint" style={{ margin: 0 }}>
            {selected.length - picked.length} selected hex{selected.length - picked.length === 1 ? ' is' : 'es are'} not
            eligible and {selected.length - picked.length === 1 ? 'is' : 'are'} ignored.
          </p>
        )}
      </div>

      <div className="list" style={{ marginTop: 8 }}>
        {names.map((n) => {
          const live = liveHexes(n, eligible);
          const inName = new Set(n.hexes);
          const addable = picked.filter((i) => !inName.has(i));
          const removable = selected.filter((i) => inName.has(i));
          return (
            <div key={n.id} className="entry" style={{ flexWrap: 'wrap' }}>
              <CommitInput
                className="grow"
                aria-label={`${label.singular} name`}
                value={n.name}
                onCommit={(next) => dispatch({ type: 'renameGeo', id: n.id, name: next })}
              />
              <span className="hint" title={live.length < n.hexes.length ? 'Some hexes no longer qualify and are not drawn' : undefined}>
                {live.length === n.hexes.length ? `${n.hexes.length} hexes` : `${live.length} of ${n.hexes.length} hexes`}
              </span>
              <button className="tiny" title="Select this name's hexes" onClick={() => props.setSelection(new Set(live))}>
                select
              </button>
              <button
                className="tiny"
                disabled={addable.length === 0}
                title="Add the selected eligible hexes to this name"
                onClick={() => dispatch({ type: 'nameGeo', id: n.id, kind, name: n.name, indices: addable })}
              >
                + {addable.length}
              </button>
              <button
                className="tiny"
                disabled={removable.length === 0}
                title="Take the selected hexes out of this name"
                onClick={() => dispatch({ type: 'unnameGeoHexes', id: n.id, indices: removable })}
              >
                − {removable.length}
              </button>
              <button className="tiny danger" title="Remove this name" onClick={() => dispatch({ type: 'removeGeo', id: n.id })}>
                ×
              </button>
            </div>
          );
        })}
      </div>
      {names.length === 0 && <p className="hint">No {label.plural.toLowerCase()} named yet.</p>}
    </div>
  );
}
