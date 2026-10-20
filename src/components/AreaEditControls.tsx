import { hexCount } from './selectionText.js';

/** Shared selection/extent controls for named areas in every manual editor. */
export default function AreaEditControls(props: {
  label: string;
  selected: number[];
  hexes: number[];
  eligible: (i: number) => boolean;
  mode: 'select' | 'add' | 'remove';
  setMode: (mode: 'select' | 'add' | 'remove') => void;
  onAdd: (indices: number[]) => void;
  onRemove: (indices: number[]) => void;
}) {
  const current = new Set(props.hexes);
  const eligible = props.selected.filter(props.eligible);
  const add = eligible.filter(i => !current.has(i));
  const remove = props.selected.filter(i => current.has(i));
  return <div className="area-edit-controls stack">
    <div className="geo-modes" role="group" aria-label={`Edit ${props.label} area`}>
      {(['select', 'add', 'remove'] as const).map(mode => <button key={mode} aria-pressed={props.mode === mode} onClick={() => props.setMode(mode)}>
        {mode === 'select' ? 'Select hexes' : mode === 'add' ? '+ Add to area' : '− Remove from area'}
      </button>)}
    </div>
    <p className="hint">{props.mode === 'select' ? 'Select hexes, then apply them below.' : `Click or drag on the map to ${props.mode} hexes. Changes apply on release.`}</p>
    <div className="geo-selection-summary"><b>{hexCount(props.selected.length)} selected</b><span>{eligible.length} eligible · {props.selected.length - eligible.length} excluded</span></div>
    <div className="geo-actions">
      <button disabled={!add.length} onClick={() => props.onAdd(add)}>Add {add.length} to area</button>
      <button disabled={!remove.length} onClick={() => props.onRemove(remove)}>Remove {remove.length} from area</button>
    </div>
  </div>;
}
