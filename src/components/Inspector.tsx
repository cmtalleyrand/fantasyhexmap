import { useMemo, useState } from 'react';
import { hexIndex, indexToOffset, neighbourOf } from '../../shared/hex.js';
import { canHoldSettlement } from '../../shared/derive.js';
import { landEdgesOf } from '../../shared/straits.js';
import { isLakeNeck, lakeEdgesOf } from '../render/sites.js';
import { holdersOf } from '../../shared/polityShares.js';
import type { RiverNotice, RiverTool } from '../state/riverTools.js';
import RiverEditor from './RiverEditor.js';
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
  hasChannelWidth,
  CHANNEL_WIDTH_PERCENT,
  CHANNEL_WIDTH_VALUES,
  type ChannelWidth,
  hexShapeFor,
  DEFAULT_LAKE_IRREGULARITY,
  isIslandType,
  isShapedType,
  islandSpecFor,
  ISLAND_ARRANGEMENTS,
  ISLAND_ORIENTATIONS,
  type IslandArrangement,
  type IslandOrientation,
  type BaseGeo,
  type City,
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
  /** AI mode shows prompting and generation; manual mode shows hand editing. Never both. */
  mode: EditorMode;
  map: MapState;
  dispatch: (action: Action) => void;
  activeLayer: LayerId;
  selection: Set<number>;
  setSelection: (next: Set<number>) => void;
  brush: Record<string, string>;
  setBrush: (layer: LayerId, value: string) => void;
  brushMode: boolean;
  setBrushMode: (on: boolean) => void;
  /** The geographical name being painted into on the map, if any. */
  geoPaintId: string | null;
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
  onOpenDecisionLog: () => void;
}

/** The decisions recorded by the latest generation or rewrite of a layer. */
function latestDecisions(map: MapState, layer: LayerId) {
  const latest = [...(map.journal ?? [])]
    .reverse()
    .find((e) => e.layer === layer && (e.kind === 'generate' || e.kind === 'instruct' || e.kind === 'import'));
  return latest?.decisions ?? [];
}

