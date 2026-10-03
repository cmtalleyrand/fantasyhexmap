import { useMemo, useState } from 'react';
import { hexIndex, indexToOffset, neighbourOf } from '../../shared/hex.js';
import { canHoldSettlement } from '../../shared/derive.js';
import type { RiverNotice, RiverTool } from '../state/riverTools.js';
import RiverEditor from './RiverEditor.js';
import { LAYER_META, missingRequirements, stalenessOf } from '../../shared/layers.js';
import {
  BASE_GEO_VALUES,
  CLIMATE_VALUES,
  ELEVATION_VALUES,
  BASE_DESCRIPTIONS,
  VEGETATION_GROUPS,
  isIslandType,
  islandSpecFor,
  type BaseGeo,
  type City,
  type IslandSpec,
  type LayerId,
  type MapState,
  type Polity,
  type VegetationGroup,
} from '../../shared/types.js';
import { planMultiLayerEdit } from '../../shared/multiEdit.js';
import { canSplit, passLabel, type PassSelection } from '../../core/rosters.js';
import { isWaterSurface, type Action, type IslandSpecChange } from '../state/store.js';
import { wouldCycle } from '../../shared/polityTree.js';
import { contrastingRealmColours } from '../render/hierarchy.js';
import Legend from './Legend.js';
import CommitInput, { CommitColour } from './CommitInput.js';

const PER_HEX: LayerId[] = ['base', 'elevation', 'climate', 'vegetation', 'population'];

export interface InspectorProps {
  map: MapState;
  dispatch: (action: Action) => void;
  activeLayer: LayerId;
  selection: Set<number>;
  setSelection: (next: Set<number>) => void;
  brush: Record<string, string>;
  setBrush: (layer: LayerId, value: string) => void;
  brushMode: boolean;
  setBrushMode: (on: boolean) => void;
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
  const aboutCount =
    (layer.notes ? 1 : 0) + (latestDecisions(map, activeLayer).length > 0 ? 1 : 0) + layer.warnings.length;

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
        </div>

        {staleness.stale && (
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

      <GenerateSection
        {...props}
        hasData={hasData}
        generating={generating}
        missing={missing}
      />

      {hasData && (
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
      )}

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
        </div>
      )}

