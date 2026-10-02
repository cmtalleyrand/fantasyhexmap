import { useEffect, useRef } from 'react';
import type { MapState } from '../../shared/types.js';
import { LAYER_ORDER } from '../../shared/types.js';
import { drawScene } from '../render/canvas.js';
import { buildStaticScene, type VisibleLayers } from '../render/scene.js';
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

const THUMB_WIDTH = 168;

/**
 * The open map drawn small in one preset, with the knobs the user changed
 * applied, so choosing a preset is choosing a picture rather than a name.
 */
function PresetThumb({ map, choice }: { map: MapState; choice: MapStyleChoice }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const visible = {} as VisibleLayers;
    // Show what a style changes most: land and water, height, rivers, realms.
    for (const id of LAYER_ORDER) visible[id] = map.layers[id].data !== null && id !== 'climate' && id !== 'population';
    const scene = buildStaticScene(map, { size: 8, visible, labels: false, style: resolveStyle(choice) });
    const scale = THUMB_WIDTH / scene.width;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(THUMB_WIDTH * dpr);
    canvas.height = Math.round(scene.height * scale * dpr);
    canvas.style.width = `${THUMB_WIDTH}px`;
    canvas.style.height = `${Math.round(scene.height * scale)}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    ctx.fillStyle = scene.background;
    ctx.fillRect(0, 0, scene.width, scene.height);
    drawScene(ctx, scene);
    // Keyed on the choice's content: a new object with the same settings draws nothing new.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, choice.preset, JSON.stringify(choice.overrides)]);
  return <canvas ref={ref} className="style-thumb" aria-hidden="true" />;
}

/**
 * Choose a map style: a preset, then any single knob changed from it. A knob
 * that differs from the preset is marked, and can be put back on its own or
 * along with all the others.
 */
export default function MapStylePicker({
  value,
  onChange,
  map,
}: {
  value: MapStyleChoice;
  onChange: (next: MapStyleChoice) => void;
  /** The open map, previewed in each preset; omitted on the create screen. */
  map?: MapState | null;
}) {
  const resolved = resolveStyle(value);
  const preset = PRESETS[value.preset];
  const changed = Object.keys(value.overrides).length;

  return (
    <div className="stack">
      <div className="style-presets" role="radiogroup" aria-label="Map style preset">
        {PRESET_ORDER.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={value.preset === id}
            className={value.preset === id ? 'style-preset active' : 'style-preset'}
            // Switching preset keeps the knobs the user changed on purpose.
            onClick={() => onChange({ preset: id, overrides: value.overrides })}
          >
            {map && map.layers.base.data && <PresetThumb map={map} choice={{ preset: id, overrides: value.overrides }} />}
            <span>{PRESETS[id].label}</span>
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
