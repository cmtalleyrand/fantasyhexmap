import { useState } from 'react';
import { LAYER_META, plannedLayers } from '../../shared/layers.js';
import { type LayerId, type MapState } from '../../shared/types.js';
import { exportComposite, exportLayer } from '../render/export.js';
import type { PolityNameMin } from '../render/labels.js';
import { DEFAULT_LEGEND_OPTIONS, legendLayers } from '../render/legend.js';
import type { VisibleLayers } from '../render/scene.js';

function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 12 }}>
      <input
        type="checkbox"
        style={{ width: 'auto' }}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      {children}
    </label>
  );
}

export default function ExportPanel({
  map,
  visible,
  elevationStyle,
  polityOpacity,
  uniformLand,
  riverNames: initialRiverNames,
  rangeNames: initialRangeNames,
  polityNames,
}: {
  map: MapState;
  visible: VisibleLayers;
  elevationStyle: 'colour' | 'contours';
  polityOpacity: number;
  uniformLand: boolean;
  riverNames: boolean;
  rangeNames: boolean;
  polityNames: PolityNameMin;
}) {
  const [format, setFormat] = useState<'png' | 'svg'>('png');
  const [labels, setLabels] = useState(true);
  const [riverNames, setRiverNames] = useState(initialRiverNames);
  const [rangeNames, setRangeNames] = useState(initialRangeNames);
  const [scale, setScale] = useState('2');
  const [legend, setLegend] = useState(false);
  const [legendTitle, setLegendTitle] = useState(DEFAULT_LEGEND_OPTIONS.title);
  const [onlyUsed, setOnlyUsed] = useState(DEFAULT_LEGEND_OPTIONS.onlyUsed);
  const [polityAreas, setPolityAreas] = useState(DEFAULT_LEGEND_OPTIONS.polityAreas);
  // Stored as exclusions so a layer switched on later is in the legend by default.
  const [legendExclude, setLegendExclude] = useState<LayerId[]>([]);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<void>) => {
    setError(null);
    fn().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const opts = {
    format,
    labels,
    size: 32,
    scale: Number(scale) || 2,
    elevationStyle,
    polityOpacity,
    uniformLand,
    polityNames,
    legend: legend
      ? { exclude: legendExclude, onlyUsed, polityAreas, title: legendTitle }
      : null,
  };

  const legendChoices = legendLayers(map, visible, elevationStyle);

  const planned = plannedLayers(map);
  const visibleCount = planned.filter((id) => visible[id] && map.layers[id].data).length;

  return (
    <div className="section">
      <h2>Export image</h2>
      <div className="stack">
        <div className="row">
          <select value={format} onChange={(e) => setFormat(e.target.value as 'png' | 'svg')}>
            <option value="png">PNG (raster)</option>
            <option value="svg">SVG (vector)</option>
          </select>
          {format === 'png' && (
            <select value={scale} onChange={(e) => setScale(e.target.value)} style={{ width: 80 }}>
              <option value="1">1×</option>
              <option value="2">2×</option>
              <option value="4">4×</option>
            </select>
          )}
        </div>
        <Check checked={labels} onChange={setLabels}>
          Render city and polity name labels
        </Check>
        <Check checked={riverNames} onChange={setRiverNames}>
          Render river names
        </Check>
        <Check checked={rangeNames} onChange={setRangeNames}>
          Render mountain range names
        </Check>

        <Check checked={legend} onChange={setLegend}>
          Include a legend
        </Check>
        {legend && (
          <div className="stack" style={{ paddingLeft: 20 }}>
            <Check checked={legendTitle} onChange={setLegendTitle}>
              Map name as legend title
            </Check>
            <Check checked={onlyUsed} onChange={setOnlyUsed}>
              Only values that appear on the map
            </Check>
            {legendChoices.includes('polities') && (
              <Check checked={polityAreas} onChange={setPolityAreas}>
                Polity land areas
              </Check>
            )}
            <div>
              <label>Legend sections</label>
              {legendChoices.length === 0 ? (
                <p className="hint">Nothing visible has data to describe.</p>
              ) : (
                legendChoices.map((id) => (
                  <Check
                    key={id}
                    checked={!legendExclude.includes(id)}
                    onChange={(on) =>
                      setLegendExclude((prev) =>
                        on ? prev.filter((x) => x !== id) : [...prev, id],
                      )
                    }
                  >
                    {LAYER_META[id].label}
                  </Check>
                ))
              )}
              <p className="hint" style={{ marginTop: 4 }}>
                Sections follow the layers shown on the map. Single-layer exports get a legend for
                that layer and its base geography.
              </p>
            </div>
          </div>
        )}

        <button
          className="primary"
          disabled={visibleCount === 0}
          onClick={() => run(() => exportComposite(map, visible, { ...opts, labels, riverNames, rangeNames }))}
        >
          Export composite ({visibleCount} visible layer{visibleCount === 1 ? '' : 's'})
        </button>

        <div>
          <label>Single layer</label>
          <div className="stack">
            {planned
              .filter((id) => map.layers[id].data)
              .map((id: LayerId) => (
                <button
                  key={id}
                  onClick={() =>
                    run(() =>
                      exportLayer(map, id, {
                        ...opts,
                        labels: labels && (id === 'cities' || id === 'polities'),
                        riverNames: riverNames && id === 'rivers',
                        rangeNames: rangeNames && id === 'elevation',
                      }),
                    )
                  }
                >
                  {LAYER_META[id].label}
                </button>
              ))}
          </div>
          <p className="hint" style={{ marginTop: 4 }}>
            Single-layer exports keep the base geography as a substrate so land-only layers are
            readable, and drop labels unless the layer is cities or polities (river and range names go with their own layers).
          </p>
        </div>

        {error && <div className="notice error">{error}</div>}
      </div>
    </div>
  );
}
