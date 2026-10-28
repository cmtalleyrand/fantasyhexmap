import { hexCount } from './selectionText.js';
import { useMemo, useState } from 'react';
import { hexIndex, indexToOffset, neighbourOf } from '../../shared/hex.js';
import { canHoldSettlement, isShoreLand } from '../../shared/derive.js';
import { landEdgesOf } from '../../shared/straits.js';
import { isLakeNeck, lakeEdgesOf } from '../render/sites.js';
import { holdersOf } from '../../shared/polityShares.js';
import type { RiverNotice, RiverTool } from '../state/riverTools.js';
import RiverEditor from './RiverEditor.js';
import type { RiverMeasurement } from '../../shared/riverLength.js';
import type { DrawingCompromise } from '../render/scene.js';
import { groupCompromises } from '../render/compromises.js';
import AreaEditControls from './AreaEditControls.js';
import GeoNamesEditor from './GeoNamesEditor.js';
import { LAYER_META, missingRequirements, stalenessOf } from '../../shared/layers.js';
import {
  BASE_GEO_VALUES,
  CLIMATE_VALUES,
  ELEVATION_VALUES,
  BASE_DESCRIPTIONS,
  VEGETATION_GROUPS,
  VEGETATION_VALUES,
  IRREGULARITY_VALUES,
  DEFAULT_IRREGULARITY,
  hasLandShare,
  hasLandConcentration,
  hasChannelWidth,
  CHANNEL_WIDTH_PERCENT,
  CHANNEL_WIDTH_VALUES,
  type ChannelWidth,
  hexShapeFor,
  DEFAULT_LAKE_IRREGULARITY,
  isIslandType,
  isShapedType,
  islandSpecFor,
  isRangeElevation,
  ISLAND_ARRANGEMENTS,
  ISLAND_ORIENTATIONS,
  type IslandArrangement,
  type IslandOrientation,
  type BaseGeo,
  type City,
  type CitySite,
  type IslandSpec,
  type LayerId,
  type MapState,
  type Polity,
  type Irregularity,
  type VegetationGroup,
} from '../../shared/types.js';
import { planMultiLayerEdit } from '../../shared/multiEdit.js';
import { canSplit, passLabel, type PassSelection } from '../../core/rosters.js';
import { type Action, type HexShapeChange, type IslandSpecChange } from '../state/store.js';
import {
  baseSurfaceStatistics,
  formatArea,
  landFraction,
  withShoreSlack,
  channelShareSet,
  landLayerSurfaceStatistics,
  normaliseHexDimensions,
} from '../../shared/surfaceArea.js';
import { descendantsOf, polityOutline, wouldCycle } from '../../shared/polityTree.js';
import { contrastingRealmColours } from '../render/hierarchy.js';
import Legend from './Legend.js';
import CommitInput, { CommitColour, CommitHex, copyText } from './CommitInput.js';
import type { PolityTone } from '../render/palette.js';
import type { EditorMode } from '../state/workspace.js';

const PER_HEX: LayerId[] = ['base', 'elevation', 'climate', 'vegetation', 'population'];

export interface InspectorProps {
  riverMeasurements?: Record<string, RiverMeasurement>;
  /** AI mode shows prompting and generation; manual mode shows hand editing. Never both. */
  mode: EditorMode;
  map: MapState;
  dispatch: (action: Action) => void;
  activeLayer: LayerId;
  selection: Set<number>;
  setSelection: (next: Set<number>) => void;
  /** Where the map as drawn could not do everything asked of it (see `DrawingCompromise`). */
  compromises?: DrawingCompromise[];
  brush: Record<string, string>;
  setBrush: (layer: LayerId, value: string) => void;
  brushMode: boolean;
  setBrushMode: (on: boolean) => void;
  /** The geographical name being painted into on the map, if any. */
  geoPaintId: string | null;
  focusedFeatureId: string | null;
  focusFeature: (id: string | null) => void;
  areaEditMode: 'select' | 'add' | 'remove';
  setAreaEditMode: (mode: 'select' | 'add' | 'remove') => void;
  setGeoPaintId: (id: string | null) => void;
  instruction: string;
  setInstruction: (value: string) => void;
  onAiEdit: () => void;
  /** Layers ticked in the pipeline list; one instruction can be applied to all of them. */
  selectedLayers: ReadonlySet<LayerId>;
  onAiEditSelected: () => void;
  /** Open the compile-a-prompt / paste-the-reply dialog for this layer. */
  onWebchat: () => void;
  /** Generate this layer, optionally only one half of a splittable one. */
  onGeneratePass: (selection: PassSelection) => void;
  onGenerateShortNames: () => void;
  busy: boolean;
  /** Layers with a generation in flight. */
  busyLayers: ReadonlySet<LayerId>;
  riverDraft: number[] | null;
  setRiverDraft: (next: number[] | null) => void;
  /** Take back the last click of the draft, with any straight run it laid down. */
  undoRiverDraftClick: () => void;
  /** Set while the draft is a distributary leaving this river. */
  riverDraftParent: string | null;
  setRiverDraftParent: (next: string | null) => void;
  riverTool: RiverTool;
  setRiverTool: (next: RiverTool) => void;
  /** The outcome of the last river edit, shown beside the river controls. */
  riverNotice: RiverNotice | null;
  setRiverNotice: (next: RiverNotice | null) => void;
}

/**
 * What the drawing gave up, and why: for the selected hexes when any of them are affected,
 * else a count for the whole map with a way to select them.
 */
function CompromiseNotes({ map, compromises, selected, setSelection }: {
  map: MapState;
  compromises: DrawingCompromise[];
  selected: number[];
  setSelection: (next: Set<number>) => void;
}) {
  if (compromises.length === 0) return null;
  const here = compromises.filter((c) => c.hexes.some((i) => selected.includes(i)));
  const adaptations = compromises.filter(c => c.severity === 'adaptation').length;
  const losses = compromises.length - adaptations;
  if (here.length === 0) {
    const hexes = new Set(compromises.flatMap((c) => c.hexes));
    return (
      <div className="notice warn" style={{ marginBottom: 8 }}>
        {losses > 0 ? `${losses} drawing ${losses === 1 ? 'loss' : 'losses'}` : 'No drawing losses'}
        {adaptations > 0 ? `; ${adaptations} size ${adaptations === 1 ? 'adaptation' : 'adaptations'}` : ''}.{' '}
        <button className="tiny" onClick={() => setSelection(hexes)}>Select the hexes</button>
      </div>
    );
  }
  return (
    <div className="notice warn" style={{ marginBottom: 8 }}>
      <strong>Drawn differently from what was asked</strong>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
        {groupCompromises(here).map((c, k) => (
          <li key={k}>{c.severity === 'adaptation' ? 'Size adaptation — ' : ''}{c.hexes.length > 1 ? `${c.hexes.length} hexes: ` : selected.length > 1 ? `${coordLabel(map, c.hexes[0]!)}: ` : ''}{c.what}, because {c.why}.</li>
        ))}
      </ul>
    </div>
  );
}

function coordLabel(map: MapState, index: number): string {
  const { col, row } = indexToOffset(map.cols, index);
  return `${col},${row}`;
}

