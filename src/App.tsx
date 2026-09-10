import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { edgeBetween, indexToOffset } from '../shared/hex.js';
import { LAYER_META, createMapState } from '../shared/layers.js';
import { nextGenerationWave } from '../shared/generationQueue.js';
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
import UnlockDialog from './components/UnlockDialog.js';
import SettingsDialog from './components/SettingsDialog.js';
import DecisionLog from './components/DecisionLog.js';
import PlanDialog from './components/PlanDialog.js';
import ExportPanel from './components/ExportPanel.js';
import Inspector from './components/Inspector.js';
import LayerPipeline from './components/LayerPipeline.js';
import MapView from './components/MapView.js';
import SetupScreen from './components/SetupScreen.js';
import { exportJson } from './render/export.js';
import { defaultVisibility, type VisibleLayers } from './render/scene.js';
import { clearMap, loadMap, makeAutosaver } from './state/persistence.js';
import { reducer, type Action } from './state/store.js';

const PER_HEX: LayerId[] = ['base', 'elevation', 'climate', 'vegetation', 'population'];

export default function App() {
  const [map, dispatch] = useReducer(
    (state: MapState | null, action: Action | { type: 'reset' }) => {
      if (action.type === 'reset') return null;
      if (state === null) return action.type === 'load' ? action.map : null;
      return reducer(state, action as Action);
    },
    null,
  );

  const [loaded, setLoaded] = useState(false);
  const [transport, setTransport] = useState<Transport>({ mode: 'server', health: null, reason: null });
  const [apiKey, setApiKey] = useState('');
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [showSettings, setShowSettings] = useState(false);
  const [showDecisions, setShowDecisions] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  // A passphrase-protected key lives on disk as ciphertext; the plaintext only
  // ever exists in `apiKey`, for this page load.
  const [lockedKey, setLockedKey] = useState<ReturnType<typeof loadLockedKey>>(null);
  const [showUnlock, setShowUnlock] = useState(false);
  const [activeLayer, setActiveLayer] = useState<LayerId>('base');
  const [visible, setVisible] = useState<VisibleLayers>(defaultVisibility);
  const [labels, setLabels] = useState(true);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [brush, setBrushState] = useState<Record<string, string>>({});
  const [brushMode, setBrushMode] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [busyLayers, setBusyLayers] = useState<Set<LayerId>>(new Set());
  const [concurrency, setConcurrency] = useState(1);
  const [progress, setProgress] = useState<Partial<Record<LayerId, ProgressEvent>>>({});
  const [error, setError] = useState<string | null>(null);
  const [riverDraft, setRiverDraft] = useState<number[] | null>(null);
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

  // Keep the active layer visible so edits are actually seen.
  useEffect(() => {
    setVisible((v) => (v[activeLayer] ? v : { ...v, [activeLayer]: true }));
  }, [activeLayer]);

  const setBrush = useCallback((layer: LayerId, value: string) => {
    setBrushState((b) => ({ ...b, [layer]: value }));
  }, []);

  const runGeneration = useCallback(
    async (layer: LayerId, instructionText: string | null) => {
      const requestMap = mapRef.current;
      if (!requestMap || abortRef.current.has(layer)) return;
      setBusyLayers((current) => new Set(current).add(layer));
      setError(null);
      setProgress((current) => ({ ...current, [layer]: { phase: 'starting' } }));
      const controller = new AbortController();
      abortRef.current.set(layer, controller);
      try {
        const result = await requestLayer(
          requestMap,
          layer,
          instructionText,
          transport.mode,
          { apiKey: apiKey || null, model: prefs.model, effort: prefs.effort, offline: prefs.offline },
          (event) => setProgress((current) => ({ ...current, [layer]: event })),
          controller.signal,
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
        };
        mapRef.current = reducer(mapRef.current!, action);
        dispatch(action);
        setVisible((v) => ({ ...v, [layer]: true }));
        setActiveLayer(layer);
        if (instructionText) setInstruction('');
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setError(e instanceof Error ? e.message : String(e));
        }
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
      }
    },
    [transport.mode, apiKey, prefs],
  );

  const generateRemaining = useCallback(async () => {
    if (!mapRef.current || abortRef.current.size > 0) return;
    batchCancelled.current = false;
    let pending = LAYER_ORDER.filter(
      (id) => (mapRef.current!.enabledLayers ?? LAYER_ORDER).includes(id) && !mapRef.current!.layers[id].data,
    );
    while (pending.length > 0) {
      const wave = nextGenerationWave(pending, mapRef.current, concurrency);
      if (wave.length === 0) break;
      await Promise.all(wave.map((id) => runGeneration(id, null)));
      if (batchCancelled.current) break;
      pending = pending.filter((id) => !wave.includes(id));
    }
  }, [concurrency, runGeneration]);

  const onStrokeEnd = useCallback(
    (indices: number[]) => {
      if (!map || !brushMode || indices.length === 0) return;
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
    [map, brushMode, activeLayer, brush],
  );

  const onRiverDraftClick = useCallback(
    (index: number) => {
      if (!map || riverDraft === null) return;
      const last = riverDraft[riverDraft.length - 1];
      if (last === index) return;
      if (last !== undefined) {
        const a = indexToOffset(map.cols, last);
        const b = indexToOffset(map.cols, index);
        if (edgeBetween(a, b) === -1) {
          setError('A river can only run between hexes that share an edge.');
          return;
        }
      }
      setError(null);
      setRiverDraft([...riverDraft, index]);
    },
    [map, riverDraft],
  );

  const handleImport = useCallback((file: File) => {
    file
      .text()
      .then((text) => {
        const parsed = JSON.parse(text) as { format?: string; map?: MapState };
        const imported = parsed.map ?? (parsed as unknown as MapState);
        if (!imported?.layers || !imported.cols || !imported.rows) {
          throw new Error('That file does not look like a fantasyhexmap export.');
        }
        // Older exports may omit the undo stacks; give every layer empty ones.
        imported.journal ??= [];
        imported.enabledLayers ??= [...LAYER_ORDER];
        for (const id of LAYER_ORDER) {
          const layer = imported.layers[id];
          if (!layer) throw new Error(`The file is missing the "${id}" layer.`);
          layer.past ??= [];
          layer.future ??= [];
          layer.warnings ??= [];
          layer.version ??= 0;
        }
        dispatch({ type: 'load', map: imported });
        setError(null);
      })
      .catch((e) => setError(`Import failed: ${e instanceof Error ? e.message : String(e)}`));
  }, []);

  const settings = showSettings ? (
    <SettingsDialog
      mode={transport.mode}
      apiKey={apiKey}
      prefs={prefs}
      onClose={() => setShowSettings(false)}
      locked={lockedKey !== null}
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
    showUnlock && lockedKey ? (
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
        }}
      />
    ) : null;

  const decisionLog =
    showDecisions && map ? (
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
          onCreate={(description, cols, rows, name, layers) =>
            dispatch({ type: 'load', map: createMapState(description, cols, rows, name, layers) })
          }
        />
      </>
    );
  }

  const canEdit = map.layers[activeLayer].data !== null;


  return (
    <div className="app">
      {settings}
      {unlock}
      {planDialog}
      {decisionLog}
      <div className="topbar">
        <h1>{map.name}</h1>
        <span className="meta">
          {map.cols}×{map.rows} · {(map.cols * map.rows).toLocaleString()} hexes
        </span>
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
        <span className="spacer" />
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            textTransform: 'none',
            fontSize: 12,
            margin: 0,
          }}
        >
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={labels}
            onChange={(e) => setLabels(e.target.checked)}
          />
          labels on map
        </label>
        {lockedKey && !apiKey && (
          <button className="tiny" onClick={() => setShowUnlock(true)}>
            unlock key
          </button>
        )}
        <button
          className="tiny"
          onClick={() => setShowDecisions(true)}
          title="What the AI decided while generating this map, and why"
        >
          decisions ({(map.journal ?? []).reduce((n, e) => n + e.decisions.length, 0)})
        </button>
        <button className="tiny" onClick={() => setShowSettings(true)}>
          settings
        </button>
        <button className="tiny" onClick={() => exportJson(map, false)}>
          export JSON
        </button>
        <button className="tiny" onClick={() => exportJson(map, true)} title="Includes undo history">
          export JSON + history
        </button>
        <label
          className="tiny"
          style={{
            textTransform: 'none',
            fontSize: 13,
            margin: 0,
            cursor: 'pointer',
            border: '1px solid var(--line)',
            borderRadius: 4,
            padding: '2px 6px',
            background: 'var(--panel-2)',
          }}
        >
          import JSON
          <input
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleImport(file);
              e.target.value = '';
            }}
          />
        </label>
        <button
          className="tiny danger"
          onClick={() => {
            if (!window.confirm('Discard this map and start a new one? The autosave will be erased.')) return;
            void clearMap().then(() => dispatch({ type: 'reset' }));
          }}
        >
          new map
        </button>
      </div>

      <div className="workspace">
        <div className="sidebar">
          <LayerPipeline
            map={map}
            activeLayer={activeLayer}
            visible={visible}
            busyLayers={busyLayers}
            onSelect={(id) => {
              setActiveLayer(id);
              setRiverDraft(null);
            }}
            onToggleVisible={(id) => setVisible((v) => ({ ...v, [id]: !v[id] }))}
            onGenerate={(id) => void runGeneration(id, null)}
            concurrency={concurrency}
            onConcurrencyChange={setConcurrency}
            onGenerateRemaining={() => void generateRemaining()}
            onEditPlan={() => setShowPlan(true)}
          />

          {busyLayers.size > 0 && (
            <div className="section">
              {[...busyLayers].map((layer) => (
                <div className="progress" key={layer}>
                  Generating {LAYER_META[layer].label.toLowerCase()}
                  {progress[layer]?.phase ? ` - ${progress[layer]?.phase}` : ''}
                  {progress[layer]?.chars ? ` (${progress[layer]?.chars?.toLocaleString()} chars)` : ''}
                  <div className="bar">
                    <i />
                  </div>
                </div>
              ))}
              <button
                className="tiny"
                style={{ marginTop: 6 }}
                onClick={() => {
                  batchCancelled.current = true;
                  for (const controller of abortRef.current.values()) controller.abort();
                }}
              >
                cancel {busyLayers.size > 1 ? 'all' : ''}
              </button>
            </div>
          )}

          {error && (
            <div className="section">
              <div className="notice error">
                {error}
                <div style={{ marginTop: 6 }}>
                  <button className="tiny" onClick={() => setError(null)}>
                    dismiss
                  </button>
                </div>
              </div>
            </div>
          )}

          <ExportPanel map={map} visible={visible} />

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
        </div>

        <MapView
          map={map}
          visible={visible}
          labels={labels}
          selection={selection}
          onSelectionChange={setSelection}
          onStrokeEnd={brushMode && canEdit ? onStrokeEnd : null}
          activeLayer={activeLayer}
          riverDraft={riverDraft}
          onRiverDraftClick={riverDraft !== null ? onRiverDraftClick : null}
        />

        <Inspector
          map={map}
          dispatch={dispatch}
          activeLayer={activeLayer}
          selection={selection}
          setSelection={setSelection}
          brush={brush}
          setBrush={setBrush}
          brushMode={brushMode}
          setBrushMode={setBrushMode}
          instruction={instruction}
          setInstruction={setInstruction}
          onAiEdit={() => void runGeneration(activeLayer, instruction.trim())}
          busy={busyLayers.size > 0}
          riverDraft={riverDraft}
          setRiverDraft={setRiverDraft}
          onOpenDecisionLog={() => setShowDecisions(true)}
        />
      </div>
    </div>
  );
}
