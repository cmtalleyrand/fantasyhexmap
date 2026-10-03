import { MAX_DIM, type MapState } from '../../shared/types.js';
import { growPlan, type GrowAmounts } from '../state/store.js';
import Modal from './Modal.js';

/**
 * Add rows and columns around the map: one or two on any single side, or one or
 * two on both sides of an axis at once. The new hexes are inferred from their
 * neighbours; nothing already on the map moves relative to anything else.
 */
export default function ResizeMapDialog({
  map,
  onGrow,
  onClose,
}: {
  map: MapState;
  onGrow: (amounts: GrowAmounts) => void;
  onClose: () => void;
}) {
  const fits = (amounts: GrowAmounts) => growPlan(map, amounts).fits;
  const button = (label: string, amounts: GrowAmounts, title: string) => (
    <button className="tiny" disabled={!fits(amounts)} onClick={() => onGrow(amounts)} title={title}>
      {label}
    </button>
  );
  const side = (name: string, key: keyof GrowAmounts, noun: string) => (
    <>
      <span>{name}</span>
      {button(`+1 ${noun}`, { [key]: 1 }, `Add one ${noun} at the ${name.toLowerCase()}`)}
      {button(`+2 ${noun}s`, { [key]: 2 }, `Add two ${noun}s at the ${name.toLowerCase()}`)}
    </>
  );
  return (
    <Modal label="Resize map" onClose={onClose}>
      <h2 style={{ marginTop: 0 }}>Resize map</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Now {map.cols} × {map.rows} hexes (at most {MAX_DIM} each way). New hexes copy their neighbours.
      </p>
      <div className="resize-grid">
        {side('Top', 'top', 'row')}
        {side('Bottom', 'bottom', 'row')}
        {side('Left', 'left', 'column')}
        {side('Right', 'right', 'column')}
        <span>Rows, both sides</span>
        {button('+1 each', { top: 1, bottom: 1 }, 'Add one row at the top and one at the bottom')}
        {button('+2 each', { top: 2, bottom: 2 }, 'Add two rows at the top and two at the bottom')}
        <span>Columns, both sides</span>
        {button('+1 each', { left: 1, right: 1 }, 'Add one column on the left and one on the right')}
        {button('+2 each', { left: 2, right: 2 }, 'Add two columns on the left and two on the right')}
      </div>
      <p className="hint">
        The grid is offset: odd rows sit half a hex east. A single row at the top would slide the whole
        map half a hex, so it is added by shifting the map and also adds one column. Two rows at the top
        add nothing extra.
      </p>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button onClick={onClose}>close</button>
      </div>
    </Modal>
  );
}
