import { useEffect, useState } from 'react';
import type { HexDimensions } from '../../shared/types.js';
import {
  isRegularHex,
  measuresFromWidth,
  regularHexSize,
  type HexMeasure,
} from '../../shared/surfaceArea.js';

const MEASURES: { id: HexMeasure; label: string; hint: string }[] = [
  { id: 'width', label: 'Width', hint: 'flat side to opposite flat side' },
  { id: 'corners', label: 'Corner to corner', hint: 'point to opposite point' },
  { id: 'side', label: 'Side length', hint: 'length of one edge' },
  { id: 'area', label: 'Area', hint: 'whole hex, in square units' },
];

const UNITS = ['km', 'mi', 'm', 'ft', 'yd', 'leagues'];
const CUSTOM = '__custom';
const LAND_PERCENT_OPTIONS = Array.from({ length: 21 }, (_, index) => index * 5);

/** The land share of each shaped type, as (field, label) for the settings below. */
const LAND_SHARES: Array<[keyof HexDimensions, string]> = [
  ['coastalLandPercent', 'Coastal land'],
  ['largeIslandPercent', 'Each large island'],
  ['smallIslandPercent', 'Each small island'],
  ['mainlandPercent', 'Mainland (with islands)'],
  ['isthmusPercent', 'Isthmus'],
  ['straitPercent', 'Strait'],
  ['glacierPercent', 'Glacier'],
];

const fmt = (n: number) =>
  Number.isFinite(n) ? Number(n.toPrecision(4)).toLocaleString(undefined, { maximumFractionDigits: 4 }) : '-';

/**
 * Edits the real-world size of one pointy-top hex. A regular hex is fully
 * determined by any one measurement, so the user supplies just one and the rest
 * are derived and shown. Maps saved with an irregular width/height pair keep
 * them until the user opts to edit both or snaps them back to a regular hex.
 */