/** The reasoning behind the layer being edited, as the model reported it. */
function LayerDecisions({
  map,
  layer,
  onOpenLog,
}: {
  map: MapState;
  layer: LayerId;
  onOpenLog: () => void;
}) {
  const latest = [...(map.journal ?? [])]
    .reverse()
    .find((e) => e.layer === layer && (e.kind === 'generate' || e.kind === 'instruct' || e.kind === 'import'));
  if (!latest || latest.decisions.length === 0) return null;
  return (
    <div className="notice info" style={{ marginTop: 8 }}>
      <b>Why it looks like this</b>
      <ul className="warnlist">
        {latest.decisions.slice(0, 4).map((d, i) => (
          <li key={i}>
            <b>{d.title}.</b> {d.detail}
          </li>
        ))}
      </ul>
      <button className="tiny" style={{ marginTop: 6 }} onClick={onOpenLog}>
        {latest.decisions.length > 4
          ? `+${latest.decisions.length - 4} more · full record`
          : 'full record'}
      </button>
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
  // Notes closed by the user stay closed until the layer's notes change.
  const [dismissed, setDismissed] = useState<string | null>(null);
  const warningsKey = `${activeLayer}\n${layer.warnings.join('\n')}`;
  const shownWarnings = dismissed === warningsKey ? [] : layer.warnings;
  const aboutCount =
    (layer.notes ? 1 : 0) + (latestDecisions(map, activeLayer).length > 0 ? 1 : 0) + shownWarnings.length;

  const ai = props.mode === 'ai';
  return (
    <div className="inspector">
      <div className="section">
        <h2>{meta.label}</h2>
        <p className="hint" style={{ marginTop: 0 }}>{meta.blurb}</p>

        <div className="row" style={{ marginBottom: 8 }}>
          <button
            className="tiny"
            disabled={layer.past.length === 0}
            onClick={() => dispatch({ type: 'undo', layer: activeLayer })}
            title={`${layer.past.length} step(s) back on this layer (Ctrl+Z)`}
          >
            ↶ undo ({layer.past.length})
          </button>
          <button
            className="tiny"
            disabled={layer.future.length === 0}
            onClick={() => dispatch({ type: 'redo', layer: activeLayer })}
          >
            ↷ redo ({layer.future.length})
          </button>
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
                Each layer keeps its own undo.
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
          {layer.notes && <div className="notice info">{layer.notes}</div>}
          <LayerDecisions map={map} layer={activeLayer} onOpenLog={props.onOpenDecisionLog} />
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
    ? baseSurfaceStatistics(base, dimensions, map.islandSpecs, map.hexShapes)
    : landLayerSurfaceStatistics(
        map.layers[layer].data as (string | null)[],
        values,
        base,
        dimensions,
        map.islandSpecs,
        map.hexShapes,
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
          onChange={(e) => props.setBrushMode(e.target.checked)}
        />
        Brush mode - apply the value as you drag across the map
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
        Click a hex to select it; shift-click or shift-drag adds to the selection. Ctrl+A (⌘A) selects every hex, Esc clears.
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
      <div className="card" style={{ padding: 10 }}>
        <div className="hint" style={{ margin: 0 }}>{readOnly ? 'Nothing selected. Click a hex on the map to see what it is.' : 'Nothing selected. Click a hex on the map to see what it is and change it.'}</div>
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
    <div className="card stack" style={{ padding: 10, gap: 6 }}>
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
        <div className="hint" style={{ margin: 0 }}>{BASE_DESCRIPTIONS[only as BaseGeo]}</div>
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
  const hexes = selected.filter((i) => isShapedType(base?.[i]) || base?.[i] === 'Lake');
  if (hexes.length === 0) return null;
  // A lake takes an irregularity for its own shore too; unset, its shore follows the land beside it, then the map's lake setting.
  const shaped = hexes;
  const irregularOf = (i: number): Irregularity =>
    base![i] === 'Lake'
      ? (map.hexShapes?.[String(i)]?.type === 'Lake' ? map.hexShapes[String(i)]!.irregular : undefined) ?? map.defaultLakeIrregularity ?? DEFAULT_LAKE_IRREGULARITY
      : hexShapeFor(base![i], map.hexShapes?.[String(i)], map.defaultIrregularity).irregular;
  const dims = normaliseHexDimensions(map.hexDimensions);
  const percentOf = (i: number, withShape: boolean) =>
    Math.round(landFraction(base![i], map.islandSpecs?.[String(i)], dims, withShape ? map.hexShapes?.[String(i)] : undefined) * 100);
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
  const land = sharedOf(landHexes.map((i) => String(percentOf(i, true))));
  const usual = sharedOf(landHexes.map((i) => String(percentOf(i, false))));
  const irregular = sharedOf(shaped.map(irregularOf));
  const usualIrregular = sharedOf(shaped.map((i) => (base![i] === 'Lake' ? map.defaultLakeIrregularity ?? DEFAULT_LAKE_IRREGULARITY : map.defaultIrregularity ?? DEFAULT_IRREGULARITY[base![i]!])));
  const customised = hexes.some((i) => {
    const stored = map.hexShapes?.[String(i)];
    return stored !== undefined && stored.type === base![i];
  });
  const set = (change: HexShapeChange | null) => dispatch({ type: 'setHexShape', indices: hexes, change });
  const concentrated = hexes.filter((i) => base![i] === 'Coastal Land' || base![i] === 'Mainland and islands');
  const concentrationSide = sharedOf(concentrated.map((i) => String(hexShapeFor(base![i], map.hexShapes?.[String(i)]).concentrationSide ?? -1)));
  const concentration = sharedOf(concentrated.map((i) => String(hexShapeFor(base![i], map.hexShapes?.[String(i)]).concentration ?? 0)));
  const landValue = Number(land);
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
            {LAND_SHARE_STEPS.map((p) => <option key={p} value={String(p)}>{p}%</option>)}
          </select>
          <p className="hint" style={{ margin: 0 }}>
            How much of the hex is drawn as land, and counted in surface areas.{usual !== '' ? ` Usually ${usual}%.` : ''}
            {channelHexes.length > 0
              ? ' For an isthmus or strait the width below sets how narrow it is at its thinnest; a land share as well tunes how much land there is round that, widening or narrowing the flared ends of a neck and the banks of a channel.'
              : ''}
            {landHexes.some((i) => base![i] === 'Lake')
              ? ' In a lake hex this is land drawn in from the edges it shares with land (the lake keeps the rest); 0% leaves the lake as it is.'
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
          Keeps the same land share while shifting more of its mainland towards one hex side. At 0% the land remains evenly distributed; 100% gives the strongest bias.
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

function parseSiteValue(value: string): City['site'] {
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

/** Name groups of Mountains hexes so they can be labelled as ranges. */
function MountainRangePanel(props: SubProps) {
  const { map, dispatch, selected } = props;
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const ranges = map.mountainRanges ?? [];
  const elevation = map.layers.elevation.data;
  const mountains = selected.filter((i) => elevation?.[i] === 'Mountains');
  const liveCount = (hexes: number[]) => hexes.filter((i) => elevation?.[i] === 'Mountains').length;
  const existing = ranges.find((r) => r.id === target) ?? null;

  const assign = () => {
    const trimmed = (existing ? existing.name : name).trim();
    if (!trimmed || mountains.length === 0) return;
    dispatch({
      type: 'nameMountainRange',
      id: existing?.id ?? `range_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: trimmed,
      indices: mountains,
    });
    setName('');
    setTarget('');
  };

  return (
    <div className="stack" style={{ marginTop: 8 }}>
      <h2>Mountain ranges</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Select Mountains hexes on the map, then name them as a range. Turn on{' '}
        <b>Show mountain range names</b> in Settings → Display to see the names.
      </p>
      <div className="row">
        <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ flex: 1 }}>
          <option value="">New range…</option>
          {ranges.map((r) => (
            <option key={r.id} value={r.id}>
              Add to {r.name}
            </option>
          ))}
        </select>
      </div>
      {!existing && (
        <input
          placeholder="Range name, e.g. The Kelder Spine"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && assign()}
        />
      )}
      <button
        className="primary"
        disabled={mountains.length === 0 || (!existing && name.trim().length === 0)}
        onClick={assign}
      >
        {existing ? `Add ${mountains.length} hexes to ${existing.name}` : `Name ${mountains.length} selected Mountains hexes`}
      </button>
      {selected.length > 0 && mountains.length < selected.length && (
        <p className="hint" style={{ margin: 0 }}>
          {selected.length - mountains.length} selected hex(es) are not Mountains and are ignored.
        </p>
      )}
      <div className="list">
        {ranges.map((r) => (
          <div key={r.id} className="entry" style={{ flexWrap: 'wrap' }}>
            <CommitInput
              className="grow"
              aria-label="Range name"
              value={r.name}
              onCommit={(name) => dispatch({ type: 'renameMountainRange', id: r.id, name })}
            />
            <span className="hint">{liveCount(r.hexes)} hexes</span>
            <button
              className="tiny"
              title="Select this range's hexes"
              onClick={() => props.setSelection(new Set(r.hexes.filter((i) => elevation?.[i] === 'Mountains')))}
            >
              select
            </button>
            <button className="tiny danger" onClick={() => dispatch({ type: 'removeMountainRange', id: r.id })}>
              ×
            </button>
          </div>
        ))}
      </div>
      {ranges.length === 0 && <p className="hint">No named ranges yet.</p>}
    </div>
  );
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
  const setTarget = (id: string) => props.setBrush('polities', id);

  // Realms followed by their parts, so a realm and its provinces sit together.
  const outline = useMemo(() => polityOutline(data.polities), [data.polities]);
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
      <div className="row">
        <button
          className="primary grow"
          disabled={selected.length === 0}
          onClick={() => dispatch({ type: 'setPolityOwner', indices: selected, polityId: target || null })}
        >
          Assign {selected.length} hexes
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, textTransform: 'none', fontSize: 11, marginBottom: 0 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={props.brushMode}
            onChange={(e) => props.setBrushMode(e.target.checked)}
          />
          brush
        </label>
      </div>
      <div>
        <label>Or share selected hexes between that polity and</label>
        <div className="row">
          <select className="grow" value={shareWith} onChange={(e) => setShareWith(e.target.value)}>
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
        <button
          style={{ marginTop: 4 }}
          disabled={selected.length === 0 || !target || !shareWith}
          title={target ? undefined : 'Choose the polity to assign to above first'}
          onClick={() =>
            dispatch({ type: 'shareHexes', indices: selected, first: target, second: shareWith, share: sharePercent / 100 })
          }
        >
          Share {selected.length} hexes ({100 - sharePercent}% / {sharePercent}%)
        </button>
      </div>
      <p className="hint" style={{ margin: 0 }}>
        A hex has one owner, none, or is shared between two polities in the proportion you choose; a strait left unclaimed is shared by the realms on its banks.{' '}
        {map.allowUnderwater
          ? 'Underwater claims are allowed on this map.'
          : 'Claims on water are ignored.'}{' '}
        Brush mode assigns as you drag.
      </p>

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
                className={`polity-entry${depth > 0 ? ' child' : ' realm'}`}
                style={{ marginLeft: Math.min(depth, 4) * 14, borderLeftColor: bar }}
              >
                <div className="row">
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
                    ×
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
                  <span className="grow" />
                  <button
                    className="tiny"
                    title={`Select the ${count(own)} hexes ${p.name} holds directly`}
                    onClick={() => {
                      props.setSelection(new Set(hexesOf(new Set([p.id]))));
                      setTarget(p.id);
                    }}
                  >
                    {count(own)}
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
                      Σ {count(total)}
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
  const here = data.cities.filter((c) => selected.includes(hexIndex(map.cols, c.col, c.row)));

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
    setName('');
  };

  return (
    <div className="stack">
      {target === null ? (
        <p className="hint">Select exactly one hex to add a city there.</p>
      ) : (
        <div className="row">
          <input placeholder="City name" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            type="number"
            style={{ width: 90 }}
            value={population}
            onChange={(e) => setPopulation(e.target.value)}
          />
          <button className="primary" onClick={add} disabled={!name.trim() || blockedByWater}>
            add
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
            <div key={c.id} className="entry" style={{ flexWrap: 'wrap' }}>
              <CommitInput
                className="grow"
                aria-label="City name"
                value={c.name}
                onCommit={(name) => dispatch({ type: 'upsertCity', city: { ...c, name } })}
              />
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
                ×
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
                  onChange={(e) => dispatch({ type: 'upsertCity', city: { ...c, site: parseSiteValue(e.target.value) } })}
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
                          dispatch({ type: 'upsertCity', city: { ...c, site: { offset: { ...offset, [axis]: v } } } });
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
            </div>
          ))}
        </div>
      )}

      <div className="hint">
        {data.cities.length} cities on the map. Coastal edges and river membership are derived from
        the map, not typed in, so they stay true when the geography changes.
      </div>
    </div>
  );
}
