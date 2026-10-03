import { useEffect, useMemo, useState } from 'react';
import { hexIndex, indexToOffset } from '../../shared/hex.js';
import { buildRiverFromPath } from '../../shared/validate.js';
import { buildBranch, mergeRivers, removeRiverSegment, reverseRiver } from '../../shared/riverEdit.js';
import {
  branchesOf,
  formatLength,
  pathLength,
  riverLength,
  riverSystemLength,
} from '../../shared/riverLength.js';
import { normaliseHexDimensions } from '../../shared/surfaceArea.js';
import type { MapState, River } from '../../shared/types.js';
import type { Action } from '../state/store.js';
import type { RiverNotice, RiverTool, RiverToolKind } from '../state/riverTools.js';
import CommitInput from './CommitInput.js';

export interface RiverEditorProps {
  map: MapState;
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

const TOOLS: { id: ToolButton; label: string; hint: string }[] = [
  {
    id: 'select',
    label: 'Select & move',
    hint: 'Click a river to select it, or one of its hexes to pick that hex. Drag a hex of a river to move it; the river stretches to stay connected.',
  },
  {
    id: 'extend',
    label: 'Add hexes',
    hint: "Click a hex to stretch the selected river's nearer end to it. Click water to give it a new mouth; click another river to select that one instead.",
  },
  {
    id: 'navigability',
    label: 'Navigability',
    hint: 'Drag along rivers to mark the hexes you cross. One stroke is one undo step.',
  },
  {
    id: 'draw',
    label: 'Draw new',
    hint: 'Click hexes from source to mouth; hexes that do not touch are joined by a straight run. End on the Sea or Lake it empties into, or on a border hex.',
  },
];

function terminusText(river: River): string {
  switch (river.terminus) {
    case 'Sea':
      return 'reaches the sea';
    case 'Lake':
      return 'flows into a lake';
    case 'OffMap':
      return 'runs off the map';
    default:
      return 'ends inland, with no outlet';
  }
}

/** Top-level rivers in data order, each followed by its branches. */
function inTreeOrder(rivers: River[]): { river: River; depth: number }[] {
  const out: { river: River; depth: number }[] = [];
  const placed = new Set<string>();
  const visit = (river: River, depth: number) => {
    if (placed.has(river.id)) return;
    placed.add(river.id);
    out.push({ river, depth });
    for (const child of rivers.filter((r) => r.branchOf === river.id)) visit(child, depth + 1);
  };
  for (const river of rivers) if (!river.branchOf || !rivers.some((r) => r.id === river.branchOf)) visit(river, 0);
  for (const river of rivers) visit(river, 0); // anything left in a branch cycle
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

  const lengths = useMemo(() => new Map(rivers.map((r) => [r.id, riverLength(r, dims)])), [rivers, dims]);
  const total = useMemo(() => [...lengths.values()].reduce((a, b) => a + b, 0), [lengths]);

  const select = (id: string | null) => setRiverTool({ ...tool, selectedId: id });

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
      <p className="hint" style={{ margin: 0 }}>
        {TOOLS.find((t) => t.id === active)?.hint}
      </p>

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
          <label className="check">
            <input
              type="checkbox"
              checked={tool.downstream}
              onChange={(e) => setRiverTool({ ...tool, downstream: e.target.checked })}
            />
            also everything downstream of each hex I touch
          </label>
        </div>
      )}

      {draft === null && selected && (
        <SelectedRiver
          {...props}
          river={selected}
          rivers={rivers}
          length={lengths.get(selected.id) ?? 0}
          systemLength={riverSystemLength(selected, rivers, dims)}
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
  const soFar = pathLength(path, dims);

  const finish = () => {
    const base = map.layers.base.data;
    if (draft.length < 2 || !base) return;
    const id = `riv_${Date.now().toString(36)}`;
    if (parent) {
      const result = buildBranch(parent, path[0]!, path, id, base, map.layers.elevation.data, map.cols, map.rows);
      if ('error' in result) {
        setNotice({ kind: 'error', text: result.error });
        return;
      }
      const siblings = rivers.filter((r) => r.branchOf === parent.id).length;
      dispatch({ type: 'addRiver', river: { ...result.river, name: `${parent.name} (branch ${siblings + 1})` } });
    } else {
      const warnings: string[] = [];
      const river = buildRiverFromPath(
        { name: `New river ${rivers.length + 1}`, path, navigable: path.map(() => false) },
        id,
        base,
        map.layers.elevation.data,
        map.cols,
        map.rows,
        warnings,
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

  // Enter finishes, Escape cancels, Backspace takes back the last point -
  // unless the keys are going to a text field.
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
        // A branch keeps its fork hex.
        if (draft.length > (parent ? 1 : 0)) props.undoRiverDraftClick();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="notice info">
      <b>{parent ? `Branching from ${parent.name}` : 'Drawing a new river'}</b>
      <div className="hint" style={{ marginTop: 4 }}>
        {draft.length === 0
          ? 'Click the hex where it rises.'
          : `${draft.length} hex${draft.length === 1 ? '' : 'es'}${draft.length > 1 ? `, ${formatLength(soFar, props.unit, props.rounding)}` : ''} so far: ${path
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
  const picked = [...props.selection][0];
  const pickedOffset = picked === undefined ? null : indexToOffset(map.cols, picked);
  const pickedIndex = pickedOffset
    ? river.segments.findIndex((s) => s.col === pickedOffset.col && s.row === pickedOffset.row)
    : -1;
  const branches = branchesOf(river, rivers);
  const parent = river.branchOf ? rivers.find((r) => r.id === river.branchOf) ?? null : null;
  const navigable = river.segments.filter((s) => s.navigable).length;

  const setAllNavigable = (value: boolean) =>
    dispatch({ type: 'updateRiver', river: { ...river, segments: river.segments.map((s) => ({ ...s, navigable: value })) } });

  const reverse = () => {
    if (!base) return;
    const result = reverseRiver(river, base, map.layers.elevation.data, map.cols, map.rows);
    if ('error' in result) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    dispatch({ type: 'updateRiver', river: result.river });
    setNotice({
      kind: 'info',
      text: `${river.name} now flows the other way and ${terminusText(result.river)}.${
        river.branchOf ? ' It no longer leaves its parent river, so it is no longer a branch.' : ''
      }`,
    });
  };

  const removePicked = () => {
    if (!base || pickedIndex < 0) return;
    const result = removeRiverSegment(river, pickedIndex, base, map.layers.elevation.data, map.cols, map.rows);
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
      <CommitInput
        aria-label="River name"
        value={river.name}
        onCommit={(name) => dispatch({ type: 'updateRiver', river: { ...river, name } })}
      />
      <div className="river-facts">
        <span className="river-length">{formatLength(props.length, props.unit, props.rounding)}</span>
        <span className="hint">
          {river.segments.length} hex{river.segments.length === 1 ? '' : 'es'} · {terminusText(river)} ·{' '}
          {navigable === 0 ? 'not navigable' : navigable === river.segments.length ? 'navigable throughout' : `${navigable} hexes navigable`}
        </span>
      </div>
      {branches.length > 0 && (
        <div className="hint">
          With its {branches.length} branch{branches.length === 1 ? '' : 'es'}:{' '}
          {formatLength(props.systemLength, props.unit, props.rounding)} in all.
        </div>
      )}
      {parent && (
        <div className="hint">
          A branch of{' '}
          <button className="linkish" onClick={() => props.onSelect(parent.id)}>
            {parent.name}
          </button>
          .
        </div>
      )}

      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <button className="tiny" disabled={navigable === river.segments.length} onClick={() => setAllNavigable(true)}>
          all navigable
        </button>
        <button className="tiny" disabled={navigable === 0} onClick={() => setAllNavigable(false)}>
          none navigable
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

      {pickedIndex >= 0 && pickedOffset ? (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className="hint">
            Hex {pickedOffset.col},{pickedOffset.row}:
          </span>
          <button
            className="tiny"
            title="Start a distributary that leaves this river here. Use it more than once for a delta that splits three or more ways."
            onClick={() => {
              setNotice(null);
              props.setRiverDraftParent(river.id);
              props.setRiverDraft([picked!]);
            }}
          >
            branch from here
          </button>
          <button className="tiny danger" onClick={removePicked}>
            remove this hex
          </button>
        </div>
      ) : (
        <p className="hint" style={{ margin: 0 }}>
          Click one of its hexes on the map to branch from it or remove it.
        </p>
      )}

      <button className="linkish" style={{ alignSelf: 'flex-start' }} onClick={() => setShowSegments(!showSegments)}>
        {showSegments ? 'hide hex-by-hex detail' : 'hex-by-hex detail'}
      </button>
      {showSegments && <SegmentList river={river} map={map} dispatch={dispatch} />}
    </div>
  );
}

function SegmentList({ river, map, dispatch }: { river: River; map: MapState; dispatch: (a: Action) => void }) {
  return (
    <div className="segment-list">
      {river.segments.map((s, i) => {
        const elevation = map.layers.elevation.data?.[hexIndex(map.cols, s.col, s.row)];
        return (
          <label key={`${s.col},${s.row},${i}`} className="check">
            <input
              type="checkbox"
              checked={s.navigable}
              onChange={(e) => {
                const segments = river.segments.slice();
                segments[i] = { ...s, navigable: e.target.checked };
                dispatch({ type: 'updateRiver', river: { ...river, segments } });
              }}
            />
            <span>
              {s.col},{s.row}
              <span className="hint">
                {' '}
                · in {s.entryEdge ?? '–'} → out {s.exitEdge ?? '–'}
                {elevation ? ` · ${elevation}` : ''}
              </span>
            </span>
          </label>
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
  // Default to keeping the name of the longest piece, which is usually the main river.
  const keep =
    tickedRivers.find((r) => r.id === keepId) ??
    [...tickedRivers].sort((a, b) => (props.lengths.get(b.id) ?? 0) - (props.lengths.get(a.id) ?? 0))[0] ??
    null;

  const toggle = (id: string) =>
    setTicked((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  const join = () => {
    const base = map.layers.base.data;
    if (!base || !keep || tickedRivers.length < 2) return;
    const result = mergeRivers(tickedRivers, keep.id, base, map.layers.elevation.data, map.cols, map.rows);
    if ('error' in result) {
      setNotice({ kind: 'error', text: result.error });
      return;
    }
    dispatch({ type: 'mergeRivers', river: result.river, absorbed: result.absorbed });
    props.onSelect(result.river.id);
    setTicked([]);
    setJoining(false);
    const others = tickedRivers.filter((r) => r.id !== keep.id).map((r) => r.name);
    setNotice({
      kind: 'info',
      text:
        `Joined ${others.join(', ')} into ${keep.name}` +
        (result.bridged > 0 ? `, adding ${result.bridged} hex${result.bridged === 1 ? '' : 'es'} to close the gap` : '') +
        '. Undo on this layer separates them again.' +
        (result.warnings.length > 0 ? ` ${result.warnings.join(' ')}` : ''),
    });
  };

  if (rivers.length === 0) return <p className="hint">No rivers yet. Draw one, or generate the layer.</p>;

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
            Tick the sections to join, in any order. They are chained end to source, nearest ends first;
            ends that do not touch are joined across land by a straight run. Reverse a section first if it
            runs the wrong way.
          </span>
          {tickedRivers.length >= 2 && keep && (
            <>
              <label style={{ margin: 0 }}>
                Keep the name
                <select value={keep.id} onChange={(e) => setKeepId(e.target.value)}>
                  {tickedRivers.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className="primary" onClick={join}>
                Join {tickedRivers.length} rivers into {keep.name}
              </button>
            </>
          )}
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
                  aria-label={`Join ${river.name}`}
                />
              )}
              <span className="grow">
                {depth > 0 && <span className="hint">↳ </span>}
                {river.name}
              </span>
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
