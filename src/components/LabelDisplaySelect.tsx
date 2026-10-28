import { LABEL_DISPLAY_TEXT, type LabelDisplay } from '../../shared/types.js';

const ORDER: LabelDisplay[] = ['normal', 'priority', 'hidden'];

const TITLE =
  'Shown: placed as usual. Prioritised: placed ahead of the names it competes with, which keep clear of it or are left out. Hidden: not drawn.';

/** How one name is drawn on the map: as usual, prioritised, or hidden. */
export default function LabelDisplaySelect(props: {
  value: LabelDisplay;
  onChange: (display: LabelDisplay) => void;
  /** What the name belongs to, for the accessible label. */
  of: string;
  className?: string;
}) {
  return (
    <select
      className={props.className}
      aria-label={`Map label of ${props.of}`}
      title={TITLE}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value as LabelDisplay)}
    >
      {ORDER.map((d) => (
        <option key={d} value={d}>Label: {LABEL_DISPLAY_TEXT[d]}</option>
      ))}
    </select>
  );
}