export default function Inspector(props: InspectorProps) {
  const { map, dispatch, activeLayer, selection } = props;
  const layer = map.layers[activeLayer];
  const meta = LAYER_META[activeLayer];
  const staleness = stalenessOf(map, activeLayer);
  const selected = useMemo(() => [...selection].sort((a, b) => a - b), [selection]);
  const multi = useMemo(
    () => planMultiLayerEdit(map, props.selectedLayers),
    [map, props.selectedLayers],
  );
  const hasData = layer.data !== null;
  const generating = props.busyLayers.has(activeLayer);
  const missing = missingRequirements(map, activeLayer);
  // Validation notes closed by the user stay closed until they change.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const warningsKey = `${activeLayer}\n${layer.warnings.join('\n')}`;
  const shownWarnings = dismissed === warningsKey ? [] : layer.warnings;
  const aboutCount = shownWarnings.length;

  const ai = props.mode === 'ai';
  return (
    <div className="inspector">
      <div className="section">
        <h2>{meta.label}</h2>
        <details className="geo-help"><summary>About {meta.label}</summary><p>{meta.blurb}</p></details>
        <CompromiseNotes map={map} compromises={props.compromises ?? []} selected={selected} setSelection={props.setSelection} />

        <div className="row" style={{ marginBottom: 8 }}>
          <span className="grow" />
          {!ai && (
            <button
              className="tiny danger"
              disabled={!hasData}
              onClick={() => {
                if (window.confirm(`Clear the whole ${meta.label} layer? Undo brings it back.`)) {
                  dispatch({ type: 'clearLayer', layer: activeLayer });
                }
              }}
            >
              clear
            </button>
          )}
        </div>

        {ai && staleness.stale && (
          <div className="notice warn">
            <b>Stale.</b> {staleness.reasons.join('; ')}. Nothing has been changed automatically.
            <div style={{ marginTop: 6 }}>
              <button
                className="tiny"
                disabled={props.busy}
                onClick={() => {
                  if (window.confirm(`Regenerate ${meta.label} against the layers as they now stand? This replaces the whole layer; undo brings the old one back.`)) {
                    props.onGeneratePass('both');
                  }
                }}
              >
                regenerate to bring it in line
              </button>
            </div>
          </div>
        )}
      </div>

      {ai ? (
        <>
          <GenerateSection {...props} hasData={hasData} generating={generating} missing={missing} />

          {hasData && (
            <div className="section">
              <h2>Edit with an instruction</h2>
              <textarea
                rows={3}
                placeholder={
                  activeLayer === 'base'
                    ? 'e.g. add a chain of volcanic islands along the eastern sea'
                    : `e.g. change something about the ${meta.label.toLowerCase()} layer`
                }
                value={props.instruction}
                onChange={(e) => props.setInstruction(e.target.value)}
              />
              <button
                className="primary"
                style={{ marginTop: 6, width: '100%' }}
                disabled={props.busy || props.instruction.trim().length === 0}
                onClick={props.onAiEdit}
              >
                Rewrite {meta.label} with AI
              </button>
              {props.selectedLayers.size > 0 && (
                <>
                  <button
                    className="primary"
                    style={{ marginTop: 6, width: '100%' }}
                    disabled={props.busy || multi.layers.length === 0 || props.instruction.trim().length === 0}
                    onClick={props.onAiEditSelected}
                    title="Rewrite each ticked layer in turn, each after the layers it reads"
                  >
                    Rewrite the {multi.layers.length} ticked layer{multi.layers.length === 1 ? '' : 's'} with AI
                  </button>
                  <p className="hint" style={{ marginTop: 4 }}>
                    {multi.layers.length > 0
                      ? `Runs ${multi.layers.map((id) => LAYER_META[id].label).join(' → ')}, one request each.`
                      : 'None of the ticked layers has data to edit.'}
                    {multi.skipped.length > 0 &&
                      ` Skipped, no data: ${multi.skipped.map((id) => LAYER_META[id].label).join(', ')}.`}
                  </p>
                </>
              )}
              <p className="hint" style={{ marginTop: 4 }}>
                The whole layer is sent as context and comes back rewritten, so one instruction can change
                the map anywhere. Tick layers in the Layers list to rewrite several with one instruction.
                Each instruction is one whole-map undo step.
              </p>
              {activeLayer === 'polities' && (
                <>
                  <button
                    style={{ marginTop: 6, width: '100%' }}
                    disabled={props.busy || (map.layers.polities.data?.polities.length ?? 0) === 0}
                    onClick={props.onGenerateShortNames}
                  >
                    Generate short map names with AI
                  </button>
                  <p className="hint" style={{ marginTop: 4 }}>
                    Generates only the polity roster, preserving the existing borders. Full names remain
                    available in the legend.
                  </p>
                </>
              )}
            </div>
          )}

          {hasData && PER_HEX.includes(activeLayer) && (
            <div className="section">
              <h2>Selected</h2>
              <SelectionCard {...props} selected={selected} readOnly />
            </div>
          )}
        </>
      ) : hasData ? (
        <>
          <div className="section">
            <h2>Edit by hand</h2>
            {PER_HEX.includes(activeLayer) ? (
              <PerHexEditor {...props} selected={selected} />
            ) : activeLayer === 'polities' ? (
              <PolityEditor {...props} selected={selected} />
            ) : activeLayer === 'cities' ? (
              <CityEditor {...props} selected={selected} />
            ) : (
              <RiverEditor {...props} notice={props.riverNotice} setNotice={props.setRiverNotice} />
            )}
          </div>
          {activeLayer === 'base' && (
            <GeoNamesEditor
              map={map}
              dispatch={dispatch}
              selected={selected}
              setSelection={props.setSelection}
              paintId={props.geoPaintId}
              editMode={props.areaEditMode}
              setEditMode={props.setAreaEditMode}
              setPaintId={(id) => {
                if (id) props.setBrushMode(false);
                props.setGeoPaintId(id);
              }}
            />
          )}
        </>
      ) : (
        <div className="section">
          <p className="hint" style={{ margin: 0 }}>
            {missing.length > 0
              ? `${meta.label} needs ${missing.map((m) => LAYER_META[m].label).join(' and ')} first.`
              : `${meta.label} is empty, so there is nothing to edit yet.`}
          </p>
          {missing.length === 0 && (
            <button
              className="primary"
              style={{ marginTop: 8, width: '100%' }}
              onClick={() => dispatch({ type: 'startLayer', layer: activeLayer })}
            >
              Start {meta.label} by hand
            </button>
          )}
        </div>
      )}

      {ai && aboutCount > 0 && (
        <div className="section">
          <h2>About this layer</h2>
          <Warnings
            warnings={shownWarnings}
            onDismiss={() => setDismissed(warningsKey)}
          />
        </div>
      )}

      {hasData && ['base', 'elevation', 'climate', 'vegetation'].includes(activeLayer) && (
        <SurfaceTotals map={map} layer={activeLayer} />
      )}

      <div className="section">
        <h2>Legend</h2>
        <Legend layer={activeLayer} map={map} />
      </div>
    </div>
  );
}

