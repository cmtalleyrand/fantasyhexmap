import { useEffect, useMemo, useState } from 'react';
import { hexIndex, indexToOffset } from '../../shared/hex.js';
import { buildRiverFromPath } from '../../shared/validate.js';
import {
  buildBranch,
  mergeRivers,
  removeRiverSegment,
  reverseRiver,
  riverLabel,
  setRiverTributary,
  setRiverDistributary,
} from '../../shared/riverEdit.js';
import {
  branchesOf,
  formatLength,
  pathLength,
  riverLengthCorrectionFactor,
  riverLength,
  riverSystemLength,
  type RiverMeasurement,
} from '../../shared/riverLength.js';
import { normaliseHexDimensions } from '../../shared/surfaceArea.js';
import {
  segmentNavigability,
  type MapState,
  type River,
  type RiverNavigability,
} from '../../shared/types.js';
import type { Action } from '../state/store.js';
import type { RiverNotice, RiverTool, RiverToolKind } from '../state/riverTools.js';
import CommitInput from './CommitInput.js';

export interface RiverEditorProps {
  map: MapState;
  riverMeasurements?: Record<string, RiverMeasurement>;
  dispatch: (action: Action) => void;
  selection: Set<number>;
  setSelection: (next: Set<number>) => void;
  riverDraft: number[] | null;
  setRiverDraft: (next: number[] | null) => void;
  undoRiverDraftClick: () => void;
  riverDraftParent: string | null;
  setRiverDraftParent: (next: string | null) => void;
  riverTool: RiverTool;
  setRiverTool: (next: RiverTool) => void;
  notice: RiverNotice | null;
  setNotice: (next: RiverNotice | null) => void;
}

type ToolButton = RiverToolKind | 'draw';
type ReachPercent = 'any' | 0 | 10 | 20 | 30 | 40 | 50 | 60 | 70 | 80 | 90;

const REACH_OPTIONS: ReachPercent[] = ['any', 0, 10, 20, 30, 40, 50, 60, 70, 80, 90];

const TOOLS: { id: ToolButton; label: string; hint: string }[] = [
  {
    id: 'select',
    label: 'Select & move',
    hint: 'Click a river to select it, or one of its hexes to pick that hex. Drag a hex of a river to move it; the river stretches to stay connected.',
  },
  {
    id: 'extend',
    label: 'Add hexes',
    hint: 'Click a destination hex to extend the nearer end of the active river. Click a lake upstream to move its source there, or another river to join it.',
  },
  {
    id: 'navigability',
    label: 'Navigability',
    hint: 'Drag along rivers to mark hexes as non-navigable, navigable, or estuarine. Stretches taper smoothly between categories.',
  },
  {
    id: 'draw',
    label: 'Draw new',
    hint: 'Click hexes from source to mouth; hexes that do not touch are joined by a straight run. Start on a Lake to have the river flow out of it. A river can also flow on through a lake.',
  },
];

/** Compact accessible info bubble icon ("i" thingy) */
function InfoBubble({ text }: { text: string }) {
  return (
    <details className="info-bubble">
      <summary title={text} aria-label="Help">i</summary>
      <div className="info-bubble-popup">{text}</div>
    </details>
  );
}

function terminusText(river: River, rivers: River[] = []): string {
  const end = (() => {
    switch (river.terminus) {
      case 'Sea':
        return 'reaches the sea';
      case 'Lake':
        return 'flows into a lake';
      case 'River': {
        const host = rivers.find((r) => r.id === river.joins);
        return host ? `flows into the ${riverLabel(host, rivers)}` : 'flows into another river';
      }
      case 'OffMap':
        return 'runs off the map';
      default:
        return 'ends inland, with no outlet';
    }
  })();
  return river.fromLake ? `rises in a lake and ${end}` : end;
}

/** Top-level rivers in tree order, followed by distributaries and tributaries. */
function inTreeOrder(rivers: River[]): { river: River; depth: number }[] {
  const out: { river: River; depth: number }[] = [];
  const placed = new Set<string>();

  const visit = (river: River, depth: number) => {
    if (placed.has(river.id)) return;
    placed.add(river.id);
    out.push({ river, depth });
    // Children include distributaries (branchOf) and tributaries (joins)
    for (const child of rivers.filter((r) => r.branchOf === river.id || r.joins === river.id)) {
      visit(child, depth + 1);
    }
  };

  for (const river of rivers) {
    const isChild =
      (river.branchOf && rivers.some((r) => r.id === river.branchOf)) ||
      (river.joins && rivers.some((r) => r.id === river.joins));
    if (!isChild) visit(river, 0);
  }
  for (const river of rivers) visit(river, 0); // cycles
  return out;
}

