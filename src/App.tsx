import { Suspense, lazy, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { GEO_KIND_LABEL, geoEligibility, geoNamesOf } from '../shared/geoNames.js';
import { hexIndex, hexLine, indexToOffset } from '../shared/hex.js';
import { canHoldSettlement, riversThroughHex } from '../shared/derive.js';
import { extendRiver, moveRiverSegment } from '../shared/riverEdit.js';
import { LAYER_META, createMapState, plannedLayers } from '../shared/layers.js';
import { generationOrder, nextGenerationWave } from '../shared/generationQueue.js';
import { instructionForLayer, planMultiLayerEdit } from '../shared/multiEdit.js';
import { LAYER_ORDER, type LayerId, type MapState } from '../shared/types.js';
import {
  detectTransport,
  generateLayer as requestLayer,
  type ProgressEvent,
  type Transport,
} from './api/client.js';
import {
  DEFAULT_PREFS,
  forgetKey,
  loadApiKey,
  loadLockedKey,
  loadPrefs,
  saveApiKey,
  saveLockedKey,
  savePrefs,
  type Prefs,
} from './api/settings.js';
import { decryptKey, encryptKey } from './api/keyvault.js';
import type { PassSelection, Roster } from '../core/rosters.js';
import type { WebchatApplied } from './components/WebchatDialog.js';
import type { MultiWebchatImportResult } from '../core/webchat.js';

/**
 * Loaded on demand. The dialog validates a pasted layer against the same Zod
 * schemas the API is given, and that validator is a good fraction of a bundle -
 * worth downloading when someone opens the dialog, not on every page load.
 */
const WebchatDialog = lazy(() => import('./components/WebchatDialog.js'));
import UnlockDialog from './components/UnlockDialog.js';
import SettingsDialog, { type SettingsTab } from './components/SettingsDialog.js';
import DecisionLog from './components/DecisionLog.js';
import PlanDialog from './components/PlanDialog.js';
import ExportPanel from './components/ExportPanel.js';
import Inspector from './components/Inspector.js';
import LayerPipeline from './components/LayerPipeline.js';
import MapView from './components/MapView.js';
import SetupScreen from './components/SetupScreen.js';
import { exportDecisions, exportJson, exportParseFriendlyJson } from './render/export.js';
import { defaultVisibility, type VisibleLayers } from './render/scene.js';
import { elevationStyleOf, resolveStyle } from './render/styles.js';
import { clearMap, loadMap, makeAutosaver } from './state/persistence.js';
import { parseMapImport, prepareLoadedMap } from './state/import.js';
import SavesDialog from './components/SavesDialog.js';
import FileMenu from './components/FileMenu.js';
import Modal from './components/Modal.js';
import ResizeMapDialog from './components/ResizeMapDialog.js';
import NewMapDialog from './components/NewMapDialog.js';
import CommitInput from './components/CommitInput.js';
import { appReducer, reducer, type Action } from './state/store.js';
import { DEFAULT_RIVER_TOOL, type RiverNotice, type RiverTool } from './state/riverTools.js';
import { normaliseHexDimensions } from '../shared/surfaceArea.js';
import { describeUsage, formatDuration } from './api/usageText.js';
import {
  loadMode,
  modeFeatures,
  saveMode,
  toggleMapFocus,
  type EditorMode,
  type PanelVisibility,
} from './state/workspace.js';

const PER_HEX: LayerId[] = ['base', 'elevation', 'climate', 'vegetation', 'population'];

interface Toast {
  text: string;
  action?: { label: string; run: () => void };
}

export default function App() {
  const [map, dispatch] = useReducer(appReducer, null);

  const [loaded, setLoaded] = useState(false);
  const [transport, setTransport] = useState<Transport>({ mode: 'server', health: null, reason: null });
  const [apiKey, setApiKey] = useState('');
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | undefined>(undefined);
  const [showDecisions, setShowDecisions] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [showSaves, setShowSaves] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showResize, setShowResize] = useState(false);
  const [showNewMap, setShowNewMap] = useState(false);
  const [webchatLayer, setWebchatLayer] = useState<LayerId | null>(null);
  // A passphrase-protected key lives on disk as ciphertext; the plaintext only
  // ever exists in `apiKey`, for this page load.
  const [lockedKey, setLockedKey] = useState<ReturnType<typeof loadLockedKey>>(null);
  const [showUnlock, setShowUnlock] = useState(false);
  const [activeLayer, setActiveLayer] = useState<LayerId>('base');
  const [visible, setVisible] = useState<VisibleLayers>(defaultVisibility);
  const { labels, riverNames, rangeNames, seaNames, landNames, polityNames, polityOpacity } = prefs;
  const mapStyle = useMemo(() => resolveStyle(prefs.mapStyle), [prefs.mapStyle]);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [panels, setPanels] = useState<PanelVisibility>({ layers: true, inspector: true });
  const panelRestore = useRef<PanelVisibility>({ layers: true, inspector: true });
  const [mobilePane, setMobilePane] = useState<'layers' | 'inspector'>('layers');
  const [mode, setModeState] = useState<EditorMode>(() => loadMode('ai'));
  const { ai: aiMode, manual: manualMode } = modeFeatures(mode);
  const [brush, setBrushState] = useState<Record<string, string>>({});
  const [brushMode, setBrushMode] = useState(false);
  /** The geographical name whose hexes the map is currently painting into; null when no name is armed. */
  const [geoPaintId, setGeoPaintId] = useState<string | null>(null);
  const [instruction, setInstruction] = useState('');
  const [busyLayers, setBusyLayers] = useState<Set<LayerId>>(new Set());
  const [selectedLayers, setSelectedLayers] = useState<Set<LayerId>>(new Set());
  const [concurrency, setConcurrency] = useState(1);
  const [progress, setProgress] = useState<Partial<Record<LayerId, ProgressEvent>>>({});
  const [error, setError] = useState<string | null>(null);
  /** A passing message over the map: what a generation took, or a way to undo a multi-layer change. */
  const [toast, setToast] = useState<Toast | null>(null);
  /** When each running generation started, for the elapsed time shown while it runs. */
  const startedAt = useRef(new Map<LayerId, number>());
  const [, setTick] = useState(0);
  const [riverDraft, setRiverDraftState] = useState<number[] | null>(null);
  /**
   * The draft's length after each click. One click can lay down a whole
   * straight run, so taking a click back removes the run, not one hex.
   */
  const [riverDraftStops, setRiverDraftStops] = useState<number[]>([]);
  const setRiverDraft = useCallback((next: number[] | null) => {
    setRiverDraftState(next);
    setRiverDraftStops(next && next.length > 0 ? [next.length] : []);
  }, []);
  const undoRiverDraftClick = useCallback(() => {
    const kept = riverDraftStops.slice(0, -1);
    setRiverDraftStops(kept);
    setRiverDraftState((draft) => (draft === null ? null : draft.slice(0, kept.at(-1) ?? 0)));
  }, [riverDraftStops]);
  /** When drawing a distributary: the river it splits from (the draft starts in the fork hex). */
  const [riverDraftParent, setRiverDraftParent] = useState<string | null>(null);
  const [riverTool, setRiverTool] = useState<RiverTool>(DEFAULT_RIVER_TOOL);
  const [riverNotice, setRiverNotice] = useState<RiverNotice | null>(null);
  /** Each mode starts clean: nothing armed, drawn or ticked in the other one carries over. */
  const setMode = useCallback((next: EditorMode) => {
    setModeState(next);
    saveMode(next);
    setBrushMode(false);
    setGeoPaintId(null);
    setRiverDraft(null);
    setRiverDraftParent(null);
    setRiverNotice(null);
    setSelection(new Set());
    setSelectedLayers(new Set());
    // The toast is about the last generation or multi-layer rewrite, which this mode did not do.
    setToast(null);
  }, [setRiverDraft]);
  const abortRef = useRef<Map<LayerId, AbortController>>(new Map());
  const batchCancelled = useRef(false);
  const mapRef = useRef<MapState | null>(map);
  const autosave = useMemo(() => makeAutosaver(), []);

  // --- boot: restore the autosaved map, and ask the server what mode it is in
  useEffect(() => {
    loadMap()
      .then((restored) => {
        if (restored) {
          // Maps autosaved before layer plans existed have every layer.
          restored.enabledLayers ??= [...LAYER_ORDER];
          restored.hexDimensions = normaliseHexDimensions(restored.hexDimensions);
          dispatch({ type: 'load', map: restored });
        }
      })
      .catch((e) => setError(`Could not read the autosave: ${e instanceof Error ? e.message : e}`))
      .finally(() => setLoaded(true));
    setApiKey(loadApiKey());
    setPrefs(loadPrefs());
    const locked = loadLockedKey();
    setLockedKey(locked);
    if (locked) setShowUnlock(true);
    void detectTransport().then(setTransport);
    autosave.onError((e) =>
      setError(`Autosave failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }, [autosave]);

  useEffect(() => {
    if (map) autosave.save(map);
    mapRef.current = map;
  }, [map, autosave]);

  useEffect(() => {
    const flush = () => void autosave.flush();
    window.addEventListener('beforeunload', flush);
    return () => window.removeEventListener('beforeunload', flush);
  }, [autosave]);

  // Keyboard shortcuts for the map. Keys typed into a field, or while a dialog
  // is open, are left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const current = mapRef.current;
      if (!current) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z') {
        e.preventDefault();
        dispatch({ type: e.shiftKey ? 'redo' : 'undo', layer: activeLayer });
      } else if (mod && key === 'y') {
        e.preventDefault();
        dispatch({ type: 'redo', layer: activeLayer });
      } else if (mod && key === 'a' && manualMode) {
        e.preventDefault();
        setSelection(new Set(Array.from({ length: current.cols * current.rows }, (_, i) => i)));
      } else if (e.key === 'Escape' && riverDraft === null) {
        // A river being drawn handles its own Escape.
        setSelection(new Set());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeLayer, riverDraft, manualMode]);

  // Tick once a second while anything is generating, so elapsed times stay current.
  useEffect(() => {
    if (busyLayers.size === 0) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busyLayers.size]);

  // A plain report fades after a while; one that offers an undo stays until used or dismissed.
  useEffect(() => {
    if (!toast || toast.action) return;
    const timer = window.setTimeout(() => setToast(null), 9000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  /** Undo the latest change on each of these layers, newest first. */
  const undoLayers = useCallback((layers: LayerId[]) => {
    for (const id of [...layers].reverse()) dispatch({ type: 'undo', layer: id });
    setToast(null);
  }, []);

  // Keep the active layer visible so edits are actually seen.
  useEffect(() => {
    setVisible((v) => (v[activeLayer] ? v : { ...v, [activeLayer]: true }));
  }, [activeLayer]);

  const setBrush = useCallback((layer: LayerId, value: string) => {
    setBrushState((b) => ({ ...b, [layer]: value }));
  }, []);

  const runGeneration = useCallback(
    async (
      layer: LayerId,
      instructionText: string | null,
      passSelection: PassSelection = 'both',
      roster: Roster | null = null,
      options: { requestInstruction?: string; keepInstruction?: boolean } = {},
    ): Promise<boolean> => {
      const requestMap = mapRef.current;
      if (!requestMap || abortRef.current.has(layer)) return false;
      setBusyLayers((current) => new Set(current).add(layer));
      startedAt.current.set(layer, Date.now());
      setError(null);
      setProgress((current) => ({ ...current, [layer]: { phase: 'starting' } }));
      const controller = new AbortController();
      abortRef.current.set(layer, controller);
      try {
        const result = await requestLayer(
          requestMap,
          layer,
          options.requestInstruction ?? instructionText,
          transport.mode,
          {
            apiKey: apiKey || null,
            model: prefs.model,
            effort: prefs.effort,
            taskBudget: prefs.taskBudget,
            offline: prefs.offline,
          },
          (event) => setProgress((current) => ({ ...current, [layer]: event })),
          controller.signal,
          passSelection,
          roster,
        );
        const action: Action = {
          type: 'applyGeneration',
          layer,
          data: result.data,
          warnings: result.warnings,
          notes: result.notes,
          decisions: result.decisions,
          model: result.model,
          instruction: instructionText,
          usage: result.usage,
          elapsedMs: result.elapsedMs,
        };
        mapRef.current = reducer(mapRef.current!, action);
        dispatch(action);
        setVisible((v) => ({ ...v, [layer]: true }));
        setActiveLayer(layer);
        const spent = describeUsage(result.model, result.usage, result.elapsedMs);
        setToast({
          text: `${LAYER_META[layer].label} ${instructionText ? 'rewritten' : 'generated'}${spent ? ` · ${spent}` : ''}.`,
        });
        if (instructionText && !options.keepInstruction) setInstruction('');
        return true;
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setError(e instanceof Error ? e.message : String(e));
        }
        return false;
      } finally {
        setBusyLayers((current) => {
          const next = new Set(current);
          next.delete(layer);
          return next;
        });
        setProgress((current) => {
          const next = { ...current };
          delete next[layer];
          return next;
        });
        abortRef.current.delete(layer);
        startedAt.current.delete(layer);
      }
    },
    [transport.mode, apiKey, prefs],
  );

  /** Generate the ticked layers, or the ones given, each after everything it reads. */
  const generateSelected = useCallback(async (layers?: LayerId[]) => {
    if (!mapRef.current || abortRef.current.size > 0) return;
    batchCancelled.current = false;
    if (layers) setSelectedLayers(new Set(layers));
    let pending = generationOrder(layers ?? selectedLayers);
    let requestFailed = false;
    while (pending.length > 0) {
      const wave = nextGenerationWave(pending, mapRef.current, concurrency);
      if (wave.length === 0) {
        if (!requestFailed) {
          setError(
            `Cannot generate the remaining selection because its required layers are neither ready nor selected: ${pending.map((id) => LAYER_META[id].label).join(', ')}.`,
          );
        }
        break;
      }
      const outcomes = await Promise.all(wave.map((id) => runGeneration(id, null)));
      const completed = wave.filter((_, index) => outcomes[index]);
      requestFailed ||= completed.length !== wave.length;
      setSelectedLayers((current) => {
        const next = new Set(current);
        for (const id of completed) next.delete(id);
        return next;
      });
      if (batchCancelled.current) break;
      pending = pending.filter((id) => !wave.includes(id));
    }
  }, [concurrency, runGeneration, selectedLayers]);

  /**
   * Apply one instruction to several layers, one request each, in pipeline
   * order. Sequential on purpose: a layer is rewritten against the layers before
   * it as they now stand, so the concurrency setting does not apply. A failure
   * or a cancel stops the run, since what follows would be built on a layer that
   * did not change.
   */
  const runMultiEdit = useCallback(
    async (text: string) => {
      const current = mapRef.current;
      if (!current || abortRef.current.size > 0) return;
      const { layers, skipped } = planMultiLayerEdit(current, selectedLayers);
      if (layers.length === 0 || !text) return;
      batchCancelled.current = false;
      const done: LayerId[] = [];
      for (const id of layers) {
        const ok = await runGeneration(id, text, 'both', null, {
          requestInstruction: instructionForLayer(text, layers, id),
          keepInstruction: true,
        });
        if (!ok) {
          if (!batchCancelled.current) {
            setError((prev) =>
              `${prev ?? 'The edit failed.'} Stopped after ${done.length} of ${layers.length} layers` +
              `${done.length > 0 ? ` (${done.map((d) => LAYER_META[d].label).join(', ')} already changed)` : ''}.`,
            );
          }
          if (done.length > 0) {
            setToast({
              text: `${done.map((d) => LAYER_META[d].label).join(', ')} ${done.length === 1 ? 'was' : 'were'} changed before the run stopped.`,
              action: { label: `undo ${done.length === 1 ? 'it' : `all ${done.length}`}`, run: () => undoLayers(done) },
            });
          }
          return;
        }
        done.push(id);
      }
      setInstruction('');
      if (done.length > 1) {
        setToast({
          text: `Rewrote ${done.map((d) => LAYER_META[d].label).join(', ')}.`,
          action: { label: `undo all ${done.length}`, run: () => undoLayers(done) },
        });
      }
      if (skipped.length > 0) {
        setError(
          `${skipped.map((d) => LAYER_META[d].label).join(', ')} had no data to edit and ${skipped.length === 1 ? 'was' : 'were'} skipped.`,
        );
      }
    },
    [runGeneration, selectedLayers, undoLayers],
  );

  // The armed name's hexes, outlined on the map while painting so its current extent is visible.
  const paintHexes = useMemo(() => {
    if (!map || !geoPaintId || activeLayer !== 'base') return null;
    return geoNamesOf(map).find((n) => n.id === geoPaintId)?.hexes ?? null;
  }, [map, geoPaintId, activeLayer]);

  const onStrokeEnd = useCallback(
    (indices: number[]) => {
      if (!map || indices.length === 0) return;
      if (geoPaintId && activeLayer === 'base') {
        // One stroke adds its eligible hexes to the armed name: one undo entry.
        const name = geoNamesOf(map).find((n) => n.id === geoPaintId);
        const base = map.layers.base.data;
        if (!name || !base) {
          setGeoPaintId(null);
          setError('The name being painted no longer exists.');
          return;
        }
        const eligible = geoEligibility(name.kind, base, map.cols, map.rows);
        if (!indices.some((i) => eligible(i) && !name.hexes.includes(i))) {
          setError(`Nothing added to "${name.name}": ${GEO_KIND_LABEL[name.kind].singular}s take ${GEO_KIND_LABEL[name.kind].accepts}`);
          return;
        }
        setError(null);
        dispatch({ type: 'nameGeo', id: name.id, kind: name.kind, name: name.name, indices });
        return;
      }
      if (!brushMode) return;
      if (activeLayer === 'polities') {
        const data = map.layers.polities.data;
        if (!data) return;
        // One stroke is one assignment, so one undo entry. '' is unclaimed wilderness.
        const target = brush.polities || null;
        if (target && !data.polities.some((p) => p.id === target)) {
          setError('The polity chosen for the brush no longer exists. Pick another in the inspector.');
          return;
        }
        dispatch({ type: 'setPolityOwner', indices, polityId: target });
        return;
      }
      if (PER_HEX.includes(activeLayer)) {
        if (!map.layers[activeLayer].data) return;
        const raw = brush[activeLayer];
        if (raw === undefined) return;
        const value =
          activeLayer === 'population'
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
      }
    },
    [map, brushMode, activeLayer, brush, geoPaintId],
  );

  const onRiverDraftClick = useCallback(
    (index: number) => {
      if (!map || riverDraft === null) return;
      const last = riverDraft[riverDraft.length - 1];
      if (last === index) return;
      setError(null);
      if (last === undefined) {
        setRiverDraftState([index]);
        setRiverDraftStops([1]);
        return;
      }
      // Hexes that do not touch are joined by a straight run, so a river can be
      // laid down in a few clicks rather than one per hex.
      const run = hexLine(indexToOffset(map.cols, last), indexToOffset(map.cols, index))
        .slice(1)
        .map((h) => hexIndex(map.cols, h.col, h.row));
      const next = [...riverDraft, ...run];
      setRiverDraftState(next);
      setRiverDraftStops((stops) => [...stops, next.length]);
    },
    [map, riverDraft],
  );

  const onRiverSelect = useCallback(
    (index: number) => {
      if (!map) return;
      const rivers = map.layers.rivers.data?.rivers ?? [];
      const through = riversThroughHex(rivers, index % map.cols, Math.floor(index / map.cols));
      if (through.length === 0) return;
      setRiverTool((tool) =>
        through.some((r) => r.id === tool.selectedId) ? tool : { ...tool, selectedId: through[0]!.id },
      );
    },
    [map],
  );

  const onRiverMove = useCallback(
    (fromIndex: number, toIndex: number) => {
      const current = mapRef.current;
      const base = current?.layers.base.data;
      if (!current || !base) return;
      const from = indexToOffset(current.cols, fromIndex);
      const through = riversThroughHex(current.layers.rivers.data?.rivers ?? [], from.col, from.row);
      const river = through.find((r) => r.id === riverTool.selectedId) ?? through[0];
      if (!river) return;
      const result = moveRiverSegment(
        river,
        river.segments.findIndex((s) => s.col === from.col && s.row === from.row),
        indexToOffset(current.cols, toIndex),
        base,
        current.layers.elevation.data,
        current.cols,
        current.rows,
        current.layers.rivers.data?.rivers ?? [],
      );
      if ('error' in result) {
        setRiverNotice({ kind: 'error', text: result.error });
        return;
      }
      setRiverNotice(null);
      dispatch({ type: 'updateRiver', river: result.river });
    },
    [riverTool.selectedId],
  );

  const onRiverExtend = useCallback(
    (index: number) => {
      const current = mapRef.current;
      const base = current?.layers.base.data;
      if (!current || !base) return;
      const river = current.layers.rivers.data?.rivers.find((r) => r.id === riverTool.selectedId);
      if (!river) {
        setRiverNotice({ kind: 'error', text: 'Select a river first, then click where it should reach.' });
        return;
      }
      const result = extendRiver(
        river,
        indexToOffset(current.cols, index),
        base,
        current.layers.elevation.data,
        current.cols,
        current.rows,
        current.layers.rivers.data?.rivers ?? [],
      );
      if ('error' in result) {
        setRiverNotice({ kind: 'error', text: result.error });
        return;
      }
      setRiverNotice(null);
      dispatch({ type: 'updateRiver', river: result.river });
    },
    [riverTool.selectedId],
  );

  const onRiverPaint = useCallback(
    (indices: number[]) => {
      dispatch({
        type: 'setRiverNavigability',
        indices,
        navigable: riverTool.paintNavigable,
        downstream: riverTool.downstream,
      });
    },
    [riverTool.paintNavigable, riverTool.downstream],
  );

  const onCityMove = useCallback(
    (cityId: string, targetIndex: number) => {
      if (!map) return;
      const city = map.layers.cities.data?.cities.find((candidate) => candidate.id === cityId);
      if (!city) return;
      const target = indexToOffset(map.cols, targetIndex);
      if (city.col === target.col && city.row === target.row) return;
      if (!canHoldSettlement(map.layers.base.data?.[targetIndex], map.allowUnderwater)) {
        setError('Cities cannot stand on water. Enable underwater cities in Settings > Map to allow it.');
        return;
      }
      setError(null);
      dispatch({ type: 'upsertCity', city: { ...city, ...target } });
    },
    [map],
  );

  /**
   * Apply a layer produced in a chat window.
   *
   * It lands through the same action as any generation, so it gets the same
   * undo entry, the same version bump and the same staleness bookkeeping - the
   * only difference is that the journal records it as imported rather than
   * crediting this app's model with the choices.
   */
  const applyWebchat = useCallback((layer: LayerId, result: WebchatApplied) => {
    const action: Action = {
      type: 'applyGeneration',
      layer,
      data: result.data,
      warnings: result.warnings,
      notes: result.notes,
      decisions: result.decisions,
      model: result.source || null,
      imported: true,
      instruction: null,
    };
    mapRef.current = reducer(mapRef.current!, action);
    dispatch(action);
    setVisible((v) => ({ ...v, [layer]: true }));
    setActiveLayer(layer);
    setWebchatLayer(null);
    setError(null);
  }, []);

  /** Several layers from one webchat reply, applied in pipeline order, each its own undo entry. */
  const applyWebchatMany = useCallback((results: MultiWebchatImportResult[], source: string, instructionText: string | null) => {
    for (const { layer, result } of results) {
      const action: Action = {
        type: 'applyGeneration',
        layer,
        data: result.data,
        warnings: result.warnings,
        notes: result.notes,
        decisions: result.decisions,
        model: source || null,
        imported: true,
        instruction: instructionText,
      };
      mapRef.current = reducer(mapRef.current!, action);
      dispatch(action);
    }
    if (instructionText) setInstruction('');
    const shown = results.map((r) => r.layer);
    if (shown.length > 1) {
      setToast({
        text: `Imported ${shown.map((id) => LAYER_META[id].label).join(', ')} from the chat reply.`,
        action: { label: `undo all ${shown.length}`, run: () => undoLayers(shown) },
      });
    }
    setVisible((v) => ({ ...v, ...Object.fromEntries(shown.map((id) => [id, true])) }));
    if (shown.length > 0) setActiveLayer(shown[shown.length - 1]!);
    setWebchatLayer(null);
    setError(null);
  }, [undoLayers]);

  const handleImport = useCallback((file: File) => {
    file
      .text()
      .then((text) => {
        const imported = prepareLoadedMap(parseMapImport(text));
        dispatch({ type: 'load', map: imported });
        setError(null);
      })
      .catch((e) => setError(`Import failed: ${e instanceof Error ? e.message : String(e)}`));
  }, []);

  const webchat =
    aiMode && webchatLayer && map ? (
      <Suspense fallback={null}>
        <WebchatDialog
          map={map}
          layer={webchatLayer}
          instruction={instruction.trim() || null}
          initialLayers={[...selectedLayers]}
          onApply={(result) => applyWebchat(webchatLayer, result)}
          onApplyMany={applyWebchatMany}
          onClose={() => setWebchatLayer(null)}
        />
      </Suspense>
    ) : null;

  const settings = showSettings ? (
    <SettingsDialog
      editorMode={mode}
      mode={transport.mode}
      apiKey={apiKey}
      prefs={prefs}
      onClose={() => setShowSettings(false)}
      locked={lockedKey !== null}
      initialTab={settingsTab}
      hexDimensions={map ? normaliseHexDimensions(map.hexDimensions) : null}
      onSaveHexDimensions={(hexDimensions) => dispatch({ type: 'setHexDimensions', hexDimensions })}
      defaultIrregularity={map?.defaultIrregularity ?? null}
      onSaveDefaultIrregularity={(irregular) => dispatch({ type: 'setDefaultIrregularity', irregular })}
      defaultLakeIrregularity={map?.defaultLakeIrregularity ?? null}
      onSaveDefaultLakeIrregularity={(irregular) => dispatch({ type: 'setDefaultLakeIrregularity', irregular })}
      allowUnderwater={map ? map.allowUnderwater === true : null}
      map={map}
      onSaveAllowUnderwater={(allow) => dispatch({ type: 'setAllowUnderwater', allow })}
      onForget={() => {
        forgetKey();
        setApiKey('');
        setLockedKey(null);
        setShowSettings(false);
      }}
      onSave={(nextKey, nextPrefs, passphrase) => {
        const trimmed = nextKey.trim();
        setPrefs(nextPrefs);
        savePrefs(nextPrefs);
        setApiKey(trimmed);
        setShowSettings(false);
        if (passphrase === null) {
          // A protected key that did not change: leave the stored ciphertext alone.
          return;
        }
        if (trimmed && passphrase && nextPrefs.remember) {
          void encryptKey(trimmed, passphrase)
            .then((payload) => {
              saveLockedKey(payload);
              setLockedKey(payload);
            })
            .catch((e) => setError(`Could not encrypt the key: ${e instanceof Error ? e.message : e}`));
        } else {
          saveApiKey(trimmed, nextPrefs.remember);
          setLockedKey(null);
        }
      }}
    />
  ) : null;

  const unlock =
    aiMode && showUnlock && lockedKey ? (
      <UnlockDialog
        onDismiss={() => setShowUnlock(false)}
        onForget={() => {
          forgetKey();
          setLockedKey(null);
          setApiKey('');
          setShowUnlock(false);
        }}
        onUnlock={async (passphrase) => {
          const plain = await decryptKey(lockedKey, passphrase);
          setApiKey(plain);
          setShowUnlock(false);
        }}
      />
    ) : null;

  const planDialog =
    showPlan && map ? (
      <PlanDialog
        map={map}
        onClose={() => setShowPlan(false)}
        onSave={(layers) => {
          dispatch({ type: 'setPlan', layers });
          // A layer that is no longer part of the map should not stay drawn on it.
          setVisible((v) => {
            const next = { ...v };
            for (const id of LAYER_ORDER) if (!layers.includes(id)) next[id] = false;
            return next;
          });
          if (!layers.includes(activeLayer)) setActiveLayer('base');
          setSelectedLayers((current) => new Set([...current].filter((id) => layers.includes(id))));
        }}
      />
    ) : null;

  const decisionLog =
    aiMode && showDecisions && map ? (
      <DecisionLog
        map={map}
        onClose={() => setShowDecisions(false)}
        onSelectHexes={(indices) => setSelection(new Set(indices))}
      />
    ) : null;

  if (!loaded) return <div className="setup">Loading…</div>;

  if (!map) {
    return (
      <>
        {settings}
        {unlock}
        <SetupScreen
          transport={transport}
          keyPresent={apiKey.trim().length > 0 || prefs.offline}
          onOpenSettings={() => setShowSettings(true)}
          onImport={handleImport}
          onCreate={(description, cols, rows, name, layers, hexDimensions) =>
            dispatch({ type: 'load', map: createMapState(description, cols, rows, name, layers, hexDimensions) })
          }
        />
      </>
    );
  }

  const canEdit = map.layers[activeLayer].data !== null;

  const cancelGeneration = () => {
    batchCancelled.current = true;
    for (const controller of abortRef.current.values()) controller.abort();
  };

  const plannedNow = LAYER_ORDER.filter((id) => map.enabledLayers.includes(id));
  const describeProgress = (layer: LayerId) => {
    const started = startedAt.current.get(layer);
    return `${progress[layer]?.phase ? ` - ${progress[layer]?.phase}` : ''}${
      progress[layer]?.chars ? ` (${progress[layer]?.chars?.toLocaleString()} chars)` : ''
    }${started ? ` · ${formatDuration(Date.now() - started)}` : ''}`;
  };

  // Messages sit at the top of the map, where the work is, rather than in a side panel.
  const banner =
    error || toast ? (
      <div className="map-messages">
        {error && (
          <div className="notice error" role="alert">
            <span>{error}</span>
            <button className="linkish" onClick={() => setError(null)}>
              dismiss
            </button>
          </div>
        )}
        {toast && (
          <div className="notice info" role="status">
            <span>{toast.text}</span>
            {toast.action && (
              <button className="tiny" onClick={toast.action.run}>
                {toast.action.label}
              </button>
            )}
            <button className="linkish" onClick={() => setToast(null)}>
              dismiss
            </button>
          </div>
        )}
      </div>
    ) : null;
  // An empty map says what to do first, or what is happening while it does it.
  const emptyMapOverlay = map.layers.base.data ? null : manualMode ? (
    <div className="card map-empty">
      <h3>This map has no land or water yet</h3>
      <p className="hint">Base Geography is empty. Start it as open sea, then paint land onto it.</p>
      <button className="primary" onClick={() => dispatch({ type: 'startLayer', layer: 'base' })}>
        Start Base Geography by hand
      </button>
    </div>
  ) : busyLayers.size > 0 ? (
    <div className="card map-empty" role="status">
      <h3>Generating {[...busyLayers].map((id) => LAYER_META[id].label).join(', ')}</h3>
      <p className="hint">
        {[...busyLayers].map((id) => describeProgress(id).replace(/^ - /, '')).join(' · ') || 'starting'}
      </p>
      <div className="progress">
        <div className="bar">
          <i />
        </div>
      </div>
      <button className="tiny" style={{ marginTop: 10 }} onClick={cancelGeneration}>
        cancel
      </button>
    </div>
  ) : (
    <div className="card map-empty">
      <h3>Start with Base Geography</h3>
      <p className="hint">
        Land and water come first; every other layer is built on them. Each generation reads the
        description in the left panel.
      </p>
      <div className="stack">
        <button className="primary" onClick={() => void runGeneration('base', null)}>
          Generate Base Geography
        </button>
        {plannedNow.length > 1 && (
          <button onClick={() => void generateSelected(plannedNow)}>
            Generate all {plannedNow.length} layers in the plan
          </button>
        )}
        <button
          className="linkish"
          onClick={() => {
            setActiveLayer('base');
            setWebchatLayer('base');
          }}
        >
          or use a chat window instead…
        </button>
      </div>
    </div>
  );


  return (
    <div className="app">
      {settings}
      {unlock}
      {planDialog}
      {showSaves && (
        <SavesDialog
          map={map}
          onLoad={(loaded) => {
            dispatch({ type: 'load', map: loaded });
            setError(null);
          }}
          onClose={() => setShowSaves(false)}
        />
      )}
      {decisionLog}
      {webchat}
      {manualMode && showResize && (
        <ResizeMapDialog
          map={map}
          onGrow={(amounts) => {
            dispatch({ type: 'growMap', amounts });
            setSelection(new Set());
          }}
          onClose={() => setShowResize(false)}
        />
      )}
      {showExport && (
        <Modal label="Export image" className="wide" onClose={() => setShowExport(false)}>
          <ExportPanel
            map={map}
            visible={visible}
            labels={labels}
            elevationStyle={elevationStyleOf(mapStyle)}
            polityOpacity={polityOpacity}
            mapStyle={mapStyle}
            riverNames={riverNames}
            rangeNames={rangeNames}
            seaNames={seaNames}
            landNames={landNames}
            polityNames={polityNames}
          />
          <div className="row" style={{ marginTop: 14, justifyContent: 'flex-end' }}>
            <button onClick={() => setShowExport(false)}>close</button>
          </div>
        </Modal>
      )}
      {showNewMap && (
        <NewMapDialog
          map={map}
          onClose={() => setShowNewMap(false)}
          onConfirmed={() => {
            setShowNewMap(false);
            void clearMap().then(() => dispatch({ type: 'reset' }));
          }}
        />
      )}
      <div className="topbar">
        <span className="brand" aria-hidden="true">⬡</span>
        <h1>
          <CommitInput
            className="map-name"
            aria-label="Map name"
            title="Rename the map"
            value={map.name}
            onCommit={(name) => dispatch({ type: 'setMeta', name })}
          />
        </h1>
        <span className="meta">
          {map.cols}×{map.rows} · {(map.cols * map.rows).toLocaleString()} hexes
        </span>
        <div className="mode-switch" role="group" aria-label="Editing mode">
          <button aria-pressed={aiMode} onClick={() => setMode('ai')} title="Describe, generate and rewrite with the model">
            AI
          </button>
          <button aria-pressed={manualMode} onClick={() => setMode('manual')} title="Edit the map by hand">
            Manual
          </button>
        </div>
        {aiMode && (
        <span
          className={`mode-pill ${transport.mode}`}
          title={
            transport.mode === 'server'
              ? 'A server holds the API key; this page never sees one.'
              : 'No server: this page calls Anthropic with the key you supplied, stored in this browser only.'
          }
        >
          {transport.mode === 'server'
            ? transport.health?.mock
              ? 'server · offline generator'
              : `server · ${transport.health?.model ?? 'ready'}`
            : prefs.offline
              ? 'your browser · offline generator'
              : apiKey
                ? `your browser · ${prefs.model}${lockedKey ? ' · unlocked' : ''}`
                : lockedKey
                  ? 'your browser · key locked'
                  : 'your browser · no key set'}
        </span>
        )}
        <span className="spacer" />
        {aiMode && lockedKey && !apiKey && (
          <button className="tiny" onClick={() => setShowUnlock(true)}>
            unlock key
          </button>
        )}
        {aiMode && (
          <button
            className="tiny"
            onClick={() => setShowDecisions(true)}
            title="What the AI decided while generating this map, and why"
          >
            decisions ({(map.journal ?? []).reduce((n, e) => n + e.decisions.length, 0)})
          </button>
        )}
        {manualMode && (
          <button className="tiny" onClick={() => setShowResize(true)} title="Add rows or columns around the map">
            ⤢ resize map
          </button>
        )}
        <button
          className="tiny settings-btn"
          onClick={() => {
            setSettingsTab(undefined);
            setShowSettings(true);
          }}
          title="Hex size, display, generation and API key"
        >
          ⚙ settings
        </button>
        <FileMenu
          onNewMap={() => setShowNewMap(true)}
          onSaves={() => setShowSaves(true)}
          onImport={handleImport}
          onExportJson={(withHistory) => exportJson(map, withHistory)}
          onExportParseJson={() => exportParseFriendlyJson(map)}
          onExportImage={() => setShowExport(true)}
          onExportDecisions={aiMode ? () => exportDecisions(map, { aiOnly: false }) : undefined}
        />
      </div>

      <div className="workspace-controls" aria-label="Workspace panels">
        <button
          className="tiny"
          aria-pressed={panels.layers}
          onClick={() => setPanels((current) => ({ ...current, layers: !current.layers }))}
        >
          {panels.layers ? 'hide' : 'show'} layers
        </button>
        <button
          className="tiny"
          onClick={() => {
            const next = toggleMapFocus(panels, panelRestore.current);
            panelRestore.current = next.previous;
            setPanels(next.panels);
          }}
        >
          {!panels.layers && !panels.inspector ? 'restore panels' : 'focus map'}
        </button>
        <button
          className="tiny"
          aria-pressed={panels.inspector}
          onClick={() => setPanels((current) => ({ ...current, inspector: !current.inspector }))}
        >
          {panels.inspector ? 'hide' : 'show'} inspector
        </button>
      </div>

      <div className="workspace">
        <div className={`sidebar ${panels.layers ? '' : 'panel-closed'} ${mobilePane === 'layers' ? 'mobile-active' : ''}`}>
          <LayerPipeline
            mode={mode}
            map={map}
            activeLayer={activeLayer}
            visible={visible}
            selectedLayers={selectedLayers}
            busyLayers={busyLayers}
            onSelect={(id) => {
              setActiveLayer(id);
              setRiverNotice(null);
              setRiverDraft(null);
              setRiverDraftParent(null);
              setSelection(new Set());
            }}
            onToggleVisible={(id) => setVisible((v) => ({ ...v, [id]: !v[id] }))}
            onToggleSelected={(id) =>
              setSelectedLayers((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            concurrency={concurrency}
            onConcurrencyChange={setConcurrency}
            onGenerateSelected={() => void generateSelected()}
            onGenerateLayers={(layers) => void generateSelected(layers)}
            onEditPlan={() => setShowPlan(true)}
            onAddLayer={(id) => {
              dispatch({ type: 'setPlan', layers: [...plannedLayers(map), id] });
              setActiveLayer(id);
              setSelection(new Set());
            }}
          />

          {aiMode && busyLayers.size > 0 && (
            <div className="section">
              {[...busyLayers].map((layer) => (
                <div className="progress" key={layer}>
                  Generating {LAYER_META[layer].label.toLowerCase()}
                  {describeProgress(layer)}
                  <div className="bar">
                    <i />
                  </div>
                </div>
              ))}
              <button
                className="tiny"
                style={{ marginTop: 6 }}
                onClick={cancelGeneration}
              >
                cancel {busyLayers.size > 1 ? 'all' : ''}
              </button>
            </div>
          )}


          {aiMode && (
            <div className="section">
              <h2>Description</h2>
              <textarea
                rows={6}
                value={map.description}
                onChange={(e) => dispatch({ type: 'setMeta', description: e.target.value })}
              />
              <p className="hint">
                Every generation reads this. Editing it does not change existing layers.
              </p>
            </div>
          )}
        </div>

        <MapView
          map={map}
          visible={visible}
          labels={labels}
          riverNames={riverNames}
          rangeNames={rangeNames}
          seaNames={seaNames}
          landNames={landNames}
          polityNames={polityNames}
          polityOpacity={polityOpacity}
          mapStyle={mapStyle}
          selection={selection}
          onSelectionChange={setSelection}
          onStrokeEnd={manualMode && canEdit && (brushMode || (geoPaintId !== null && activeLayer === 'base')) ? onStrokeEnd : null}
          activeLayer={activeLayer}
          riverDraft={manualMode ? riverDraft : null}
          onRiverDraftClick={manualMode && riverDraft !== null ? onRiverDraftClick : null}
          onCityMove={manualMode && activeLayer === 'cities' ? onCityMove : null}
          riverTool={manualMode && activeLayer === 'rivers' && riverDraft === null && map.layers.rivers.data ? riverTool : null}
          onRiverSelect={onRiverSelect}
          onRiverMove={onRiverMove}
          onRiverExtend={onRiverExtend}
          onRiverPaint={onRiverPaint}
          paintHexes={paintHexes}
          overlay={emptyMapOverlay}
          banner={banner}
        />

        <div className="mobile-workspace-tabs" role="tablist" aria-label="Map workspace">
          <button
            role="tab"
            aria-selected={mobilePane === 'layers'}
            onClick={() => setMobilePane('layers')}
          >
            Layers
          </button>
          <button
            role="tab"
            aria-selected={mobilePane === 'inspector'}
            onClick={() => setMobilePane('inspector')}
          >
            {aiMode ? 'AI' : 'Edit'}
          </button>
        </div>

        <div className={`inspector-shell ${panels.inspector ? '' : 'panel-closed'} ${mobilePane === 'inspector' ? 'mobile-active' : ''}`}>
          <Inspector
            mode={mode}
            map={map}
            dispatch={dispatch}
            activeLayer={activeLayer}
            selection={selection}
            setSelection={setSelection}
            brush={brush}
            setBrush={setBrush}
            brushMode={brushMode}
            setBrushMode={(on) => {
              setBrushMode(on);
              if (on) setGeoPaintId(null);
            }}
            geoPaintId={geoPaintId}
            setGeoPaintId={setGeoPaintId}
            instruction={instruction}
            setInstruction={setInstruction}
            onAiEdit={() => void runGeneration(activeLayer, instruction.trim())}
            selectedLayers={selectedLayers}
            onAiEditSelected={() => void runMultiEdit(instruction.trim())}
            onWebchat={() => setWebchatLayer(activeLayer)}
            onGeneratePass={(passSelection) => void runGeneration(activeLayer, null, passSelection)}
            onGenerateShortNames={() =>
              void runGeneration(
                'polities',
                'Preserve every polity full name, colour, order and size exactly. Generate only concise shortName map labels. Remove generic polity-type wording when the proper name identifies the polity; retain a distinctive type alone when it uniquely identifies that polity.',
                'roster',
              )
            }
            busy={busyLayers.size > 0}
            busyLayers={busyLayers}
            riverDraft={riverDraft}
            setRiverDraft={setRiverDraft}
            undoRiverDraftClick={undoRiverDraftClick}
            riverDraftParent={riverDraftParent}
            setRiverDraftParent={setRiverDraftParent}
            riverTool={riverTool}
            setRiverTool={setRiverTool}
            riverNotice={riverNotice}
            setRiverNotice={setRiverNotice}
            onOpenDecisionLog={() => setShowDecisions(true)}
          />
        </div>
      </div>
    </div>
  );
}
