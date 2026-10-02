import { useMemo, useState } from 'react';
import { hexIndex, indexToOffset } from '../../shared/hex.js';
import { canHoldSettlement } from '../../shared/derive.js';
import { buildRiverFromPath } from '../../shared/validate.js';
import { buildBranch, removeRiverSegment } from '../../shared/riverEdit.js';
import type { RiverTool } from '../state/riverTools.js';
import { LAYER_META, stalenessOf } from '../../shared/layers.js';
import {
  BASE_GEO_VALUES,
  CLIMATE_VALUES,
  ELEVATION_VALUES,
  VEGETATION_GROUPS,
  type City,
  type LayerId,
  type MapState,
  type Polity,
  type River,
  type VegetationGroup,
} from '../../shared/types.js';
import { planMultiLayerEdit } from '../../shared/multiEdit.js';
import { canSplit, passLabel, type PassSelection } from '../../core/rosters.js';
import type { Action } from '../state/store.js';
import { contrastingPolityColours } from '../render/palette.js';
import Legend from './Legend.js';

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
  riverDraft: number[] | null;
  setRiverDraft: (next: number[] | null) => void;
  /** Set while the draft is a distributary leaving this river. */
  riverDraftParent: string | null;
  setRiverDraftParent: (next: string | null) => void;
  riverTool: RiverTool;
  setRiverTool: (next: RiverTool) => void;
  onOpenDecisionLog: () => void;
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
    .find((e) => e.layer === layer && (e.kind === 'generate' || e.kind === 'instruct'));
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
  const [passSelection, setPassSelection] = useState<PassSelection>('both');
  const multi = useMemo(
    () => planMultiLayerEdit(map, props.selectedLayers),
    [map, props.selectedLayers],
  );

  return (
    <div className="inspector">
      {activeLayer === 'polities' && (
        <div className="section">
          <p className="hint" style={{ margin: 0 }}>
            Polity areas use the hex size set in <b>Settings → Map</b>.
          </p>
        </div>
      )}

      <div className="section">
        <h2>{meta.label}</h2>
        <p className="hint" style={{ marginTop: 0 }}>{meta.blurb}</p>

        <div className="row" style={{ marginBottom: 8 }}>
          <button
            className="tiny"
            disabled={layer.past.length === 0}
            onClick={() => dispatch({ type: 'undo', layer: activeLayer })}
            title={`${layer.past.length} step(s) back on this layer`}
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
            disabled={!layer.data}
            onClick={() => dispatch({ type: 'clearLayer', layer: activeLayer })}
          >
            clear
          </button>
        </div>

        {staleness.stale && (
          <div className="notice warn">
            <b>Stale.</b> {staleness.reasons.join('; ')}. Nothing has been changed automatically -
            regenerate this layer if you want it brought back in line.
          </div>
        )}
        {layer.notes && (
          <div className="notice info" style={{ marginTop: 8 }}>
            {layer.notes}
          </div>
        )}
        <LayerDecisions map={map} layer={activeLayer} onOpenLog={props.onOpenDecisionLog} />
        {layer.warnings.length > 0 && (
          <div className="notice warn" style={{ marginTop: 8 }}>
            <b>{layer.warnings.length} validation note{layer.warnings.length === 1 ? '' : 's'}</b>
            <ul className="warnlist">
              {layer.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {canSplit(activeLayer) && (
        <div className="section">
          <h2>Generate in passes</h2>
          <p className="hint" style={{ marginTop: 0 }}>
            This layer decides a cast and places it on the grid, and those two halves constrain each
            other — which is most of why it is the expensive one. Running them separately gives the
            model a closed set to work against instead of an open design problem.
          </p>
          <div className="row" style={{ marginTop: 6 }}>
            <select
              value={passSelection}
              disabled={props.busy}
              onChange={(e) => setPassSelection(e.target.value as PassSelection)}
              style={{ flex: 1 }}
            >
              <option value="both">Both passes</option>
              <option value="roster">{passLabel(activeLayer, 'roster')} only</option>
              <option value="paint">
                {passLabel(activeLayer, 'paint')} only — keep the current{' '}
                {passLabel(activeLayer, 'roster')}
              </option>
            </select>
            <button
              className="primary"
              disabled={props.busy || (passSelection === 'paint' && !layer.data)}
              onClick={() => props.onGeneratePass(passSelection)}
            >
              Generate
            </button>
          </div>
          {passSelection === 'paint' && !layer.data && (
            <p className="hint" style={{ marginTop: 4 }}>
              There is nothing to keep yet — generate the {passLabel(activeLayer, 'roster')} first,
              or supply one through <em>Prompt for webchat</em>.
            </p>
          )}
        </div>
      )}

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
          disabled={props.busy || !layer.data || props.instruction.trim().length === 0}
          onClick={props.onAiEdit}
        >
          Rewrite this layer with AI
        </button>
        {props.selectedLayers.size > 0 && (
          <>
            <button
              className="primary"
              style={{ marginTop: 6, width: '100%' }}
              disabled={props.busy || multi.layers.length === 0 || props.instruction.trim().length === 0}
              onClick={props.onAiEditSelected}
              title="Rewrite each ticked layer in pipeline order, each against the ones before it"
            >
              Rewrite {multi.layers.length} selected layer{multi.layers.length === 1 ? '' : 's'} with AI
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
        <button
          style={{ marginTop: 6, width: '100%' }}
          disabled={props.busy}
          onClick={props.onWebchat}
        >
          Prompt for webchat…
        </button>
        <p className="hint" style={{ marginTop: 4 }}>
          The whole layer is sent as context and comes back rewritten, so one instruction can change
          the map anywhere. To change several layers at once, tick them in the Layers list and use the
          second button. Undo is per layer. The second button builds the same prompt for you to
          run in a chat window instead, and imports the reply.
        </p>
      </div>

      <div className="section">
        <h2>Direct edit</h2>
        {!layer.data ? (
          <p className="hint">Generate this layer first, or edit an earlier one.</p>
        ) : PER_HEX.includes(activeLayer) ? (
          <PerHexEditor {...props} selected={selected} />
        ) : activeLayer === 'polities' ? (
          <PolityEditor {...props} selected={selected} />
        ) : activeLayer === 'cities' ? (
          <CityEditor {...props} selected={selected} />
        ) : (
          <RiverEditor {...props} selected={selected} />
        )}
      </div>

      <div className="section">
        <h2>Legend</h2>
        <Legend layer={activeLayer} map={map} />
      </div>
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

  const distinct = new Set(
    selected.map((i) => {
      const v = (map.layers[activeLayer].data as unknown[] | null)?.[i];
      return v === null || v === undefined ? '(none)' : String(v);
    }),
  );

  return (
    <div className="stack">
      <div>
        <label>Value to apply</label>
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
      {selected.length > 0 && (
        <div className="hint">
          Selected: {selected.slice(0, 8).map((i) => coordLabel(map, i)).join(' ')}
          {selected.length > 8 ? ` +${selected.length - 8} more` : ''}
          <br />
          Current values: {[...distinct].slice(0, 6).join(', ')}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ polity editor */

function PolityEditor(props: SubProps) {
  const { map, dispatch, selected } = props;
  const data = map.layers.polities.data!;
  const [name, setName] = useState('');
  const [colour, setColour] = useState('#b5533c');
  const [target, setTarget] = useState<string>('');

  const assignContrastingColours = () => {
    const colours = contrastingPolityColours(data.polities.map((p) => p.id), data.owner, map.cols, map.rows);
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
              <input
                className="grow"
                value={p.name}
                onChange={(e) => dispatch({ type: 'upsertPolity', polity: { ...p, name: e.target.value } })}
              />
              <input
                aria-label={`Short map name for ${p.name}`}
                title="Short map name"
                style={{ width: 90 }}
                placeholder="map name"
                value={p.shortName ?? ''}
                onChange={(e) =>
                  dispatch({
                    type: 'upsertPolity',
                    polity: { ...p, shortName: e.target.value || undefined },
                  })
                }
              />
              <input
                type="color"
                style={{ width: 32, padding: 0, height: 24 }}
                value={p.colour}
                onChange={(e) => dispatch({ type: 'upsertPolity', polity: { ...p, colour: e.target.value } })}
              />
              <span className="hint">{count}</span>
              <button className="tiny danger" onClick={() => dispatch({ type: 'removePolity', id: p.id })}>
                ×
              </button>
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
              <input
                className="grow"
                value={c.name}
                onChange={(e) => dispatch({ type: 'upsertCity', city: { ...c, name: e.target.value } })}
              />
              <input
                type="number"
                style={{ width: 90 }}
                value={c.population}
                onChange={(e) =>
                  dispatch({
                    type: 'upsertCity',
                    city: { ...c, population: Math.max(0, Math.round(Number(e.target.value) || 0)) },
                  })
                }
              />
              <button className="tiny danger" onClick={() => dispatch({ type: 'removeCity', id: c.id })}>
                ×
              </button>
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

/* ------------------------------------------------------------- river editor */

function RiverEditor(props: SubProps) {
  const { map, dispatch } = props;
  const data = map.layers.rivers.data!;
  const [openId, setOpenId] = useState<string | null>(null);
  const draft = props.riverDraft;

  const parent = props.riverDraftParent
    ? data.rivers.find((r) => r.id === props.riverDraftParent) ?? null
    : null;

  const endDraft = () => {
    props.setRiverDraft(null);
    props.setRiverDraftParent(null);
  };

  const finishDraft = () => {
    if (!draft || draft.length < 2 || !map.layers.base.data) return;
    const path = draft.map((i) => indexToOffset(map.cols, i));
    const id = `riv_${Date.now().toString(36)}`;
    if (parent) {
      const result = buildBranch(
        parent,
        path[0]!,
        path,
        id,
        map.layers.base.data,
        map.layers.elevation.data,
        map.cols,
        map.rows,
      );
      endDraft();
      if ('error' in result) return;
      const siblings = data.rivers.filter((r) => r.branchOf === parent.id).length;
      dispatch({ type: 'addRiver', river: { ...result.river, name: `${parent.name} (branch ${siblings + 1})` } });
      return;
    }
    const river = buildRiverFromPath(
      { name: `New river ${data.rivers.length + 1}`, path, navigable: path.map(() => false) },
      id,
      map.layers.base.data,
      map.layers.elevation.data,
      map.cols,
      map.rows,
      [],
    );
    endDraft();
    if (!river) return;
    dispatch({ type: 'addRiver', river });
  };

  return (
    <div className="stack">
      {draft === null ? (
        <button
          onClick={() => {
            props.setRiverDraftParent(null);
            props.setRiverDraft([]);
          }}
        >
          Draw a new river
        </button>
      ) : (
        <div className="notice info">
          {parent
            ? `Branching from ${parent.name}. Click where the branch should go, down to the Sea or Lake hex it empties into or a border hex.`
            : 'Click hexes from source to mouth. End on the Sea or Lake hex it empties into, or on a border hex.'}{' '}
          Hexes that do not touch are joined by a straight run.
          <div className="hint" style={{ marginTop: 4 }}>
            {draft.length} hexes: {draft.map((i) => coordLabel(map, i)).join(' → ') || '(none yet)'}
          </div>
          <div className="row" style={{ marginTop: 6 }}>
            <button className="primary" disabled={draft.length < 2} onClick={finishDraft}>
              finish
            </button>
            <button className="tiny" disabled={draft.length === 0} onClick={() => props.setRiverDraft(draft.slice(0, -1))}>
              undo point
            </button>
            <button className="tiny" onClick={endDraft}>
              cancel
            </button>
          </div>
        </div>
      )}

      {draft === null && data.rivers.length > 0 && <RiverToolPanel {...props} />}

      <div className="list">
        {data.rivers.map((r) => (
          <div
            key={r.id}
            className={`entry ${openId === r.id || props.riverTool.selectedId === r.id ? 'selected' : ''}`} style={{ flexWrap: 'wrap' }}>
            <input
              className="grow"
              value={r.name}
              onChange={(e) => dispatch({ type: 'updateRiver', river: { ...r, name: e.target.value } })}
            />
            <span className="hint">
              {r.segments.length} hexes · {r.terminus}
              {r.branchOf ? ` · branch of ${data.rivers.find((p) => p.id === r.branchOf)?.name ?? '?'}` : ''}
            </span>
            <button className="tiny" onClick={() => props.setRiverTool({ ...props.riverTool, selectedId: r.id })}>
              select
            </button>
            <button className="tiny" onClick={() => setOpenId(openId === r.id ? null : r.id)}>
              {openId === r.id ? 'hide' : 'segments'}
            </button>
            <button className="tiny danger" onClick={() => dispatch({ type: 'removeRiver', id: r.id })}>
              ×
            </button>
            {openId === r.id && <SegmentEditor river={r} map={map} dispatch={dispatch} />}
          </div>
        ))}
      </div>
      {data.rivers.length === 0 && <p className="hint">No rivers yet.</p>}
    </div>
  );
}

const RIVER_TOOLS: { kind: RiverTool['kind']; label: string; hint: string }[] = [
  { kind: 'select', label: 'select', hint: 'Click a river on the map to select it.' },
  {
    kind: 'move',
    label: 'move',
    hint: 'Drag one of a river\'s hexes to another land hex. The river stays connected, stretching along a straight run of hexes if needed.',
  },
  {
    kind: 'extend',
    label: 'add hexes',
    hint: 'Select a river, then click a hex to extend its nearer end there. Hexes in between are filled in with a straight run; click water to give it a new mouth.',
  },
  {
    kind: 'navigability',
    label: 'navigability',
    hint: 'Drag across river hexes to mark them. One stroke is one undo step.',
  },
];

/** Map-driven river editing: pick a tool, then work directly on the map. */
function RiverToolPanel(props: SubProps) {
  const { map, dispatch, riverTool: tool, setRiverTool } = props;
  const rivers = map.layers.rivers.data!.rivers;
  const river = rivers.find((r) => r.id === tool.selectedId) ?? null;
  const picked = [...props.selection][0];
  const pickedOffset = picked === undefined ? null : indexToOffset(map.cols, picked);
  const pickedIndex =
    river && pickedOffset
      ? river.segments.findIndex((s) => s.col === pickedOffset.col && s.row === pickedOffset.row)
      : -1;
  const [removeError, setRemoveError] = useState<string | null>(null);
  const navigableCount = river?.segments.filter((s) => s.navigable).length ?? 0;

  const removePicked = () => {
    if (!river || pickedIndex < 0 || !map.layers.base.data) return;
    const result = removeRiverSegment(
      river,
      pickedIndex,
      map.layers.base.data,
      map.layers.elevation.data,
      map.cols,
      map.rows,
    );
    if (result === null) {
      props.setSelection(new Set());
      dispatch({ type: 'removeRiver', id: river.id });
    } else if ('error' in result) {
      setRemoveError(result.error);
    } else {
      props.setSelection(new Set());
      setRemoveError(null);
      dispatch({ type: 'updateRiver', river: result.river });
    }
  };

  return (
    <div className="stack">
      <div className="row">
        {RIVER_TOOLS.map((t) => (
          <button
            key={t.kind}
            className={`tiny ${tool.kind === t.kind ? 'primary' : ''}`}
            onClick={() => setRiverTool({ ...tool, kind: t.kind })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="hint">{RIVER_TOOLS.find((t) => t.kind === tool.kind)?.hint} Show the Rivers layer to see them.</p>

      {tool.kind === 'navigability' && (
        <div className="stack">
          <div className="row">
            <button
              className={`tiny ${tool.paintNavigable ? 'primary' : ''}`}
              onClick={() => setRiverTool({ ...tool, paintNavigable: true })}
            >
              paint navigable
            </button>
            <button
              className={`tiny ${!tool.paintNavigable ? 'primary' : ''}`}
              onClick={() => setRiverTool({ ...tool, paintNavigable: false })}
            >
              paint not navigable
            </button>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 11 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={tool.downstream}
              onChange={(e) => setRiverTool({ ...tool, downstream: e.target.checked })}
            />
            also everything downstream of each hex I touch
          </label>
        </div>
      )}

      {river ? (
        <div className="stack">
          <div className="hint">
            {river.name}: {navigableCount} of {river.segments.length} hexes navigable
          </div>
          <div className="row">
            <button
              className="tiny"
              onClick={() =>
                dispatch({
                  type: 'updateRiver',
                  river: { ...river, segments: river.segments.map((s) => ({ ...s, navigable: true })) },
                })
              }
            >
              all navigable
            </button>
            <button
              className="tiny"
              onClick={() =>
                dispatch({
                  type: 'updateRiver',
                  river: { ...river, segments: river.segments.map((s) => ({ ...s, navigable: false })) },
                })
              }
            >
              none navigable
            </button>
            <button
              className="tiny"
              disabled={pickedIndex < 0}
              title="Start a distributary that leaves this river at the selected hex. Use it more than once for a delta that splits in three or more."
              onClick={() => {
                props.setRiverDraftParent(river.id);
                props.setRiverDraft([picked!]);
              }}
            >
              branch from selected hex
            </button>
            <button className="tiny danger" disabled={pickedIndex < 0} onClick={removePicked}>
              remove selected hex
            </button>
          </div>
        </div>
      ) : (
        <p className="hint">No river selected.</p>
      )}
      {removeError && <p className="hint">{removeError}</p>}
    </div>
  );
}

function SegmentEditor({
  river,
  map,
  dispatch,
}: {
  river: River;
  map: MapState;
  dispatch: (a: Action) => void;
}) {
  const toggleAll = (navigable: boolean) =>
    dispatch({
      type: 'updateRiver',
      river: { ...river, segments: river.segments.map((s) => ({ ...s, navigable })) },
    });

  return (
    <div style={{ flexBasis: '100%', marginTop: 6 }}>
      <div className="row" style={{ marginBottom: 4 }}>
        <button className="tiny" onClick={() => toggleAll(true)}>all navigable</button>
        <button className="tiny" onClick={() => toggleAll(false)}>none navigable</button>
      </div>
      {river.segments.map((s, i) => (
        <label
          key={`${s.col},${s.row},${i}`}
          style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 11, marginBottom: 2 }}
        >
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={s.navigable}
            onChange={(e) => {
              const segments = river.segments.slice();
              segments[i] = { ...s, navigable: e.target.checked };
              dispatch({ type: 'updateRiver', river: { ...river, segments } });
            }}
          />
          {s.col},{s.row}
          <span className="hint">
            in {s.entryEdge ?? '–'} → out {s.exitEdge ?? '–'}
            {map.layers.elevation.data?.[hexIndex(map.cols, s.col, s.row)]
              ? ` · ${map.layers.elevation.data[hexIndex(map.cols, s.col, s.row)]}`
              : ''}
          </span>
        </label>
      ))}
    </div>
  );
}