function SurfaceTotals({ map, layer }: { map: MapState; layer: LayerId }) {
  const dimensions = normaliseHexDimensions(map.hexDimensions);
  const base = map.layers.base.data!;
  const values = layer === 'elevation'
    ? ELEVATION_VALUES
    : layer === 'climate'
      ? CLIMATE_VALUES
      : VEGETATION_VALUES;
  const statistics = layer === 'base'
    ? baseSurfaceStatistics(base, dimensions, map.islandSpecs, map.hexShapes, map.cols)
    : landLayerSurfaceStatistics(
        map.layers[layer].data as (string | null)[],
        values,
        base,
        dimensions,
        map.islandSpecs,
        map.hexShapes,
        map.cols,
      );
  return (
    <div className="section">
      <h2>Surface totals</h2>
      <table className="surface-totals">
        <thead>
          <tr><th>Type</th><th>Hexes{layer === 'base' ? ' containing' : ''}</th><th>Surface area</th></tr>
        </thead>
        <tbody>
          {statistics.map((stat) => (
            <tr key={stat.label}>
              <td>{stat.label}</td>
              <td>{stat.hexCount.toLocaleString()}</td>
              <td>{formatArea(stat.area, dimensions.unit, dimensions.areaRounding)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {layer === 'base' && (
        <p className="hint" style={{ margin: '6px 0 0' }}>
          A shore hex appears in every surface it contains; its area is divided by its land share.
        </p>
      )}
    </div>
  );
}

function Warnings({ warnings, onDismiss }: { warnings: string[]; onDismiss: () => void }) {
  if (warnings.length === 0) return null;
  return (
    <details className="notice warn dismissible" style={{ marginTop: 8 }} open={warnings.length <= 3}>
      <summary>
        <b>
          {warnings.length} validation note{warnings.length === 1 ? '' : 's'}
        </b>
        <button
          type="button"
          className="tiny dismiss"
          title="Close these notes"
          aria-label="Close validation notes"
          onClick={(e) => {
            e.preventDefault();
            onDismiss();
          }}
        >
          ×
        </button>
      </summary>
      <ul className="warnlist">
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </details>
  );
}

/** Generate the layer, regenerate it, or carry the prompt to a chat window instead. */
function GenerateSection(
  props: InspectorProps & { hasData: boolean; generating: boolean; missing: LayerId[] },
) {
  const { activeLayer, hasData, generating, missing } = props;
  const label = LAYER_META[activeLayer].label;
  const [passSelection, setPassSelection] = useState<PassSelection>('both');
  const splittable = canSplit(activeLayer);

  if (missing.length > 0) {
    return (
      <div className="section">
        <p className="hint" style={{ margin: 0 }}>
          {label} needs {missing.map((m) => LAYER_META[m].label).join(' and ')} first.
        </p>
      </div>
    );
  }

  const run = () => {
    if (
      hasData &&
      !window.confirm(`Regenerate ${label}? This replaces the whole layer; undo brings the current one back.`)
    ) {
      return;
    }
    props.onGeneratePass(splittable ? passSelection : 'both');
  };

  return (
    <div className="section">
      {!hasData && <h2>Generate</h2>}
      <button
        className={hasData ? '' : 'primary'}
        style={{ width: '100%' }}
        disabled={props.busy || (splittable && passSelection === 'paint' && !hasData)}
        onClick={run}
      >
        {generating ? `Generating ${label}…` : hasData ? `Regenerate ${label}…` : `Generate ${label}`}
      </button>
      {splittable && (
        <details className="passes" style={{ marginTop: 6 }}>
          <summary className="hint">Generate in two passes</summary>
          <p className="hint" style={{ marginTop: 4 }}>
            This layer decides a cast and places it on the grid, and those two halves constrain each other,
            which is most of why it is the expensive one. Running them separately gives the model a closed
            set to work against.
          </p>
          <select
            value={passSelection}
            disabled={props.busy}
            onChange={(e) => setPassSelection(e.target.value as PassSelection)}
          >
            <option value="both">Both passes</option>
            <option value="roster">{passLabel(activeLayer, 'roster')} only</option>
            <option value="paint">
              {passLabel(activeLayer, 'paint')} only, keeping the current {passLabel(activeLayer, 'roster')}
            </option>
          </select>
          {passSelection === 'paint' && !hasData && (
            <p className="hint" style={{ marginTop: 4 }}>
              There is nothing to keep yet. Generate the {passLabel(activeLayer, 'roster')} first, or
              supply one through the chat-window route below.
            </p>
          )}
        </details>
      )}
      <button className="linkish" style={{ marginTop: 6 }} disabled={props.busy} onClick={props.onWebchat}>
        or use a chat window instead: build the prompt, paste the reply…
      </button>
    </div>
  );
}

/* ------------------------------------------------------------- per-hex edit */

type SubProps = InspectorProps & { selected: number[] };

function valueOptions(layer: LayerId): { value: string; label: string }[] {
  switch (layer) {
    case 'base':
      return BASE_GEO_VALUES.map((v) => ({ value: v, label: v }));
    case 'elevation':
      return [{ value: '', label: '(none)' }, ...ELEVATION_VALUES.map((v) => ({ value: v, label: v }))];
    case 'climate':
      return [{ value: '', label: '(none)' }, ...CLIMATE_VALUES.map((v) => ({ value: v, label: v }))];
    case 'vegetation':
      return [
        { value: '', label: '(none)' },
        ...(Object.keys(VEGETATION_GROUPS) as VegetationGroup[]).flatMap((g) =>
          VEGETATION_GROUPS[g].map((v) => ({ value: v, label: `${g.slice(0, 4)} · ${v}` })),
        ),
      ];
    default:
      return [];
  }
}

function PerHexEditor(props: SubProps) {
  const { map, dispatch, activeLayer, selected } = props;
  const isPopulation = activeLayer === 'population';
  const options = valueOptions(activeLayer);
  const current = props.brush[activeLayer] ?? (isPopulation ? '0' : options[0]?.value ?? '');

  const apply = (indices: number[]) => {
    if (indices.length === 0) return;
    const raw = props.brush[activeLayer] ?? current;
    const value = isPopulation
      ? Math.max(0, Math.round(Number(raw) || 0))
      : raw === ''
        ? null
        : raw;
    dispatch({
      type: 'setHexValues',
      layer: activeLayer as 'base' | 'elevation' | 'climate' | 'vegetation' | 'population',
      indices,
      value,
    });
  };

  const valueLabel = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  const brushIsIsland = activeLayer === 'base' && isIslandType(current as BaseGeo);

  return (
    <div className="stack">
      <SelectionCard {...props} />
      <div>
        <label>{selected.length > 0 ? 'Change the selected hexes to' : 'Value to paint'}</label>
        {isPopulation ? (
          <input
            type="number"
            min={0}
            step={100}
            value={current}
            onChange={(e) => props.setBrush(activeLayer, e.target.value)}
          />
        ) : (
          <select value={current} onChange={(e) => props.setBrush(activeLayer, e.target.value)}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        {activeLayer === 'base' && current && (
          <p className="hint" style={{ margin: '4px 0 0' }}>
            {BASE_DESCRIPTIONS[current as BaseGeo]}
            {brushIsIsland ? ' Once applied, set how many islands each hex holds in the Selected box above.' : ''}
          </p>
        )}
      </div>
      <div className="row">
        <button className="primary grow" disabled={selected.length === 0} onClick={() => apply(selected)}>
          Apply to {selected.length} selected
        </button>
        <button className="tiny" disabled={selected.length === 0} onClick={() => props.setSelection(new Set())}>
          clear
        </button>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 12 }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={props.brushMode}
          onChange={(e) => { props.setBrush(activeLayer, current); props.setBrushMode(e.target.checked); }}
        />
        {current === '' ? 'Clear this layer on the map · apply on release' : `Paint ${valueLabel(current)} on the map · apply on release`}
      </label>
      {!isPopulation && (
        <button
          className="linkish"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => {
            const data = map.layers[activeLayer].data as unknown[] | null;
            const want = current === '' ? null : current;
            const matches = (data ?? []).flatMap((v, i) => ((v ?? null) === want ? [i] : []));
            props.setSelection(new Set(matches));
          }}
        >
          Select every {valueLabel(current)} hex on the map
        </button>
      )}
      <p className="hint" style={{ margin: 0 }}>
        Use Replace, Add or Remove in the map toolbar to select hexes. Ctrl+A (⌘A) selects all; Esc clears.
      </p>
      {activeLayer === 'elevation' && <MountainRangePanel {...props} />}
    </div>
  );
}

/**
 * What is selected: each hex's value on this layer (with what a base type
 * means, for a single hex), and the settings that belong to those hexes -
 * the islands of island hexes.
 */
function SelectionCard(props: SubProps & { readOnly?: boolean }) {
  const { map, activeLayer, selected, readOnly } = props;
  if (selected.length === 0) {
    return (
      <div className="card selection-card" style={{ padding: 10 }}>
        <div className="hint" style={{ margin: 0 }}>{readOnly ? 'No hexes selected. Click the map to inspect a hex.' : 'No hexes selected. Use the map selection tools to choose hexes.'}</div>
      </div>
    );
  }
  const data = map.layers[activeLayer].data as unknown[] | null;
  const counts = new Map<string, number>();
  for (const i of selected) {
    const v = data?.[i];
    const key = v === null || v === undefined ? '(none)' : String(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const values = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const single = selected.length === 1;
  const only = values.length === 1 ? values[0]![0] : null;
  return (
    <div className="card stack selection-card" style={{ padding: 10, gap: 6 }}>
      <div className="hint" style={{ margin: 0 }}>
        Selected: {single ? `hex ${coordLabel(map, selected[0]!)}` : `${selected.length} hexes`}
        {!single && selected.length <= 8 ? ` (${selected.map((i) => coordLabel(map, i)).join(' ')})` : ''}
      </div>
      {only !== null ? (
        <div style={{ fontWeight: 600, fontSize: 15 }}>
          {single ? '' : 'All '}{only}
        </div>
      ) : (
        <div style={{ fontWeight: 600 }}>
          {values.slice(0, 6).map(([v, n]) => `${n} ${v}`).join(', ')}
          {values.length > 6 ? ` and ${values.length - 6} more types` : ''}
        </div>
      )}
      {activeLayer === 'base' && only !== null && only in BASE_DESCRIPTIONS && (
        <details className="geo-help"><summary>About this terrain</summary><p>{BASE_DESCRIPTIONS[only as BaseGeo]}</p></details>
      )}
      {activeLayer === 'base' && !readOnly && <HexShapePanel {...props} />}
      {activeLayer === 'base' && !readOnly && <IslandSidePanel {...props} />}
    </div>
  );
}

/** What each irregularity looks like, for the sidebar. */
const IRREGULARITY_HINTS: Record<Irregularity, string> = {
  Smooth: 'Even, rounded outlines.',
  Wavy: 'A gently wandering outline.',
  Ragged: 'Headlands and coves; a few skerries and floes break away.',
  Fractured: 'Deeply broken: jagged shores, many skerries, floes and icebergs.',
};

const LAND_SHARE_STEPS = Array.from({ length: 21 }, (_, n) => n * 5);

/** The land share and irregularity of the selected shaped hexes (coast, islands, isthmus, strait, ice). */
function HexShapePanel(props: SubProps) {
  const { map, dispatch, selected } = props;
  const base = map.layers.base.data;
  // Land has a shore to shape only where it meets sea or lake.
  const hexes = selected.filter((i) => (isShapedType(base?.[i]) || hasLandShare(base?.[i])) && (base![i] !== 'Land' || isShoreLand(base!, map.cols, i)));
  if (hexes.length === 0) return null;
  // A lake takes an irregularity for its own shore too; unset, its shore follows the land beside it, then the map's lake setting.
  const shaped = hexes.filter(i => base![i] !== 'Sea');
  const irregularOf = (i: number): Irregularity =>
    base![i] === 'Lake'
      ? (map.hexShapes?.[String(i)]?.type === 'Lake' ? map.hexShapes[String(i)]!.irregular : undefined) ?? map.defaultLakeIrregularity ?? DEFAULT_LAKE_IRREGULARITY
      : hexShapeFor(base![i], map.hexShapes?.[String(i)], map.defaultIrregularity).irregular;
  const dims = normaliseHexDimensions(map.hexDimensions);
  // What is drawn: the share held to the shore slack (`withShoreSlack`), not an extreme it rules out.
  const slack = (i: number, share: number) => withShoreSlack(base!, map.cols, i, share, dims, map.hexShapes);
  const percentOf = (i: number, withShape: boolean) =>
    Math.round(slack(i, landFraction(base![i], map.islandSpecs?.[String(i)], dims, withShape ? map.hexShapes?.[String(i)] : undefined, base![i] === 'Land')) * 100);
  const sharedOf = (values: string[]) => (new Set(values).size === 1 ? values[0]! : '');
  const landHexes = hexes.filter((i) => hasLandShare(base![i]));
  // An isthmus or a strait is drawn at a width, not to a land share.
  const channelHexes = hexes.filter((i) => hasChannelWidth(base![i]));
  // With no share set, an isthmus or strait has the natural share of its width; setting one tunes the land round it.
  const natural = (i: number) => hasChannelWidth(base![i]) && channelShareSet(base![i], dims, map.hexShapes?.[String(i)]) === null;
  const allNatural = landHexes.length > 0 && landHexes.every(natural);
  const widthOf = (i: number, withShape: boolean): string =>
    hexShapeFor(base![i], withShape ? map.hexShapes?.[String(i)] : undefined).width ?? (base![i] === 'Isthmus' ? dims.isthmusWidth : dims.straitWidth);
  const width = sharedOf(channelHexes.map((i) => widthOf(i, true)));
  const usualWidth = sharedOf(channelHexes.map((i) => widthOf(i, false)));
  const bothKinds = channelHexes.some((i) => base![i] === 'Isthmus') && channelHexes.some((i) => base![i] === 'Strait');
  const straitHexes = hexes.filter((i) => base![i] === 'Strait');
  const straitJunctionSide = sharedOf(straitHexes.map((i) => String(hexShapeFor(base![i], map.hexShapes?.[String(i)]).straitJunctionSide ?? -1)));
  const land = sharedOf(landHexes.map((i) => String(percentOf(i, true))));
  const usual = sharedOf(landHexes.map((i) => String(percentOf(i, false))));
  const irregular = sharedOf(shaped.map(irregularOf));
  const usualIrregular = sharedOf(shaped.map((i) => (base![i] === 'Lake' ? map.defaultLakeIrregularity ?? DEFAULT_LAKE_IRREGULARITY : map.defaultIrregularity ?? DEFAULT_IRREGULARITY[base![i]!])));
  const customised = hexes.some((i) => {
    const stored = map.hexShapes?.[String(i)];
    return stored !== undefined && stored.type === base![i];
  });
  const set = (change: HexShapeChange | null) => dispatch({ type: 'setHexShape', indices: hexes, change });
  const concentrated = hexes.filter((i) => hasLandConcentration(base![i]));
  const concentrationSide = sharedOf(concentrated.map((i) => String(hexShapeFor(base![i], map.hexShapes?.[String(i)]).concentrationSide ?? -1)));
  const concentration = sharedOf(concentrated.map((i) => String(hexShapeFor(base![i], map.hexShapes?.[String(i)]).concentration ?? 0)));
  const landValue = Number(land);
  // The shares the shore slack allows on every selected hex: no option outside them is offered.
  const lowest = Math.max(0, ...landHexes.map((i) => Math.round(slack(i, 0) * 100)));
  const highest = Math.min(100, ...landHexes.map((i) => Math.round(slack(i, 1) * 100)));
  return (
    <div className="stack" style={{ marginTop: 8 }}>
      <label style={{ margin: 0 }}>Shape of {hexes.length === 1 ? 'this hex' : `these ${hexes.length} hexes`}</label>
      {landHexes.length > 0 && (
        <>
          <label htmlFor="hex-land-share" style={{ margin: 0 }}>Land share</label>
          <select
            id="hex-land-share"
            aria-label="Land share"
            value={allNatural ? 'natural' : land}
            onChange={(e) => set({ land: e.target.value === 'natural' ? null : Number(e.target.value) })}
          >
            {land === '' && !allNatural && <option value="">Mixed</option>}
            {channelHexes.length > 0 && <option value="natural">Natural (from the width)</option>}
            {land !== '' && !LAND_SHARE_STEPS.includes(landValue) && <option value={land}>{land}%</option>}
            {LAND_SHARE_STEPS.map((p) => {
              const ruledOut = p < lowest || p > highest;
              return <option key={p} value={String(p)} disabled={ruledOut}>{p}%{ruledOut ? ' (not allowed here)' : ''}</option>;
            })}
          </select>
          <p className="hint" style={{ margin: 0 }}>
            How much of the hex is drawn as land, and counted in surface areas.{usual !== '' ? ` Usually ${usual}%.` : ''}
            {channelHexes.length > 0
              ? ' For an isthmus or strait the width below sets how narrow it is at its thinnest; a land share as well tunes how much land there is round that, widening or narrowing the flared ends of a neck and the banks of a channel.'
              : ''}
            {landHexes.some((i) => base![i] === 'Land')
              ? ' Land is cut back from the edges it shares with sea or lake; inland Land is always whole.'
              : ''}
            {highest < 100 ? ` Max ${highest}% beside 0% water.` : ''}
            {lowest > 0 ? ` Min ${lowest}% beside 100% land.` : ''}
            {landHexes.some((i) => base![i] === 'Lake')
              ? ' In a lake hex this is land drawn in from the edges it shares with land (the lake keeps the rest); 0% leaves the lake as it is.'
              : ''}
            {landHexes.some((i) => base![i] === 'Sea')
              ? ' In a sea hex this extends the neighbouring shore into the water. The default is 0%; open sea without a land neighbour stays water.'
              : ''}
            {landHexes.some((i) => isIslandType(base![i]))
              ? ` An island hex adds up its islands (${dims.smallIslandPercent}% for each small one, ${dims.largeIslandPercent}% for each large one, plus ${dims.mainlandPercent}% for a mainland); its islands are drawn at that size, kept apart and inside the hex; if they cannot all fit at that size they are drawn as large as they can be.`
              : ''}
          </p>
        </>
      )}
      {concentrated.length > 0 && (<>
        <label htmlFor="land-concentration-side" style={{ margin: 0 }}>Land concentrated towards</label>
        <select
          id="land-concentration-side"
          value={concentrationSide}
          onChange={(e) => set({ concentrationSide: e.target.value === '-1' ? null : Number(e.target.value) })}
        >
          {concentrationSide === '' && <option value="">Mixed</option>}
          <option value="-1">No chosen side</option>
          {SIDE_NAMES.map((name, side) => <option key={side} value={side}>The {name} side</option>)}
        </select>
        <label htmlFor="land-concentration" style={{ margin: 0 }}>Extent of concentration</label>
        <select
          id="land-concentration"
          value={concentration}
          disabled={concentrationSide === '-1'}
          onChange={(e) => set({ concentration: Number(e.target.value) })}
        >
          {concentration === '' && <option value="">Mixed</option>}
          {[0, 25, 50, 75, 100].map((amount) => <option key={amount} value={amount}>{amount}%</option>)}
        </select>
        <p className="hint" style={{ margin: 0 }}>
          Keeps the same land share while shifting more of its land towards one hex side. At 0% the land remains evenly distributed; 100% gives the strongest bias.
        </p>
      </>)}
      {channelHexes.length > 0 && (
        <>
          <label htmlFor="hex-channel-width" style={{ margin: 0 }}>{bothKinds ? 'Isthmus / strait width' : channelHexes.every((i) => base![i] === 'Isthmus') ? 'Isthmus width' : 'Strait width'}</label>
          <select
            id="hex-channel-width"
            aria-label="Width"
            value={width}
            onChange={(e) => set({ width: e.target.value as ChannelWidth })}
          >
            {width === '' && <option value="">Mixed</option>}
            {CHANNEL_WIDTH_VALUES.map((w) => <option key={w} value={w}>{w} ({CHANNEL_WIDTH_PERCENT[w]}% of the hex)</option>)}
          </select>
          <p className="hint" style={{ margin: 0 }}>
            How narrow {channelHexes.every((i) => base![i] === 'Isthmus') ? 'the neck of land' : channelHexes.every((i) => base![i] === 'Strait') ? 'the channel of water' : 'the neck of land (isthmus) or channel of water (strait)'} is at its thinnest, as a share of the hex's width.{usualWidth !== '' ? ` Usually ${usualWidth.toLowerCase()}.` : ''}
          </p>
        </>
      )}
      {straitHexes.length > 0 && (
        <>
          <label htmlFor="strait-junction-side" style={{ margin: 0 }}>Strait channels meet</label>
          <select
            id="strait-junction-side"
            aria-label="Strait channels meet"
            value={straitJunctionSide}
            onChange={(e) => set({ straitJunctionSide: e.target.value === '-1' ? null : Number(e.target.value) })}
          >
            {straitJunctionSide === '' && <option value="">Mixed</option>}
            <option value="-1">Near the middle</option>
            {SIDE_NAMES.map((name, side) => <option key={side} value={side}>On the {name} side</option>)}
          </select>
          <p className="hint" style={{ margin: 0 }}>
            Chooses the common junction of the strait's channel branches. The middle gives non-opposite banks a balanced shape; a side pulls the junction towards that edge while keeping the channel open.
          </p>
        </>
      )}
      {shaped.length > 0 && (<>
      <label htmlFor="hex-irregularity" style={{ margin: 0 }}>Irregularity</label>
      <select
        id="hex-irregularity"
        aria-label="Irregularity"
        value={irregular}
        onChange={(e) => set({ irregular: e.target.value as Irregularity })}
      >
        {irregular === '' && <option value="">Mixed</option>}
        {IRREGULARITY_VALUES.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      <p className="hint" style={{ margin: 0 }}>
        {irregular !== '' ? IRREGULARITY_HINTS[irregular as Irregularity] : 'The selected hexes differ.'}
        {usualIrregular !== '' ? ` Usually ${usualIrregular.toLowerCase()}.` : ''} Coasts take it only in a smoothed coast style.
      </p>
      </>)}
      {customised && (
        <button className="tiny" onClick={() => set(null)}>Use the usual shape settings</button>
      )}
    </div>
  );
}

const SIDE_NAMES = ['east', 'south-east', 'south-west', 'west', 'north-west', 'north-east'];
/** The hex's corners, in the order `{ corner }` counts them (corner c lies between edges c-1 and c). */
const CORNER_NAMES = ['north-east', 'south-east', 'south', 'south-west', 'north-west', 'north'];

function siteValue(site: City['site']): string {
  if (!site || site === 'auto') return 'auto';
  if (typeof site === 'object') {
    if ('bank' in site) return `bank:${site.bank}`;
    if ('corner' in site) return `corner:${site.corner}`;
    if ('offset' in site) return 'offset';
    return `${site.river ? 'port' : 'coast'}:${site.coast}`;
  }
  return site;
}

function parseSiteValue(value: string): CitySite {
  if (value.startsWith('bank:')) return { bank: Number(value.slice(5)) };
  if (value.startsWith('coast:')) return { coast: Number(value.slice(6)) };
  if (value.startsWith('port:')) return { coast: Number(value.slice(5)), river: true };
  if (value.startsWith('corner:')) return { corner: Number(value.slice(7)) };
  if (value === 'offset') return { offset: { x: 0, y: 0 } };
  return value === 'inland' || value === 'river' || value === 'neck' || value === 'landward' ? value : 'auto';
}

/** "sea" or "lake": what lies across one of a city's coastal edges. */
function waterNameAcross(map: MapState, city: City, edge: number): string {
  const n = neighbourOf(city.col, city.row, edge);
  return map.layers.base.data?.[n.row * map.cols + n.col] === 'Lake' ? 'lake' : 'sea';
}

/** How the islands of the selected island hexes are drawn: counts, coastal groups and side. */
function IslandSidePanel(props: SubProps) {
  const { map, dispatch, selected } = props;
  const base = map.layers.base.data;
  const hexes = selected.filter((i) => isIslandType(base?.[i]));
  if (hexes.length === 0) return null;
  const specs = hexes.map((i) => islandSpecFor(base![i], map.islandSpecs?.[String(i)]));
  /** The shared value of `pick` across the selection, or '' when mixed. */
  const shared = (pick: (s: IslandSpec) => string) => {
    const values = new Set(specs.map(pick));
    return values.size === 1 ? [...values][0]! : '';
  };
  const set = (change: IslandSpecChange) => dispatch({ type: 'setIslandSpec', indices: hexes, change });
  const large = shared((s) => String(s.large));
  const small = shared((s) => String(s.small));
  const side = shared((s) => String(s.side ?? -1));
  const coastalLarge = shared((s) => String(Boolean(s.coastal?.large)));
  const coastalSmall = shared((s) => String(Boolean(s.coastal?.small)));
  const mainland = hexes.every((i) => base![i] === 'Mainland and islands');
  const arrangement = shared((s) => s.arrangement ?? 'scattered');
  const orientation = shared((s) => s.orientation ?? 'free');
  const scattered = arrangement === 'scattered';
  return (
    <div className="stack" style={{ marginTop: 8 }}>
      <label style={{ margin: 0 }}>The islands in {hexes.length === 1 ? 'this hex' : `these ${hexes.length} hexes`}</label>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label>
          Large islands{' '}
          <select value={large} onChange={(e) => set({ large: Number(e.target.value) })}>
            {large === '' && <option value="">Mixed</option>}
            {[0, 1, 2].map((n) => <option key={n} value={String(n)}>{n}</option>)}
          </select>
        </label>
        <label>
          Small islands{' '}
          <select value={small} onChange={(e) => set({ small: Number(e.target.value) })}>
            {small === '' && <option value="">Mixed</option>}
            {[0, 1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={String(n)}>{n}</option>)}
          </select>
        </label>
      </div>
      <label htmlFor="island-arrangement">Arrangement</label>
      <select
        id="island-arrangement"
        value={arrangement}
        onChange={(e) => set({ arrangement: e.target.value as IslandArrangement })}
      >
        {arrangement === '' && <option value="">Mixed</option>}
        {ISLAND_ARRANGEMENTS.map((a) => (
          <option key={a.value} value={a.value}>{a.label}</option>
        ))}
      </select>
      <p className="hint" style={{ margin: 0 }}>{ISLAND_ARRANGEMENTS.find((a) => a.value === arrangement)?.hint ?? 'Hexes differ.'}</p>
      {arrangement !== 'ring' && (
        <>
          <label htmlFor="island-orientation">{scattered ? 'Grain of the islets' : 'Direction'}</label>
          <select
            id="island-orientation"
            value={orientation}
            onChange={(e) => set({ orientation: e.target.value as IslandOrientation })}
          >
            {orientation === '' && <option value="">Mixed</option>}
            {ISLAND_ORIENTATIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </>
      )}
      {scattered && (<>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 12, margin: 0 }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={coastalLarge === 'true'}
          ref={(el) => { if (el) el.indeterminate = coastalLarge === ''; }}
          onChange={(e) => set({ coastal: { large: e.target.checked } })}
        />{' '}
        Large islands lie against the {mainland ? 'mainland' : 'coast'}
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 12, margin: 0 }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={coastalSmall === 'true'}
          ref={(el) => { if (el) el.indeterminate = coastalSmall === ''; }}
          onChange={(e) => set({ coastal: { small: e.target.checked } })}
        />{' '}
        Small islands lie against the {mainland ? 'mainland' : 'coast'}
      </label>
      </>)}
      <label htmlFor="island-side">{scattered ? 'Side they lie against' : 'Side the pattern is measured from (the coast, or a heading in open sea)'}</label>
      <select
        id="island-side"
        value={side}
        onChange={(e) => set({ side: e.target.value === '-1' ? null : Number(e.target.value) })}
      >
        {side === '' && <option value="">Mixed</option>}
        <option value="-1">Automatic (faces the nearest land)</option>
        {SIDE_NAMES.map((name, e) => (
          <option key={e} value={String(e)}>
            The {name} side
          </option>
        ))}
      </select>
      <button
        type="button"
        className="tiny"
        onClick={() => set({ layoutSeed: Math.floor(Math.random() * 0x7fffffff) })}
      >
        Disperse and reshape randomly
      </button>
      <p className="hint" style={{ margin: 0 }}>A hex needs at least one island; setting both counts to 0 restores its default.</p>
    </div>
  );
}

/** Name groups of Mountains and Highland hexes so they can be labelled as ranges. */
function MountainRangePanel(props: SubProps) {
  const { map, dispatch, selected } = props;
  const [name, setName] = useState('');
  const ranges = map.mountainRanges ?? [];
  const eligible = (i: number) => isRangeElevation(map.layers.elevation.data?.[i]);
  const mountains = selected.filter(eligible);
  const create = () => {
    if (!name.trim() || !mountains.length) return;
    const id = `range_${Date.now().toString(36)}`;
    dispatch({ type: 'nameMountainRange', id, name: name.trim(), indices: mountains });
    props.focusFeature(id);
    props.setSelection(new Set());
    setName('');
  };
  return <div className="stack entity-editor">
    <h2>Mountain ranges</h2>
    <details className="geo-help"><summary>Which hexes can belong to a range?</summary><p>Mountains and Highland hexes. Turn range names on in Settings → Display.</p></details>
    <label htmlFor="new-range-name">New range</label>
    <input id="new-range-name" placeholder="Range name" value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && create()} />
    <div className="geo-selection-summary"><b>{hexCount(selected.length)} selected</b><span>{mountains.length} eligible · {selected.length - mountains.length} excluded</span></div>
    <button className="primary" disabled={!mountains.length || !name.trim()} onClick={create}>Create range with {mountains.length} hexes</button>
    {ranges.map(r => {
      const active = props.focusedFeatureId === r.id;
      const live = r.hexes.filter(eligible);
      return <article className={`geo-card ${active ? 'active' : ''}`} key={r.id} aria-label={r.name}>
        <button className="geo-title" aria-pressed={active} onClick={() => props.focusFeature(r.id)}>{r.name}</button>
        <div className="geo-area">{active && <i className="area-key" />}Current area: <b>{hexCount(live.length)}</b>{active && <span className="geo-badge">Active</span>}</div>
        {live.length < r.hexes.length && <details className="geo-help geo-excluded"><summary>{r.hexes.length - live.length} assigned hex{r.hexes.length - live.length === 1 ? '' : 'es'} excluded</summary><p>These hexes are no longer Mountains or Highland and are not part of the displayed range.</p></details>}
        {active && <div className="stack">
          <AreaEditControls label="range" selected={selected} hexes={r.hexes} eligible={eligible} mode={props.areaEditMode}
            setMode={mode => { props.setBrushMode(false); props.setAreaEditMode(mode); }}
            onAdd={indices => dispatch({ type: 'nameMountainRange', id: r.id, name: r.name, indices })}
            onRemove={indices => dispatch({ type: 'unnameMountainRangeHexes', id: r.id, indices })} />
          <label htmlFor={`range-name-${r.id}`}>Name</label>
          <CommitInput id={`range-name-${r.id}`} aria-label="Range name" value={r.name} onCommit={name => dispatch({ type: 'renameMountainRange', id: r.id, name })} />
        </div>}
        <div className="geo-actions">
          <button onClick={() => { props.focusFeature(r.id); props.setSelection(new Set(live)); }}>Select area</button>
          {active ? <><button onClick={() => props.focusFeature(null)}>Done editing</button><button className="danger" onClick={() => dispatch({ type: 'removeMountainRange', id: r.id })}>Delete range</button></>
            : <button onClick={() => props.focusFeature(r.id)}>Edit area</button>}
        </div>
      </article>;
    })}
    {!ranges.length && <p className="hint">No named ranges yet.</p>}
  </div>;
}

/* ------------------------------------------------------------ polity editor */

function PolityEditor(props: SubProps) {
  const { map, dispatch, selected } = props;
  const data = map.layers.polities.data!;
  const [name, setName] = useState('');
  const [colour, setColour] = useState('#b5533c');
  const [tone, setTone] = useState<PolityTone>('vivid');
  const [shadeWithContrast, setShadeWithContrast] = useState(true);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);
  const [shareWith, setShareWith] = useState('');
  const [sharePercent, setSharePercent] = useState(50);
  // Kept with the other brush values in App, so a brush stroke on the map assigns to it.
  const target = props.brush.polities ?? '';
  const setTarget = (id: string) => { props.setBrush('polities', id); props.focusFeature(id || null); };

  // Realms followed by their parts, so a realm and its provinces sit together.
  const outline = useMemo(() => polityOutline(data.polities), [data.polities]);
  const validShareWith = shareWith !== target && data.polities.some((p) => p.id === shareWith)
    ? shareWith
    : '';
  const ownCount = useMemo(() => {
    const counts = new Map<string, number>();
    data.owner.forEach((_, i) => {
      for (const [id, part] of holdersOf(data, i)) counts.set(id, (counts.get(id) ?? 0) + part);
    });
    return counts;
  }, [data]);
  const byId = useMemo(() => new Map(data.polities.map((p) => [p.id, p])), [data.polities]);
  const partsOf = (id: string) => {
    const set = descendantsOf(data.polities, id);
    set.delete(id);
    return set;
  };
  const hexesOf = (ids: Set<string>) => data.owner.flatMap((_, i) => (holdersOf(data, i).some(([id]) => ids.has(id)) ? [i] : []));
  const count = (n: number) => String(Math.round(n * 10) / 10);

  // A part whose realm is folded away is hidden with it.
  const hidden = new Set<string>();
  for (const id of collapsed) for (const part of partsOf(id)) hidden.add(part);

  const shadable = data.polities.filter((p) => p.parentId);
  const following = shadable.filter((p) => p.autoShade).length;

  const assignContrastingColours = () => {
    // Realms contrast with their neighbours; with shading on, their parts take shades of the realm's colour.
    const colours = contrastingRealmColours(data.polities, data.owner, map.cols, map.rows, {
      tone,
      shadeParts: shadeWithContrast,
    });
    dispatch({ type: 'setPolityColours', colours: Object.fromEntries(colours), autoShade: shadeWithContrast });
  };

  const add = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const polity: Polity = {
      id: `pol_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: trimmed,
      colour,
    };
    dispatch({ type: 'upsertPolity', polity });
    setName('');
    setTarget(polity.id);
  };

  /** Choosing a colour by hand takes a polity off auto-shading. */
  const recolour = (p: Polity, next: string) => {
    const { autoShade: _off, ...rest } = p;
    dispatch({ type: 'upsertPolity', polity: { ...rest, colour: next } });
  };

  const copy = async (p: Polity) => {
    if (await copyText(p.colour)) {
      setCopied(p.id);
      window.setTimeout(() => setCopied((c) => (c === p.id ? null : c)), 1200);
    }
  };

  return (
    <div className="stack">
      <div>
        <label>Assign selected hexes to</label>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">(unclaimed wilderness)</option>
          {outline.map(({ polity: p, depth }) => (
            <option key={p.id} value={p.id}>
              {'\u00a0\u00a0'.repeat(depth)}
              {depth > 0 ? '↳ ' : ''}
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {target && byId.has(target) ? <AreaEditControls label="polity" selected={selected}
        hexes={hexesOf(new Set([target]))} eligible={i => canHoldSettlement(map.layers.base.data?.[i], map.allowUnderwater)}
        mode={props.areaEditMode} setMode={mode => { props.setBrushMode(false); props.setAreaEditMode(mode); }}
        onAdd={indices => dispatch({ type: 'setPolityOwner', indices, polityId: target })}
        onRemove={indices => dispatch({ type: 'removePolityClaims', id: target, indices })} />
        : <div className="stack"><b>Target: unclaimed wilderness</b>
          <button disabled={!selected.length} onClick={() => dispatch({ type: 'setPolityOwner', indices: selected, polityId: null })}>Clear all claims from {selected.length} selected hexes</button>
          <label className="check"><input type="checkbox" checked={props.brushMode} onChange={e => props.setBrushMode(e.target.checked)} />Paint unclaimed wilderness on the map</label>
        </div>}
      <div>
        <label>Or share selected hexes between that polity and</label>
        <div className="row">
          <select className="grow" value={validShareWith} onChange={(e) => setShareWith(e.target.value)}>
            <option value="">(choose a polity)</option>
            {outline
              .filter(({ polity: p }) => p.id !== target)
              .map(({ polity: p, depth }) => (
                <option key={p.id} value={p.id}>
                  {'\u00a0\u00a0'.repeat(depth)}
                  {depth > 0 ? '↳ ' : ''}
                  {p.name}
                </option>
              ))}
          </select>
          <input
            type="number"
            min={5}
            max={95}
            step={5}
            style={{ width: 56 }}
            value={sharePercent}
            title="Percentage of each hex given to the second polity"
            onChange={(e) => setSharePercent(Math.min(95, Math.max(5, Number(e.target.value) || 50)))}
          />
          <span style={{ alignSelf: 'center' }}>%</span>
        </div>
        {target && validShareWith && <p className="sharing-summary">{byId.get(target)?.name}: {100 - sharePercent}%<br />{byId.get(validShareWith)?.name}: {sharePercent}%</p>}
        <button
          style={{ marginTop: 4 }}
          disabled={selected.length === 0 || !target || !validShareWith}
          title={target ? undefined : 'Choose the polity to assign to above first'}
          onClick={() =>
            dispatch({ type: 'shareHexes', indices: selected, first: target, second: validShareWith, share: sharePercent / 100 })
          }
        >
          Share {hexCount(selected.length)}
        </button>
      </div>
      <details className="geo-help"><summary>How claims and sharing work</summary><p>
        A hex has one owner, none, or is shared between two polities in the proportion you choose; a strait left unclaimed is shared by the realms on its banks.{' '}
        {map.allowUnderwater
          ? 'Underwater claims are allowed on this map.'
          : 'Claims on water are ignored.'}{' '}
        Removing a claim preserves the other holder of a shared hex.
      </p></details>

      <div className="polity-list">
        {outline
          .filter(({ polity }) => !hidden.has(polity.id))
          .map(({ polity: p, depth, parts }) => {
            const own = ownCount.get(p.id) ?? 0;
            const partIds = partsOf(p.id);
            const total = own + [...partIds].reduce((sum, id) => sum + (ownCount.get(id) ?? 0), 0);
            const parent = p.parentId ? byId.get(p.parentId) : undefined;
            const partsFollowing = [...partIds].filter((id) => byId.get(id)?.autoShade).length;
            const isCollapsed = collapsed.has(p.id);
            const bar = parent?.colour ?? p.colour;
            return (
              <div
                key={p.id}
                role="article" aria-label={p.name}
                className={`polity-entry${depth > 0 ? ' child' : ' realm'}${p.id === target ? ' active' : ''}`}
                style={{ marginLeft: Math.min(depth, 4) * 14, borderLeftColor: bar }}
              >
                <button className="geo-title" aria-pressed={p.id === target} onClick={() => setTarget(p.id)}>{p.name}</button>
                <div className="geo-area">Direct territory: <b>{hexCount(hexesOf(new Set([p.id])).length)}</b>{p.id === target && <span className="geo-badge">Active</span>}</div>
                <span className="hint">Ownership equivalent: {count(own)} whole hexes{parts > 0 ? ` · including parts: ${count(total)}` : ''}</span>
                <details className="entity-details"><summary onClick={() => setTarget(p.id)}>Names, colour and hierarchy</summary>
                <div className="row entity-fields">
                  {parts > 0 ? (
                    <button
                      className="tiny fold"
                      title={isCollapsed ? `Show the ${parts} parts of ${p.name}` : `Fold away the ${parts} parts of ${p.name}`}
                      aria-expanded={!isCollapsed}
                      onClick={() => {
                        const next = new Set(collapsed);
                        if (isCollapsed) next.delete(p.id);
                        else next.add(p.id);
                        setCollapsed(next);
                      }}
                    >
                      {isCollapsed ? '▸' : '▾'}
                    </button>
                  ) : (
                    <span className="fold-spacer" />
                  )}
                  <CommitColour
                    aria-label={`Colour of ${p.name}`}
                    title="Pick a colour"
                    className="polity-swatch"
                    value={p.colour}
                    onCommit={(next) => recolour(p, next)}
                  />
                  <CommitInput
                    className="grow"
                    aria-label="Polity name"
                    title={p.name}
                    value={p.name}
                    onCommit={(next) => dispatch({ type: 'upsertPolity', polity: { ...p, name: next } })}
                  />
                  <button
                    className="tiny danger"
                    title={`Remove ${p.name}`}
                    onClick={() => dispatch({ type: 'removePolity', id: p.id })}
                  >
                    Delete polity
                  </button>
                </div>

                <div className="row">
                  <CommitHex
                    className="hex-field"
                    aria-label={`Hex code of ${p.name}'s colour`}
                    title="Colour code: select, copy, or paste a new one"
                    value={p.colour}
                    onCommit={(next) => recolour(p, next)}
                  />
                  <button className="tiny" title={`Copy ${p.colour}`} onClick={() => copy(p)}>
                    {copied === p.id ? 'copied' : 'copy'}
                  </button>
                  {parent && (
                    <button
                      className={`tiny${p.autoShade ? ' on' : ''}`}
                      aria-pressed={Boolean(p.autoShade)}
                      title={
                        p.autoShade
                          ? `Colour follows ${parent.name} as a shade of it. Click to set it yourself.`
                          : `Make this a shade of ${parent.name}'s colour, kept in step when that changes.`
                      }
                      onClick={() =>
                        dispatch({ type: 'setPolityAutoShade', ids: [p.id], on: !p.autoShade })
                      }
                    >
                      ◐ shade
                    </button>
                  )}
                  {parts > 0 && (
                    <button
                      className={`tiny${partsFollowing === parts ? ' on' : ''}`}
                      title={
                        partsFollowing === parts
                          ? `Stop shading the parts of ${p.name}`
                          : `Shade all ${parts} parts of ${p.name} from its colour, and keep them in step`
                      }
                      onClick={() =>
                        dispatch({
                          type: 'setPolityAutoShade',
                          ids: [...partIds],
                          on: partsFollowing !== parts,
                        })
                      }
                    >
                      ◐ parts
                    </button>
                  )}

                </div>

                <div className="row">
                  <CommitInput
                    className="grow"
                    aria-label={`Short map name for ${p.name}`}
                    title="Short map name"
                    placeholder="short map name"
                    allowEmpty
                    value={p.shortName ?? ''}
                    onCommit={(shortName) =>
                      dispatch({ type: 'upsertPolity', polity: { ...p, shortName: shortName || undefined } })
                    }
                  />
                  <select
                    className="grow"
                    aria-label={`What ${p.name} is part of`}
                    title="Part of a larger polity"
                    value={p.parentId ?? ''}
                    onChange={(e) =>
                      dispatch({ type: 'upsertPolity', polity: { ...p, parentId: e.target.value || undefined } })
                    }
                  >
                    <option value="">Independent</option>
                    {data.polities
                      .filter((q) => !wouldCycle(data.polities, p.id, q.id))
                      .map((q) => (
                        <option key={q.id} value={q.id}>
                          Part of {q.name}
                        </option>
                      ))}
                  </select>
                </div>

                <div className="row">
                  <label
                    htmlFor={`city-state-${p.id}`}
                    style={{ margin: 0 }}
                    title="While small, the map names it by its capital alone"
                  >
                    <input
                      id={`city-state-${p.id}`}
                      type="checkbox"
                      checked={p.cityState === true}
                      onChange={(e) =>
                        dispatch({ type: 'upsertPolity', polity: { ...p, cityState: e.target.checked || undefined } })
                      }
                    />{' '}
                    City-state
                  </label>
                </div>
                </details>
                <div className="geo-actions">
                  <button
                    className="tiny"
                    title={`Select the ${count(own)} hexes ${p.name} holds directly`}
                    onClick={() => {
                      props.setSelection(new Set(hexesOf(new Set([p.id]))));
                      setTarget(p.id);
                    }}
                  >
                    Select direct territory ({hexCount(hexesOf(new Set([p.id])).length)})
                  </button>
                  {parts > 0 && (
                    <button
                      className="tiny"
                      title={`Select all ${count(total)} hexes of ${p.name} and its parts`}
                      onClick={() => {
                        props.setSelection(new Set(hexesOf(new Set([p.id, ...partIds]))));
                        setTarget(p.id);
                      }}
                    >
                      Select realm and parts ({hexesOf(new Set([p.id, ...partIds])).length} hexes)
                    </button>
                  )}
                </div>
              </div>
            );
          })}
      </div>

      <div className="polity-tools">
        <h3>Colours</h3>
        <div className="row">
          <button className="grow" onClick={assignContrastingColours} disabled={data.polities.length === 0}>
            Assign contrasting colours
          </button>
          <select
            aria-label="Palette for contrasting colours"
            title="How saturated the assigned colours are"
            style={{ width: 'auto' }}
            value={tone}
            onChange={(e) => setTone(e.target.value as PolityTone)}
          >
            <option value="vivid">vivid</option>
            <option value="muted">muted</option>
            <option value="pastel">pastel</option>
          </select>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={shadeWithContrast}
            onChange={(e) => setShadeWithContrast(e.target.checked)}
          />
          shade parts from their realm too
        </label>
        <p className="hint" style={{ margin: 0 }}>
          Independent polities are made to stand apart from the ones they border, longest borders
          first; a realm's territory counts as its parts' together.
        </p>
        <div className="row" style={{ marginTop: 8 }}>
          <button
            className="grow"
            disabled={shadable.length === 0 || following === shadable.length}
            onClick={() => dispatch({ type: 'setPolityAutoShade', ids: shadable.map((p) => p.id), on: true })}
          >
            Shade all parts from realms
          </button>
          <button
            disabled={following === 0}
            onClick={() => dispatch({ type: 'setPolityAutoShade', ids: shadable.map((p) => p.id), on: false })}
          >
            Stop
          </button>
        </div>
        <p className="hint" style={{ margin: 0 }}>
          {following} of {shadable.length} part{shadable.length === 1 ? '' : 's'} follow their realm's
          colour: change the realm's colour and its shaded parts update. Picking a part's colour by
          hand takes it off shading.
        </p>
      </div>

      <div className="row">
        <input placeholder="New polity name" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          type="color"
          style={{ width: 40, padding: 0, height: 28 }}
          value={colour}
          onChange={(e) => setColour(e.target.value)}
        />
        <button onClick={add}>add</button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- city editor */

function CityEditor(props: SubProps) {
  const { map, dispatch, selected } = props;
  const data = map.layers.cities.data!;
  const [name, setName] = useState('');
  const [population, setPopulation] = useState('5000');
  const target = selected.length === 1 ? selected[0]! : null;
  const targetBase = target === null ? undefined : map.layers.base.data?.[target];
  const blockedByWater = target !== null && !canHoldSettlement(targetBase, map.allowUnderwater);
  const here = data.cities;

  const add = () => {
    if (target === null || !name.trim()) return;
    const { col, row } = indexToOffset(map.cols, target);
    const city: City = {
      id: `city_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      col,
      row,
      name: name.trim(),
      population: Math.max(0, Math.round(Number(population) || 0)),
      onRiver: false,
      riverId: null,
      coastal: false,
      coastalEdges: [],
    };
    dispatch({ type: 'upsertCity', city });
    props.focusFeature(city.id);
    setName('');
  };

  return (
    <div className="stack">
      {target === null ? (
        <p className="hint">Select exactly one hex to add a city there.</p>
      ) : (
        <div className="stack">
          <label>New city at selected hex</label>
          <input placeholder="City name" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            type="number"
            style={{ width: 90 }}
            value={population}
            onChange={(e) => setPopulation(e.target.value)}
          />
          <button className="primary" onClick={add} disabled={!name.trim() || blockedByWater}>
            Create city
          </button>
        </div>
      )}
      {blockedByWater && (
        <p className="hint">
          That hex is {targetBase}. Cities can only stand on land unless underwater cities are
          enabled in Settings &gt; Map.
        </p>
      )}

      {here.length > 0 && (
        <div className="list">
          {here.map((c) => (
            <article key={c.id} aria-label={c.name} className={`geo-card ${props.focusedFeatureId === c.id ? 'active' : ''}`}>
              <button className="geo-title" aria-pressed={props.focusedFeatureId === c.id} onClick={() => { props.focusFeature(c.id); props.setSelection(new Set([hexIndex(map.cols, c.col, c.row)])); }}>{c.name}</button>
              <div className="geo-area">Location: <b>hex {c.col},{c.row}</b>{props.focusedFeatureId === c.id && <span className="geo-badge">Active</span>}</div>
              <span className="hint">Population: {c.population.toLocaleString()}</span>
              <details className="entity-details"><summary onClick={() => { props.focusFeature(c.id); props.setSelection(new Set([hexIndex(map.cols, c.col, c.row)])); }}>Edit city</summary>
              <label>City name</label>
              <CommitInput
                className="grow"
                aria-label="City name"
                value={c.name}
                onCommit={(name) => dispatch({ type: 'upsertCity', city: { ...c, name } })}
              />
              <label>Population</label>
              <CommitInput
                type="number"
                min={0}
                aria-label={`Population of ${c.name}`}
                style={{ width: 90 }}
                value={c.population}
                onCommit={(raw) =>
                  dispatch({
                    type: 'upsertCity',
                    city: { ...c, population: Math.max(0, Math.round(Number(raw) || 0)) },
                  })
                }
              />
              <button className="tiny danger" onClick={() => dispatch({ type: 'removeCity', id: c.id })}>
                Delete city
              </button>
              <div className="row" style={{ flexBasis: '100%', alignItems: 'center' }}>
                <label htmlFor={`capital-${c.id}`} style={{ margin: 0 }}>
                  <input
                    id={`capital-${c.id}`}
                    type="checkbox"
                    checked={c.capital === true}
                    onChange={(e) => dispatch({ type: 'upsertCity', city: { ...c, capital: e.target.checked || undefined } })}
                  />{' '}
                  Capital
                </label>
              </div>
              <div className="row" style={{ flexBasis: '100%', alignItems: 'center' }}>
                <label htmlFor={`site-${c.id}`} style={{ margin: 0 }}>Site</label>
                <select
                  id={`site-${c.id}`}
                  className="grow"
                  value={siteValue(c.site)}
                  onChange={(e) => dispatch({ type: 'setCitySite', id: c.id, site: parseSiteValue(e.target.value) })}
                >
                  <option value="auto">Automatic (river port, river, land between lakes, coast, or centre)</option>
                  <option value="inland">Inland, at the hex centre</option>
                  {c.onRiver && <option value="river">On its river</option>}
                  {isLakeNeck(lakeEdgesOf(c, map.layers.base.data, map.cols)) && (
                    <option value="neck">Between the lakes, on the narrow land</option>
                  )}
                  {c.coastalEdges.length > 0 && <option value="landward">Back from the shore, on the land side</option>}
                  {map.layers.base.data?.[c.row * map.cols + c.col] === 'Strait' &&
                    landEdgesOf(map.layers.base.data, map.cols, map.rows, c.col, c.row).map((e) => (
                      <option key={`bank${e}`} value={`bank:${e}`}>
                        On the strait's bank, {SIDE_NAMES[e]} side
                      </option>
                    ))}
                  {c.coastalEdges.map((e) => (
                    <option key={e} value={`coast:${e}`}>
                      {waterNameAcross(map, c, e) === 'lake' ? 'Lakeshore' : 'Coast'}, {SIDE_NAMES[e]} side
                    </option>
                  ))}
                  {c.onRiver &&
                    c.coastalEdges.map((e) => (
                      <option key={`port${e}`} value={`port:${e}`}>
                        On its river where it meets the {waterNameAcross(map, c, e) === 'lake' ? 'lake' : 'coast'}, {SIDE_NAMES[e]} side
                      </option>
                    ))}
                  {CORNER_NAMES.map((name, k) => (
                    <option key={`corner${k}`} value={`corner:${k}`}>
                      Toward the {name} corner
                    </option>
                  ))}
                  <option value="offset">Custom position in the hex</option>
                </select>
              </div>
              {c.site && typeof c.site === 'object' && 'offset' in c.site && (
                <div className="row" style={{ flexBasis: '100%', alignItems: 'center' }}>
                  {(['x', 'y'] as const).map((axis) => (
                    <label key={axis} style={{ margin: 0 }}>
                      {axis === 'x' ? 'East' : 'South'}{' '}
                      <CommitInput
                        type="number"
                        step={0.1}
                        min={-0.8}
                        max={0.8}
                        aria-label={`${axis === 'x' ? 'East' : 'South'} offset of ${c.name}, in hex sizes`}
                        style={{ width: 70 }}
                        value={(c.site as { offset: { x: number; y: number } }).offset[axis]}
                        onCommit={(raw) => {
                          const v = Math.max(-0.8, Math.min(0.8, Number(raw) || 0));
                          const offset = (c.site as { offset: { x: number; y: number } }).offset;
                          dispatch({ type: 'setCitySite', id: c.id, site: { offset: { ...offset, [axis]: v } } });
                        }}
                      />
                    </label>
                  ))}
                  <span className="hint">in hex sizes from the centre; moved onto land if it falls in water</span>
                </div>
              )}
              <div className="hint" style={{ flexBasis: '100%' }}>
                {c.coastal ? `coastal on edges ${c.coastalEdges.join(', ')}` : 'inland'}
                {c.onRiver
                  ? ` · on ${map.layers.rivers.data?.rivers.find((r) => r.id === c.riverId)?.name || 'a river'}`
                  : ''}
              </div>
              </details>
            </article>
          ))}
        </div>
      )}

      <div className="hint">
        {data.cities.length} cities on the map. Click a city name or map marker to choose it; drag its map marker to move it.
      </div>
    </div>
  );
}
