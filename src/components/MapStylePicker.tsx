import {
  KNOB_OPTIONS,
  KNOB_ORDER,
  PRESET_ORDER,
  PRESETS,
  resolveStyle,
  withKnob,
  type KnobId,
  type MapStyleChoice,
  type StyleKnobs,
} from '../render/styles.js';

/**
 * Choose a map style: a preset, then any single knob changed from it. A knob
 * that differs from the preset is marked, and can be put back on its own or
 * along with all the others.
 */
export default function MapStylePicker({
  value,
  onChange,
}: {
  value: MapStyleChoice;
  onChange: (next: MapStyleChoice) => void;
}) {
  const resolved = resolveStyle(value);
  const preset = PRESETS[value.preset];
  const changed = Object.keys(value.overrides).length;

  return (
    <div className="stack">
      <div className="segmented" role="radiogroup" aria-label="Map style preset">
        {PRESET_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={value.preset === id}
            className={value.preset === id ? 'seg active' : 'seg'}
            // Switching preset keeps the knobs the user changed on purpose.
            onClick={() => onChange({ preset: id, overrides: value.overrides })}
          >
            {PRESETS[id].label}
          </button>
        ))}
      </div>
      <p className="hint">{preset.description}.</p>

      <div className="style-knobs">
        {KNOB_ORDER.map((knob) => (
          <Knob
            key={knob}
            knob={knob}
            current={resolved.knobs[knob]}
            presetValue={preset.knobs[knob]}
            onPick={(v) => onChange(withKnob(value, knob, v as never))}
          />
        ))}
      </div>
      {changed > 0 && (
        <div className="row">
          <span className="hint">
            {changed} setting{changed === 1 ? '' : 's'} changed from {preset.label}.
          </span>
          <button type="button" onClick={() => onChange({ preset: value.preset, overrides: {} })}>
            Reset to preset
          </button>
        </div>
      )}
    </div>
  );
}

function Knob<K extends KnobId>({
  knob,
  current,
  presetValue,
  onPick,
}: {
  knob: K;
  current: StyleKnobs[K];
  presetValue: StyleKnobs[K];
  onPick: (value: StyleKnobs[K]) => void;
}) {
  const { label, options } = KNOB_OPTIONS[knob];
  const overridden = current !== presetValue;
  return (
    <div className="style-knob">
      <label>
        {label}
        {overridden && (
          <span className="knob-changed" title="Changed from the preset">
            {' '}• changed
          </span>
        )}
      </label>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {(options as Array<{ value: StyleKnobs[K]; label: string }>).map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="radio"
            aria-checked={current === o.value}
            className={current === o.value ? 'seg active' : 'seg'}
            title={o.value === presetValue ? 'The preset’s choice' : undefined}
            onClick={() => onPick(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