export default function RiverEditor(props: RiverEditorProps) {
  const { map, riverTool: tool, setRiverTool, notice, setNotice } = props;
  const rivers = map.layers.rivers.data?.rivers ?? [];
  const base = map.layers.base.data;
  const dims = useMemo(() => normaliseHexDimensions(map.hexDimensions), [map.hexDimensions]);
  const unit = dims.unit;
  const rounding = dims.lengthRounding;
  const draft = props.riverDraft;
  const active: ToolButton = draft !== null ? 'draw' : tool.kind;
  const selected = rivers.find((r) => r.id === tool.selectedId) ?? null;

  const lengths = useMemo(
    () => new Map(rivers.map((r) => [r.id, props.riverMeasurements?.[r.id]?.length ?? riverLength(r, dims)])),
    [rivers, dims, props.riverMeasurements],
  );
  const total = useMemo(() => [...lengths.values()].reduce((a, b) => a + b, 0), [lengths]);

  const select = (id: string | null) => {
    setRiverTool({ ...tool, kind: 'select', selectedId: id });
    props.setSelection(new Set());
  };

  const endDraft = () => {
    props.setRiverDraft(null);
    props.setRiverDraftParent(null);
  };

  const chooseTool = (id: ToolButton) => {
    setNotice(null);
    if (id === 'draw') {
      props.setRiverDraftParent(null);
      props.setRiverDraft([]);
      return;
    }
    endDraft();
    setRiverTool({ ...tool, kind: id });
  };

  const currentToolDef = TOOLS.find((t) => t.id === active);

  return (
    <div className="stack">
      <div className="segmented river-tools" role="toolbar" aria-label="River tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={active === t.id ? 'seg active' : 'seg'}
            aria-pressed={active === t.id}
            onClick={() => chooseTool(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="row" style={{ alignItems: 'center', fontSize: 11, color: 'var(--ink-dim)', margin: '2px 0 6px' }}>
        <span>{currentToolDef?.label}</span>
        <InfoBubble text={currentToolDef?.hint ?? ''} />
      </div>

      {notice && (
        <div className={`notice ${notice.kind === 'error' ? 'error' : 'info'}`} role="status">
          {notice.text}{' '}
          <button className="linkish" onClick={() => setNotice(null)}>
            dismiss
          </button>
        </div>
      )}

      {draft !== null && base && (
        <DraftCard {...props} draft={draft} endDraft={endDraft} unit={unit} rounding={rounding} />
      )}

      {draft === null && tool.kind === 'navigability' && (
        <div className="stack" style={{ gap: 6, padding: '8px 10px', background: 'var(--panel-2)', borderRadius: 6 }}>
          <div className="row" style={{ alignItems: 'center' }}>
            <label style={{ margin: 0, textTransform: 'none', fontSize: 11 }}>Brush:</label>
            <div className="row" style={{ gap: 4, flex: 1 }}>
              <button
                className={`tiny ${tool.paintNavigability === 'non-navigable' ? 'primary' : ''}`}
                aria-pressed={tool.paintNavigability === 'non-navigable'}
                onClick={() => setRiverTool({ ...tool, paintNavigable: false, paintNavigability: 'non-navigable' })}
              >
                non-navigable
              </button>
              <button
                className={`tiny ${tool.paintNavigability === 'navigable' ? 'primary' : ''}`}
                aria-pressed={tool.paintNavigability === 'navigable'}
                onClick={() => setRiverTool({ ...tool, paintNavigable: true, paintNavigability: 'navigable' })}
              >
                navigable
              </button>
              <button
                className={`tiny ${tool.paintNavigability === 'estuarine' ? 'primary' : ''}`}
                aria-pressed={tool.paintNavigability === 'estuarine'}
                onClick={() => setRiverTool({ ...tool, paintNavigable: true, paintNavigability: 'estuarine' })}
              >
                estuarine
              </button>
            </div>
          </div>
          <label className="check" style={{ fontSize: 11, margin: 0 }}>
            <input
              type="checkbox"
              checked={tool.downstream}
              onChange={(e) => setRiverTool({ ...tool, downstream: e.target.checked })}
            />
            also downstream to mouth
            <InfoBubble text="When ticked, each hex you touch also marks all hexes downstream from it to the river mouth." />
          </label>
        </div>
      )}

      {draft === null && selected && (
        <SelectedRiver
          {...props}
          river={selected}
          rivers={rivers}
          length={lengths.get(selected.id) ?? 0}
          systemLength={riverSystemLength(selected, rivers, dims, props.riverMeasurements)}
          unit={unit}
          rounding={rounding}
          onSelect={select}
        />
      )}
      {draft === null && !selected && rivers.length > 0 && (
        <p className="hint" style={{ margin: 0 }}>
          No river selected. Click one on the map or in the list below.
        </p>
      )}

      <RiverList
        {...props}
        rivers={rivers}
        lengths={lengths}
        total={total}
        unit={unit}
        rounding={rounding}
        onSelect={select}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ drawing */

function DraftCard(
  props: RiverEditorProps & { draft: number[]; endDraft: () => void; unit: string; rounding: number },
) {
  const { map, dispatch, draft, endDraft, setNotice } = props;
  const rivers = map.layers.rivers.data?.rivers ?? [];
  const parent = props.riverDraftParent ? rivers.find((r) => r.id === props.riverDraftParent) ?? null : null;
  const dims = normaliseHexDimensions(map.hexDimensions);
  const path = draft.map((i) => indexToOffset(map.cols, i));
  const soFar = pathLength(path, dims) * riverLengthCorrectionFactor(dims);

  const finish = () => {
    const base = map.layers.base.data;
    if (draft.length < 2 || !base) return;
    const id = `riv_${Date.now().toString(36)}`;
    if (parent) {
      const result = buildBranch(parent, path[0]!, path, id, base, map.layers.elevation.data, map.cols, map.rows, rivers);
      if ('error' in result) {
        setNotice({ kind: 'error', text: result.error });
        return;
      }
      dispatch({ type: 'addRiver', river: result.river });
    } else {
      const warnings: string[] = [];
      const river = buildRiverFromPath(
        {
          name: `New river ${rivers.length + 1}`,
          path,
          navigable: path.map(() => false),
          navigability: path.map(() => 'non-navigable' as RiverNavigability),
        },
        id,
        base,
        map.layers.elevation.data,
        map.cols,
        map.rows,
        warnings,
        rivers,
      );
      if (!river) {
        setNotice({ kind: 'error', text: warnings.at(-1) ?? 'That river has no land to run through.' });
        return;
      }
      dispatch({ type: 'addRiver', river });
      if (warnings.length > 0) setNotice({ kind: 'info', text: warnings.join(' ') });
    }
    endDraft();
    props.setRiverTool({ ...props.riverTool, kind: 'select', selectedId: id });
    props.setSelection(new Set());
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        finish();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        endDraft();
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        if (draft.length > (parent ? 1 : 0)) props.undoRiverDraftClick();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="notice info">
      <b>{parent ? `Branching from ${riverLabel(parent, rivers)}` : 'Drawing a new river'}</b>
      <div className="hint" style={{ marginTop: 4 }}>
        {draft.length === 0
          ? 'Click the hex where it rises.'
          : `${draft.length} hex${draft.length === 1 ? '' : 'es'}${draft.length > 1 ? `, ${formatLength(soFar, props.unit, props.rounding)}` : ''}: ${path
              .map((p) => `${p.col},${p.row}`)
              .join(' → ')}`}
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <button className="primary" disabled={draft.length < 2} onClick={finish}>
          finish (Enter)
        </button>
        <button className="tiny" disabled={draft.length <= (parent ? 1 : 0)} onClick={props.undoRiverDraftClick}>
          undo last click (⌫)
        </button>
        <button className="tiny" onClick={endDraft}>
          cancel (Esc)
        </button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- selected river */

function SelectedRiver(
  props: RiverEditorProps & {
    river: River;
    rivers: River[];
    length: number;
    systemLength: number;
    unit: string;
    rounding: number;
    onSelect: (id: string | null) => void;
  },
) {
  const { map, dispatch, river, rivers, setNotice } = props;
  const [showSegments, setShowSegments] = useState(false);
  const base = map.layers.base.data;
  const picked = props.selection.size === 1 ? [...props.selection][0] : undefined;
  const pickedOffset = picked === undefined ? null : indexToOffset(map.cols, picked);
  const pickedIndex = pickedOffset
    ? river.segments.findIndex((s) => s.col === pickedOffset.col && s.row === pickedOffset.row)
    : -1;
  const branches = branchesOf(river, rivers);
  const parent = river.branchOf ? rivers.find((r) => r.id === river.branchOf) ?? null : null;
  const host = river.joins ? rivers.find((r) => r.id === river.joins) ?? null : null;

  const nonNavCount = river.segments.filter((s) => segmentNavigability(s) === 'non-navigable').length;
  const navCount = river.segments.filter((s) => segmentNavigability(s) === 'navigable').length;
  const estuarineCount = river.segments.filter((s) => segmentNavigability(s) === 'estuarine').length;

  const pickedSegment = pickedIndex < 0 ? null : river.segments[pickedIndex]!;

  const setAllNavigability = (val: RiverNavigability) =>
    dispatch({
      type: 'updateRiver',
      river: {
        ...river,
        segments: river.segments.map((s) => ({
          ...s,
          navigable: val !== 'non-navigable',
          navigability: val,
        })),
      },
    });

  const setPickedReach = (side: 'min' | 'max', value: ReachPercent) => {
    if (!pickedSegment) return;
    const reach = {
      min: pickedSegment.reach?.min ?? null,
      max: pickedSegment.reach?.max ?? null,
      [side]: value === 'any' ? null : value / 100,
    };
    const segments = river.segments.slice();
    segments[pickedIndex] = reach.min === null && reach.max === null
      ? (({ reach: _removed, ...segment }) => segment)(pickedSegment)
      : { ...pickedSegment, reach };
    dispatch({ type: 'updateRiver', river: { ...river, segments } });
  };

  const reverse = () => {
    if (!base) return;
    const result = reverseRiver(river, base, map.layers.elevation.data, map.cols, map.rows, rivers);
    if ('error' in result) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    dispatch({ type: 'updateRiver', river: result.river });
    setNotice({
      kind: 'info',
      text: `${riverLabel(river, rivers)} now flows the other way and ${terminusText(result.river, rivers)}.${
        river.branchOf ? ' It no longer leaves its parent river, so it is no longer a branch.' : ''
      }`,
    });
  };

  const removePicked = () => {
    if (!base || pickedIndex < 0) return;
    const result = removeRiverSegment(river, pickedIndex, base, map.layers.elevation.data, map.cols, map.rows, rivers);
    if (result === null) {
      props.setSelection(new Set());
      dispatch({ type: 'removeRiver', id: river.id });
      props.onSelect(null);
    } else if ('error' in result) {
      setNotice({ kind: 'error', text: result.error });
    } else {
      props.setSelection(new Set());
      setNotice(null);
      dispatch({ type: 'updateRiver', river: result.river });
    }
  };

  return (
    <div className="card river-card stack">
      <div className="geo-area"><i className="area-key" />Active river</div>
      <strong className="entity-heading">{river.name || riverLabel(river, rivers)}</strong>
      <label>River name</label>
      <CommitInput
        aria-label="River name"
        value={river.name}
        onCommit={(name) => dispatch({ type: 'updateRiver', river: { ...river, name } })}
      />

      <div className="river-facts">
        <span className="river-length">{formatLength(props.length, props.unit, props.rounding)}</span>
        <span className="hint">
          {river.segments.length} hex{river.segments.length === 1 ? '' : 'es'} · {terminusText(river, rivers)} ·{' '}
          {navCount > 0 && `${navCount} nav`}
          {estuarineCount > 0 && `${navCount > 0 ? ', ' : ''}${estuarineCount} estuarine`}
          {nonNavCount > 0 && `${navCount > 0 || estuarineCount > 0 ? ', ' : ''}${nonNavCount} non-nav`}
        </span>
      </div>

      {/* Tributary and Distributary Assignment */}
      <div className="river-rel-group">
        <div className="river-rel-row">
          <label>
            Tributary of
            <InfoBubble text="A tributary flows into another river at its mouth. Select a river to join it, or None for an independent outlet." />
          </label>
          <select
            value={river.joins ?? ''}
            onChange={(e) => {
              if (!base) return;
              const target = e.target.value ? e.target.value : null;
              const res = setRiverTributary(river, target, base, map.layers.elevation.data, map.cols, map.rows, rivers);
              if ('error' in res) {
                setNotice({ kind: 'error', text: res.error });
              } else {
                setNotice(null);
                dispatch({ type: 'updateRiver', river: res.river });
              }
            }}
          >
            <option value="">None (reaches coast / lake / map edge)</option>
            {rivers
              .filter((r) => r.id !== river.id)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {riverLabel(r, rivers)}
                </option>
              ))}
          </select>
        </div>

        <div className="river-rel-row">
          <label>
            Distributary of
            <InfoBubble text="A distributary branches from a parent river at its source (e.g. river delta). Select a parent river, or None for an independent source." />
          </label>
          <select
            value={river.branchOf ?? ''}
            onChange={(e) => {
              if (!base) return;
              const target = e.target.value ? e.target.value : null;
              const res = setRiverDistributary(river, target, base, map.layers.elevation.data, map.cols, map.rows, rivers);
              if ('error' in res) {
                setNotice({ kind: 'error', text: res.error });
              } else {
                setNotice(null);
                dispatch({ type: 'updateRiver', river: res.river });
              }
            }}
          >
            <option value="">None (independent source)</option>
            {rivers
              .filter((r) => r.id !== river.id)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {riverLabel(r, rivers)}
                </option>
              ))}
          </select>
        </div>
      </div>

      {branches.length > 0 && (
        <div className="hint">
          With its {branches.length} branch{branches.length === 1 ? '' : 'es'}:{' '}
          {formatLength(props.systemLength, props.unit, props.rounding)} in all.
        </div>
      )}
      {parent && (
        <div className="hint">
          ↳ Distributary branching from{' '}
          <button className="linkish" onClick={() => props.onSelect(parent.id)}>
            {riverLabel(parent, rivers)}
          </button>
        </div>
      )}
      {host && (
        <div className="hint">
          ⤶ Tributary emptying into{' '}
          <button className="linkish" onClick={() => props.onSelect(host.id)}>
            {riverLabel(host, rivers)}
          </button>
        </div>
      )}

      <div className="geo-actions">
        <button onClick={() => props.setSelection(new Set(river.segments.map((s) => hexIndex(map.cols, s.col, s.row))))}>
          Select course hexes
        </button>
        <button onClick={() => props.onSelect(null)}>Done editing</button>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <button className="tiny" onClick={() => setAllNavigability('non-navigable')}>
          all non-nav
        </button>
        <button className="tiny" onClick={() => setAllNavigability('navigable')}>
          all navigable
        </button>
        <button className="tiny" onClick={() => setAllNavigability('estuarine')}>
          all estuarine
        </button>
        <button className="tiny" disabled={river.segments.length < 2} onClick={reverse} title="Swap source and mouth">
          reverse flow
        </button>
        <span className="grow" />
        <button
          className="tiny danger"
          onClick={() => {
            dispatch({ type: 'removeRiver', id: river.id });
            props.onSelect(null);
          }}
        >
          delete river
        </button>
      </div>

      {pickedSegment && pickedOffset ? (
        <div className="river-hex-editor stack">
          <div className="row river-hex-heading" style={{ alignItems: 'center' }}>
            <b>Hex {pickedOffset.col},{pickedOffset.row}</b>
            <span className="hint">in {pickedSegment.entryEdge ?? '–'} → out {pickedSegment.exitEdge ?? '–'}</span>
            <span className="grow" />
            <span className={`nav-badge-pill nav-badge-${segmentNavigability(pickedSegment)}`}>
              {segmentNavigability(pickedSegment)}
            </span>
          </div>

          <div className="row" style={{ alignItems: 'center', gap: 4 }}>
            <label style={{ margin: 0, fontSize: 11 }}>Hex status:</label>
            {(['non-navigable', 'navigable', 'estuarine'] as const).map((kind) => {
              const cur = segmentNavigability(pickedSegment);
              return (
                <button
                  key={kind}
                  className={`tiny ${cur === kind ? 'primary' : ''}`}
                  aria-pressed={cur === kind}
                  onClick={() => {
                    const segments = river.segments.slice();
                    segments[pickedIndex] = {
                      ...pickedSegment,
                      navigable: kind !== 'non-navigable',
                      navigability: kind,
                    };
                    dispatch({ type: 'updateRiver', river: { ...river, segments } });
                  }}
                >
                  {kind}
                </button>
              );
            })}
          </div>

          <div className="river-reach-fields" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label style={{ margin: 0 }}>
              Min reach
              <ReachSelect value={pickedSegment.reach?.min ?? null} onChange={(value) => setPickedReach('min', value)} />
            </label>
            <label style={{ margin: 0 }}>
              Max reach
              <ReachSelect value={pickedSegment.reach?.max ?? null} onChange={(value) => setPickedReach('max', value)} />
            </label>
            <InfoBubble text="Distance guides the river course from the centre toward the hex edge before meanders are added." />
          </div>

          <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
            <button
              className="tiny"
              title="Start a distributary that leaves this river here."
              onClick={() => {
                setNotice(null);
                props.setRiverDraftParent(river.id);
                props.setRiverDraft([picked!]);
              }}
            >
              branch from here
            </button>
            <button className="tiny danger" onClick={removePicked}>
              Remove hex
            </button>
          </div>
        </div>
      ) : (
        <p className="hint" style={{ margin: 0 }}>
          Click one of its hexes on the map to adjust reach, change navigability, or branch.
        </p>
      )}

      <button className="linkish" style={{ alignSelf: 'flex-start' }} onClick={() => setShowSegments(!showSegments)}>
        {showSegments ? 'hide hex-by-hex detail' : 'hex-by-hex detail'}
      </button>
      {showSegments && (
        <SegmentList
          river={river}
          map={map}
          dispatch={dispatch}
          pickedIndex={pickedIndex}
          onPick={(index) =>
            props.setSelection(new Set([hexIndex(map.cols, river.segments[index]!.col, river.segments[index]!.row)]))
          }
        />
      )}
    </div>
  );
}

function ReachSelect({ value, onChange }: { value: number | null; onChange: (value: ReachPercent) => void }) {
  const percent: ReachPercent = value === null ? 'any' : (Math.round(value * 100) as ReachPercent);
  return (
    <select value={percent} onChange={(e) => onChange(e.target.value === 'any' ? 'any' : (Number(e.target.value) as ReachPercent))}>
      {REACH_OPTIONS.map((option) => (
        <option key={option} value={option}>
          {option === 'any' ? 'Anywhere' : `${option}%`}
        </option>
      ))}
    </select>
  );
}

function SegmentList({
  river,
  map,
  dispatch,
  pickedIndex,
  onPick,
}: {
  river: River;
  map: MapState;
  dispatch: (a: Action) => void;
  pickedIndex: number;
  onPick: (index: number) => void;
}) {
  return (
    <div className="segment-list">
      {river.segments.map((s, i) => {
        const cur = segmentNavigability(s);
        return (
          <div key={`${s.col},${s.row},${i}`} className={`segment-row ${pickedIndex === i ? 'selected' : ''}`}>
            <button aria-pressed={pickedIndex === i} onClick={() => onPick(i)}>
              Hex {s.col},{s.row}
            </button>
            <select
              value={cur}
              style={{ width: 'auto', padding: '2px 4px', fontSize: 11 }}
              onChange={(e) => {
                const val = e.target.value as RiverNavigability;
                const segments = river.segments.slice();
                segments[i] = { ...s, navigable: val !== 'non-navigable', navigability: val };
                dispatch({ type: 'updateRiver', river: { ...river, segments } });
              }}
            >
              <option value="non-navigable">non-navigable</option>
              <option value="navigable">navigable</option>
              <option value="estuarine">estuarine</option>
            </select>
            <span className="hint">
              {s.entryEdge ?? 'source'} → {s.exitEdge ?? 'mouth'}
              {map.layers.elevation.data?.[hexIndex(map.cols, s.col, s.row)]
                ? ` · ${map.layers.elevation.data[hexIndex(map.cols, s.col, s.row)]}`
                : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- the list */

function RiverList(
  props: RiverEditorProps & {
    rivers: River[];
    lengths: Map<string, number>;
    total: number;
    unit: string;
    rounding: number;
    onSelect: (id: string | null) => void;
  },
) {
  const { map, dispatch, rivers, setNotice } = props;
  const [joining, setJoining] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const [keepId, setKeepId] = useState<string>('');
  const tree = useMemo(() => inTreeOrder(rivers), [rivers]);
  const tickedRivers = ticked.map((id) => rivers.find((r) => r.id === id)).filter((r): r is River => Boolean(r));

  const keep =
    tickedRivers.find((r) => r.id === keepId) ??
    [...tickedRivers].sort((a, b) => (props.lengths.get(b.id) ?? 0) - (props.lengths.get(a.id) ?? 0))[0] ??
    null;

  const toggle = (id: string) =>
    setTicked((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  const join = () => {
    const base = map.layers.base.data;
    if (!base || !keep || tickedRivers.length < 2) return;
    const result = mergeRivers(
      tickedRivers,
      keep.id,
      base,
      map.layers.elevation.data,
      map.cols,
      map.rows,
      rivers.filter((r) => !tickedRivers.includes(r)),
    );
    if ('error' in result) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    dispatch({ type: 'mergeRivers', river: result.river, absorbed: result.absorbed });
    props.onSelect(result.river.id);
    setTicked([]);
    setJoining(false);
    const others = tickedRivers.filter((r) => r.id !== keep.id).map((r) => riverLabel(r, rivers));
    setNotice({
      kind: 'info',
      text:
        `Joined ${others.join(', ')} into ${riverLabel(keep, rivers)}` +
        (result.bridged > 0 ? `, adding ${result.bridged} hex${result.bridged === 1 ? '' : 'es'} to close the gap` : '') +
        '. Undo on this layer separates them again.' +
        (result.warnings.length > 0 ? ` ${result.warnings.join(' ')}` : ''),
    });
  };

  if (rivers.length === 0) return <p className="hint">No rivers yet. Draw one.</p>;

  return (
    <div className="stack">
      <div className="row" style={{ alignItems: 'baseline' }}>
        <b className="grow">
          {rivers.length} river{rivers.length === 1 ? '' : 's'}{' '}
          <span className="hint">· {formatLength(props.total, props.unit, props.rounding)} in all</span>
        </b>
        {rivers.length > 1 && (
          <button
            className={`tiny ${joining ? 'primary' : ''}`}
            aria-pressed={joining}
            onClick={() => {
              setJoining(!joining);
              setTicked([]);
              setKeepId('');
            }}
            title="Consolidate sections of river into one river"
          >
            {joining ? 'stop joining' : 'join rivers…'}
          </button>
        )}
      </div>

      {joining && (
        <div className="notice info stack">
          <span>
            Tick the sections to join, in any order. Nearest ends are connected across land.
            <InfoBubble text="Chained end to source, nearest ends first. Reverse a section first if it runs the wrong way." />
          </span>
          {tickedRivers.length >= 2 && keep && (
            <>
              <label style={{ margin: 0 }}>
                Keep the name
                <select value={keep.id} onChange={(e) => setKeepId(e.target.value)}>
                  {tickedRivers.map((r) => (
                    <option key={r.id} value={r.id}>
                      {riverLabel(r, rivers)}
                    </option>
                  ))}
                </select>
              </label>
              <button className="primary" onClick={join}>
                Join {tickedRivers.length} rivers into {riverLabel(keep, rivers)}
              </button>
            </>
          )}
        </div>
      )}

      {joining && (
        <div className="geo-selection-summary">
          <b>{tickedRivers.length} rivers chosen to join</b>
        </div>
      )}

      <div className="list river-list">
        {tree.map(({ river, depth }) => {
          const isSelected = props.riverTool.selectedId === river.id;
          return (
            <div
              key={river.id}
              className={`entry river-row ${isSelected ? 'selected' : ''}`}
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => (joining ? toggle(river.id) : props.onSelect(isSelected ? null : river.id))}
              role="button"
              tabIndex={0}
              aria-pressed={joining ? ticked.includes(river.id) : isSelected}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  if (joining) toggle(river.id);
                  else props.onSelect(isSelected ? null : river.id);
                }
              }}
            >
              {joining && (
                <input
                  type="checkbox"
                  style={{ width: 'auto' }}
                  checked={ticked.includes(river.id)}
                  onChange={() => toggle(river.id)}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Join ${riverLabel(river, rivers)}`}
                />
              )}
              <span className="entity-heading river-title">
                {river.branchOf && <span className="river-badge-distributary">↳ branch</span>}
                {river.joins && <span className="river-badge-tributary">⤶ tributary</span>}
                <span style={{ marginLeft: river.branchOf || river.joins ? 4 : 0 }}>
                  {river.name.trim() ? river.name : <i>{riverLabel(river, rivers)}</i>}
                </span>
              </span>
              {isSelected && <span className="geo-badge">Active</span>}
              <span className="hint">{formatLength(props.lengths.get(river.id) ?? 0, props.unit, props.rounding)}</span>
              <span className="hint" style={{ minWidth: 44, textAlign: 'right' }}>
                {river.segments.length} hex
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