export default function HexSizeInput({
  value,
  onChange,
}: {
  value: HexDimensions;
  onChange: (next: HexDimensions) => void;
}) {
  const [measure, setMeasure] = useState<HexMeasure>('width');
  const [advanced, setAdvanced] = useState(false);
  const regular = isRegularHex(value);
  const measures = measuresFromWidth(value.width);

  const shown = (m: HexMeasure) => String(Number(measures[m].toPrecision(6)));
  const [text, setText] = useState(shown('width'));
  const [heightText, setHeightText] = useState(String(Number(value.height.toPrecision(6))));
  const [unitText, setUnitText] = useState(value.unit);
  const customUnit = !UNITS.includes(value.unit);
  const [customOpen, setCustomOpen] = useState(customUnit);

  // Re-sync the text boxes when the stored value changes from outside.
  useEffect(() => {
    setText(shown(measure));
    setHeightText(String(Number(value.height.toPrecision(6))));
    setUnitText(value.unit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.width, value.height, value.unit, measure]);

  const commitMeasure = (raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      setText(shown(measure));
      return;
    }
    onChange({ ...value, ...regularHexSize(measure, n) });
  };

  const commitPair = (field: 'width' | 'height', raw: string) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      setHeightText(String(Number(value.height.toPrecision(6))));
      return;
    }
    onChange({ ...value, [field]: n });
  };

  const unit = value.unit;
  const unitLabel = measure === 'area' ? `${unit}²` : unit;
  const showAdvanced = advanced || !regular;

  return (
    <div className="hexsize">
      <div className="field">
        <label>I know the hex's…</label>
        <div className="segmented" role="radiogroup" aria-label="Hex measurement">
          {MEASURES.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={measure === m.id}
              className={measure === m.id ? 'seg active' : 'seg'}
              onClick={() => setMeasure(m.id)}
              title={m.hint}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div className="row hexsize-entry">
        <div className="grow">
          <input
            aria-label={`Hex ${measure}`}
            type="number"
            min="0.01"
            step="any"
            value={text}
            disabled={!regular}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => commitMeasure(text)}
            onKeyDown={(e) => e.key === 'Enter' && commitMeasure(text)}
          />
        </div>
        <div style={{ width: 120 }}>
          <select
            aria-label="Distance unit"
            value={customOpen || customUnit ? CUSTOM : unit}
            onChange={(e) => {
              if (e.target.value === CUSTOM) setCustomOpen(true);
              else {
                setCustomOpen(false);
                onChange({ ...value, unit: e.target.value });
              }
            }}
          >
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
            <option value={CUSTOM}>custom…</option>
          </select>
        </div>
        {(customOpen || customUnit) && (
          <div style={{ width: 100 }}>
            <input
              aria-label="Custom unit"
              placeholder="unit"
              maxLength={12}
              value={unitText}
              onChange={(e) => setUnitText(e.target.value)}
              onBlur={() => {
                const next = unitText.trim() || 'km';
                setUnitText(next);
                onChange({ ...value, unit: next });
              }}
            />
          </div>
        )}
      </div>
      <p className="hint">
        {MEASURES.find((m) => m.id === measure)?.hint} ({unitLabel}).
      </p>

      <dl className="derived">
        <div>
          <dt>Width</dt>
          <dd>{fmt(value.width)} {unit}</dd>
        </div>
        <div>
          <dt>Corner to corner</dt>
          <dd>{fmt(value.height)} {unit}</dd>
        </div>
        <div>
          <dt>Side</dt>
          <dd>{fmt(measures.side)} {unit}</dd>
        </div>
        <div>
          <dt>Area</dt>
          <dd>{fmt(0.75 * value.width * value.height)} {unit}²</dd>
        </div>
      </dl>

      {!regular && (
        <div className="notice warn">
          This map uses an irregular hex (width and corner-to-corner are not in the 1 : 1.155 ratio
          of a regular hexagon).{' '}
          <button
            type="button"
            className="tiny"
            onClick={() => onChange({ ...value, ...regularHexSize('width', value.width) })}
          >
            make regular (keep width)
          </button>
        </div>
      )}

      <button type="button" className="linkish" onClick={() => setAdvanced(!advanced)}>
        {showAdvanced ? 'hide' : 'advanced:'} set width and corner-to-corner separately
      </button>
      {showAdvanced && (
        <div className="row" style={{ marginTop: 8 }}>
          <div className="grow">
            <label>Width (flat to flat)</label>
            <input
              type="number"
              min="0.01"
              step="any"
              aria-label="Hex width flat to flat"
              value={String(Number(value.width.toPrecision(6)))}
              onChange={(e) => onChange({ ...value, width: Number(e.target.value) || value.width })}
            />
          </div>
          <div className="grow">
            <label>Corner to corner</label>
            <input
              type="number"
              min="0.01"
              step="any"
              aria-label="Hex height corner to corner"
              value={heightText}
              onChange={(e) => setHeightText(e.target.value)}
              onBlur={() => commitPair('height', heightText)}
            />
          </div>
        </div>
      )}

      <h3>Land share of shaped hexes</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
        {LAND_SHARES.map(([field, label]) => (
          <div key={field}>
            <label>{label}</label>
            <select
              aria-label={`${label} land percentage`}
              value={value[field] as number}
              onChange={(e) => onChange({ ...value, [field]: Number(e.target.value) })}
            >
              {LAND_PERCENT_OPTIONS.map((p) => (
                <option key={p} value={p}>
                  {p}%
                </option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <p className="hint">Polity areas in the legend count this share of each such hex; an island hex adds up its islands. A single hex can override its own share in the sidebar.</p>

      <h3>Displayed measurement rounding</h3>
      <div className="row">
        <div className="grow">
          <label>Surface areas (in {unit}²)</label>
          <input
            aria-label="Surface area rounding"
            type="number"
            min="0.0000001"
            step="any"
            value={value.areaRounding}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next) && next > 0) onChange({ ...value, areaRounding: next });
            }}
          />
        </div>
        <div className="grow">
          <label>Lengths (in {unit})</label>
          <input
            aria-label="Length rounding"
            type="number"
            min="0.0000001"
            step="any"
            value={value.lengthRounding}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next) && next > 0) onChange({ ...value, lengthRounding: next });
            }}
          />
        </div>
      </div>
      <p className="hint">Displayed values are rounded to the nearest increment.</p>
    </div>
  );
}