      {aboutCount > 0 && (
        <div className="section">
          <h2>About this layer</h2>
          {layer.notes && <div className="notice info">{layer.notes}</div>}
          <LayerDecisions map={map} layer={activeLayer} onOpenLog={props.onOpenDecisionLog} />
          {layer.warnings.length > 0 && (
            <details className="notice warn" style={{ marginTop: 8 }} open={layer.warnings.length <= 3}>
              <summary>
                <b>
                  {layer.warnings.length} validation note{layer.warnings.length === 1 ? '' : 's'}
                </b>
              </summary>
              <ul className="warnlist">
                {layer.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <div className="section">
        <h2>Legend</h2>
        <Legend layer={activeLayer} map={map} />
      </div>
    </div>
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
      {activeLayer === 'base' && <WaterNamePanel {...props} />}
      {activeLayer === 'elevation' && <MountainRangePanel {...props} />}
    </div>
  );
}

/**
 * What is selected: each hex's value on this layer (with what a base type
 * means, for a single hex), and the settings that belong to those hexes -
 * the islands of island hexes.
 */
function SelectionCard(props: SubProps) {
  const { map, activeLayer, selected } = props;
  if (selected.length === 0) {
    return (
      <div className="card" style={{ padding: 10 }}>
        <div className="hint" style={{ margin: 0 }}>Nothing selected. Click a hex on the map to see what it is and change it.</div>
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
      {activeLayer === 'base' && <IslandSidePanel {...props} />}
    </div>
  );
}

const SIDE_NAMES = ['east', 'south-east', 'south-west', 'west', 'north-west', 'north-east'];

function siteValue(site: City['site']): string {
  if (!site || site === 'auto') return 'auto';
  return typeof site === 'object' ? `${site.river ? 'port' : 'coast'}:${site.coast}` : site;
}

function parseSiteValue(value: string): City['site'] {
  if (value.startsWith('coast:')) return { coast: Number(value.slice(6)) };
  if (value.startsWith('port:')) return { coast: Number(value.slice(5)), river: true };
  return value === 'inland' || value === 'river' ? value : 'auto';
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
            {[0, 1, 2, 3, 4, 5].map((n) => <option key={n} value={String(n)}>{n}</option>)}
          </select>
        </label>
      </div>
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
      <label htmlFor="island-side">Side they lie against</label>
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
      <p className="hint" style={{ margin: 0 }}>A hex needs at least one island; setting both counts to 0 restores its default.</p>
    </div>
  );
}

/** Name seas, bays and lakes so they can be labelled. */
function WaterNamePanel(props: SubProps) {
  const { map, dispatch, selected } = props;
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const bodies = map.waterNames ?? [];
  const base = map.layers.base.data;
  const water = selected.filter((i) => isWaterSurface(base?.[i]));
  const existing = bodies.find((b) => b.id === target) ?? null;

  const assign = () => {
    const trimmed = (existing ? existing.name : name).trim();
    if (!trimmed || water.length === 0) return;
    dispatch({
      type: 'nameWaterBody',
      id: existing?.id ?? `water_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      name: trimmed,
      indices: water,
    });
    setName('');
    setTarget('');
  };

  return (
    <div className="stack" style={{ marginTop: 8 }}>
      <h2>Seas and lakes</h2>
      <p className="hint" style={{ marginTop: 0 }}>
        Select Sea, Lake or island hexes, then name them as a sea, bay, strait or lake. The name is set
        along the water's length. Turn on <b>Show sea and lake names</b> in Settings → Display.
      </p>
      <select value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">New name…</option>
        {bodies.map((b) => (
          <option key={b.id} value={b.id}>
            Add to {b.name}
          </option>
        ))}
      </select>
      {!existing && (
        <input
          placeholder="Name, e.g. The Sound of Mees"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && assign()}
        />
      )}
      <button
        className="primary"
        disabled={water.length === 0 || (!existing && name.trim().length === 0)}
        onClick={assign}
      >
        {existing ? `Add ${water.length} hexes to ${existing.name}` : `Name ${water.length} selected water hexes`}
      </button>
      {bodies.length > 0 && (
        <div className="list">
          {bodies.map((b) => (
            <div key={b.id} className="entry" style={{ flexWrap: 'wrap' }}>
              <CommitInput
                className="grow"
                aria-label="Water name"
                value={b.name}
                onCommit={(name) => dispatch({ type: 'renameWaterBody', id: b.id, name })}
              />
              <span className="hint">{b.hexes.length} hexes</span>
              <button className="tiny" title="Select these hexes" onClick={() => props.setSelection(new Set(b.hexes))}>
                select
              </button>
              <button className="tiny danger" onClick={() => dispatch({ type: 'removeWaterBody', id: b.id })}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
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
  // Kept with the other brush values in App, so a brush stroke on the map assigns to it.
  const target = props.brush.polities ?? '';
  const setTarget = (id: string) => props.setBrush('polities', id);

  const assignContrastingColours = () => {
    // Realms contrast with their neighbours; their parts take shades of the realm's colour.
    const colours = contrastingRealmColours(data.polities, data.owner, map.cols, map.rows);
    dispatch({ type: 'setPolityColours', colours: Object.fromEntries(colours) });
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

  return (
    <div className="stack">
      <div>
        <label>Assign selected hexes to</label>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">(unclaimed wilderness)</option>
          {data.polities.map((p) => (
            <option key={p.id} value={p.id}>
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
      <p className="hint" style={{ margin: 0 }}>
        Assignment is a strict partition: a hex has one owner or none.{' '}
        {map.allowUnderwater
          ? 'Underwater claims are allowed on this map.'
          : 'Claims on water are ignored.'}{' '}
        Brush mode assigns as you drag.
      </p>

      <div className="list">
        {data.polities.map((p) => {
          const count = data.owner.filter((id) => id === p.id).length;
          return (
            <div key={p.id} className="entry">
              <span className="swatch-dot" style={{ background: p.colour }} />
              <CommitInput
                className="grow"
                aria-label="Polity name"
                value={p.name}
                onCommit={(name) => dispatch({ type: 'upsertPolity', polity: { ...p, name } })}
              />
              <CommitInput
                aria-label={`Short map name for ${p.name}`}
                title="Short map name"
                style={{ width: 90 }}
                placeholder="map name"
                allowEmpty
                value={p.shortName ?? ''}
                onCommit={(shortName) =>
                  dispatch({ type: 'upsertPolity', polity: { ...p, shortName: shortName || undefined } })
                }
              />
              <CommitColour
                aria-label={`Colour of ${p.name}`}
                style={{ width: 32, padding: 0, height: 24 }}
                value={p.colour}
                onCommit={(colour) => dispatch({ type: 'upsertPolity', polity: { ...p, colour } })}
              />
              <button
                className="tiny"
                title={`Select the ${count} hexes ${p.name} holds`}
                onClick={() => {
                  props.setSelection(new Set(data.owner.flatMap((id, i) => (id === p.id ? [i] : []))));
                  setTarget(p.id);
                }}
              >
                {count}
              </button>
              <button className="tiny danger" onClick={() => dispatch({ type: 'removePolity', id: p.id })}>
                ×
              </button>
              <select
                aria-label={`What ${p.name} is part of`}
                title="Part of a larger polity"
                style={{ flexBasis: '100%' }}
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
          );
        })}
      </div>

      <button onClick={assignContrastingColours} disabled={data.polities.length === 0}>
        Assign contrasting colours
      </button>
      <button
        onClick={props.onGenerateShortNames}
        disabled={props.busy || data.polities.length === 0}
      >
        Generate short map names with AI
      </button>
      <p className="hint" style={{ margin: 0 }}>
        Generates only the polity roster, preserving the existing borders. Full names remain
        available in the legend.
      </p>

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
                <label htmlFor={`site-${c.id}`} style={{ margin: 0 }}>Site</label>
                <select
                  id={`site-${c.id}`}
                  className="grow"
                  value={siteValue(c.site)}
                  onChange={(e) => dispatch({ type: 'upsertCity', city: { ...c, site: parseSiteValue(e.target.value) } })}
                >
                  <option value="auto">Automatic (river port, river, coast, or centre)</option>
                  <option value="inland">Inland, at the hex centre</option>
                  {c.onRiver && <option value="river">On its river</option>}
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
                </select>
              </div>
              <div className="hint" style={{ flexBasis: '100%' }}>
                {c.coastal ? `coastal on edges ${c.coastalEdges.join(', ')}` : 'inland'}
                {c.onRiver
                  ? ` · on ${map.layers.rivers.data?.rivers.find((r) => r.id === c.riverId)?.name ?? 'a river'}`
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
