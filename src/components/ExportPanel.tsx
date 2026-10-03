import { useState } from 'react';
import { LAYER_META, plannedLayers } from '../../shared/layers.js';
import { type LayerId, type MapState } from '../../shared/types.js';
import type { AuditIssue } from '../render/audit.js';
import { auditExport, exportComposite, exportLayer } from '../render/export.js';
import type { PolityNameMin } from '../render/labels.js';
import { DEFAULT_LEGEND_OPTIONS, legendLayers } from '../render/legend.js';
import type { MarginaliaOptions } from '../render/marginalia.js';
import type { VisibleLayers } from '../render/scene.js';
import type { ElevationStyle, MapStyle } from '../render/styles.js';

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

/**
 * Image export. It opens from the File menu, and its label options start from
 * the current display settings each time it opens, so what is exported matches
 * what is on screen unless changed here.
 */
export default function ExportPanel({
  map,
  visible,
  labels: initialLabels,
  elevationStyle,
  polityOpacity,
  mapStyle,
  riverNames: initialRiverNames,
  rangeNames: initialRangeNames,
  seaNames: initialSeaNames,
  landNames: initialLandNames,
  polityNames,
  cityStateMax,
}: {
  map: MapState;
  visible: VisibleLayers;
  labels: boolean;
  elevationStyle: ElevationStyle;
  polityOpacity: number;
  mapStyle: MapStyle;
  riverNames: boolean;
  rangeNames: boolean;
  seaNames: boolean;
  landNames: boolean;
  polityNames: PolityNameMin;
  cityStateMax: number;
}) {
  const [format, setFormat] = useState<'png' | 'svg'>('png');
  const [labels, setLabels] = useState(initialLabels);
  const [riverNames, setRiverNames] = useState(initialRiverNames);
  const [rangeNames, setRangeNames] = useState(initialRangeNames);
  const [seaNames, setSeaNames] = useState(initialSeaNames);
  const [landNames, setLandNames] = useState(initialLandNames);
  const [scale, setScale] = useState('2');
  const [legend, setLegend] = useState(false);
  const [legendTitle, setLegendTitle] = useState(DEFAULT_LEGEND_OPTIONS.title);
  const [onlyUsed, setOnlyUsed] = useState(DEFAULT_LEGEND_OPTIONS.onlyUsed);
  const [polityAreas, setPolityAreas] = useState(DEFAULT_LEGEND_OPTIONS.polityAreas);
  const [riverLengths, setRiverLengths] = useState(DEFAULT_LEGEND_OPTIONS.riverLengths);
  // Stored as exclusions so a layer switched on later is in the legend by default.
  const [legendExclude, setLegendExclude] = useState<LayerId[]>([]);
  // Off to begin with, so an export is the bare map until furniture is asked for.
  const [furniture, setFurniture] = useState<MarginaliaOptions>({ frame: false, title: false, scaleBar: false, compass: false });
  const [overlaps, setOverlaps] = useState<AuditIssue[] | null>(null);
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
    polityOpacity,
    style: mapStyle,
    polityNames,
    cityStateMax,
    legend: legend
      ? { exclude: legendExclude, onlyUsed, polityAreas, riverLengths, title: legendTitle }
      : null,
    marginalia: Object.values(furniture).some(Boolean) ? furniture : null,
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
        <Check checked={seaNames} onChange={setSeaNames}>
          Render sea and lake names
        </Check>
        <Check checked={landNames} onChange={setLandNames}>
          Render land feature and island names
        </Check>

        <div>
          <label>Map furniture</label>
          <div className="stack">
            <Check checked={furniture.frame} onChange={(on) => setFurniture({ ...furniture, frame: on })}>
              Frame (double rule and margin band)
            </Check>
            <Check checked={furniture.title} onChange={(on) => setFurniture({ ...furniture, title: on })}>
              Map name as a title
            </Check>
            <Check checked={furniture.scaleBar} onChange={(on) => setFurniture({ ...furniture, scaleBar: on })}>
              Scale bar (from the width of one hex)
            </Check>
            <Check checked={furniture.compass} onChange={(on) => setFurniture({ ...furniture, compass: on })}>
              Compass rose
            </Check>
          </div>
          <p className="hint" style={{ marginTop: 4 }}>
            Each piece is set in open sea clear of land, names and the legend, or in the margin band when the sea has no room.
          </p>
        </div>

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
            {legendChoices.includes('rivers') && (
              <Check checked={riverLengths} onChange={setRiverLengths}>
                River lengths
              </Check>
            )}
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
          onClick={() => run(() => exportComposite(map, visible, { ...opts, labels, riverNames, rangeNames, seaNames, landNames }))}
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
                        seaNames: seaNames && id === 'base',
                        landNames: landNames && id === 'base',
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

        <div>
          <button
            onClick={() =>
              run(async () => {
                setOverlaps(null);
                setOverlaps(await auditExport(map, visible, { ...opts, labels, riverNames, rangeNames, seaNames, landNames }));
              })
            }
          >
            Check names for overlaps
          </button>
          {overlaps && (
            <div className={overlaps.length === 0 ? 'hint' : 'notice warn'} style={{ marginTop: 4 }}>
              {overlaps.length === 0 ? (
                'No overlaps among the names and map furniture of this export.'
              ) : (
                <>
                  {overlaps.length} overlap{overlaps.length === 1 ? '' : 's'}:
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                    {overlaps.slice(0, 12).map((o, i) => (
                      <li key={i}>{o.message}</li>
                    ))}
                    {overlaps.length > 12 && <li>and {overlaps.length - 12} more</li>}
                  </ul>
                </>
              )}
            </div>
          )}
        </div>

        {error && <div className="notice error">{error}</div>}
      </div>
    </div>
  );
}
