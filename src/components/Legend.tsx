import {
  BASE_GEO_VALUES,
  CLIMATE_VALUES,
  ELEVATION_VALUES,
  VEGETATION_GROUPS,
  isIslandType,
  type BaseGeo,
  type LayerId,
  type VegetationGroup,
} from '../../shared/types.js';
import {
  BASE_COLOURS,
  CLIMATE_COLOURS,
  ELEVATION_COLOURS,
  ISLAND_DOT,
  MAP_COLOURS,
  POPULATION_LEGEND_RAMP,
  VEGETATION_COLOURS,
} from '../render/palette.js';
import type { MapState } from '../../shared/types.js';
import { formatArea, normaliseHexDimensions, politySurfaceAreas } from '../../shared/surfaceArea.js';

function Swatch({ colour, label }: { colour: string; label: string }) {
  return (
    <div className="item">
      <span className="swatch" style={{ background: colour }} />
      <span>{label}</span>
    </div>
  );
}

const ISLAND_NOTES: Partial<Record<BaseGeo, string>> = {
  Islands: 'sea holding one or two large islands and up to five small ones',
  'Mainland and islands': 'part of a mainland coast, with islands off it',
  Isthmus: 'a neck of land between two waters',
  Strait: 'a channel of water between two lands',
};

export default function Legend({ layer, map }: { layer: LayerId; map: MapState }) {
  switch (layer) {
    case 'base':
      return (
        <div className="legend">
          {BASE_GEO_VALUES.map((v) => (
            <Swatch
              key={v}
              colour={isIslandType(v) ? ISLAND_DOT : BASE_COLOURS[v]}
              label={ISLAND_NOTES[v] ? `${v} (${ISLAND_NOTES[v]})` : v}
            />
          ))}
        </div>
      );
    case 'elevation':
      return (
        <div className="legend">
          {ELEVATION_VALUES.map((v) => (
            <Swatch key={v} colour={ELEVATION_COLOURS[v]} label={v} />
          ))}
        </div>
      );
    case 'climate':
      return (
        <div className="legend">
          {CLIMATE_VALUES.map((v) => (
            <Swatch key={v} colour={CLIMATE_COLOURS[v]} label={v} />
          ))}
        </div>
      );
    case 'vegetation':
      return (
        <div className="stack">
          {(Object.keys(VEGETATION_GROUPS) as VegetationGroup[]).map((group) => (
            <div key={group}>
              <div className="hint">{group}</div>
              <div className="legend">
                {VEGETATION_GROUPS[group].map((v) => (
                  <Swatch key={v} colour={VEGETATION_COLOURS[v]} label={v} />
                ))}
              </div>
            </div>
          ))}
        </div>
      );
    case 'rivers':
      return (
        <div className="legend">
          <Swatch colour={MAP_COLOURS.river} label="Navigable" />
          <Swatch colour={MAP_COLOURS.riverNonNavigable} label="Not navigable" />
        </div>
      );
    case 'cities':
      return (
        <div className="hint">
          Symbols show population: circle ≤10k, ring 10k–50k, diamond 50k–250k, and castle &gt;250k.
          A blue centre means the city sits on a river; highlighted hex edges border Sea or Lake.
          With Cities selected, drag a symbol to move it.
        </div>
      );
    case 'polities': {
      const polities = map.layers.polities.data?.polities ?? [];
      const dimensions = normaliseHexDimensions(map.hexDimensions);
      const areas = map.layers.base.data && map.layers.polities.data
        ? politySurfaceAreas(map.layers.base.data, map.layers.polities.data, dimensions, map.islandSpecs)
        : new Map<string, number>();
      if (polities.length === 0) return <div className="hint">No polities yet.</div>;
      return (
        <div className="stack">
        <div className="legend">
          {polities.map((p) => (
            <Swatch
              key={p.id}
              colour={p.colour}
              label={`${p.name} — ${formatArea(areas.get(p.id) ?? 0, dimensions.unit, dimensions.areaRounding)}`}
            />
          ))}
        </div>
        <p className="hint" style={{ margin: 0 }}>
          Land areas use the hex size set in Settings → Map.
        </p>
        </div>
      );
    }
    case 'population': {
      const values = (map.layers.population.data ?? []).filter(
        (v): v is number => v !== null && v !== undefined,
      );
      const max = values.length > 0 ? Math.max(...values) : 0;
      return (
        <div>
          <div className="row" style={{ gap: 0 }}>
            {POPULATION_LEGEND_RAMP.map((c) => (
              <span
                key={c}
                style={{ background: c, height: 12, flex: 1, border: '1px solid rgba(0,0,0,0.35)' }}
              />
            ))}
          </div>
          <div className="row hint" style={{ justifyContent: 'space-between', marginTop: 3 }}>
            <span>0</span>
            <span>log scale</span>
            <span>{max.toLocaleString()}</span>
          </div>
        </div>
      );
    }
    default:
      return null;
  }
}
