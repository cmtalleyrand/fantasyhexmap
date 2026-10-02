import { useState } from 'react';
import { LAYER_META, plannedLayers } from '../../shared/layers.js';
import { type LayerId, type MapState } from '../../shared/types.js';
import { exportComposite, exportLayer } from '../render/export.js';
import type { VisibleLayers } from '../render/scene.js';

export default function ExportPanel({
  map,
  visible,
  elevationStyle,
  polityOpacity,
  uniformLand,
  riverNames: initialRiverNames,
  rangeNames: initialRangeNames,
}: {
  map: MapState;
  visible: VisibleLayers;
  elevationStyle: 'colour' | 'contours';
  polityOpacity: number;
  uniformLand: boolean;
  riverNames: boolean;
  rangeNames: boolean;
}) {
  const [format, setFormat] = useState<'png' | 'svg'>('png');
  const [labels, setLabels] = useState(true);
  const [riverNames, setRiverNames] = useState(initialRiverNames);
  const [rangeNames, setRangeNames] = useState(initialRangeNames);
  const [scale, setScale] = useState('2');
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
  };

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
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 12 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={labels}
            onChange={(e) => setLabels(e.target.checked)}
          />
          Render city and polity name labels
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 12 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={riverNames}
            onChange={(e) => setRiverNames(e.target.checked)}
          />
          Render river names
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 12 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={rangeNames}
            onChange={(e) => setRangeNames(e.target.checked)}
          />
          Render mountain range names
        </label>

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
