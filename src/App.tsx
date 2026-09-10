import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { edgeBetween, indexToOffset } from '../shared/hex.js';
import { LAYER_META, createMapState } from '../shared/layers.js';
import { LAYER_ORDER, type LayerId, type MapState } from '../shared/types.js';
import {
  detectTransport,
  generateLayer as requestLayer,
  type ProgressEvent,
  type Transport,
} from './api/client.js';
import {
  DEFAULT_PREFS,
  loadApiKey,
  loadPrefs,
  saveApiKey,
  savePrefs,
  type Prefs,
} from './api/settings.js';
import SettingsDialog from './components/SettingsDialog.js';
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
  const [activeLayer, setActiveLayer] = useState<LayerId>('base');
  const [visible, setVisible] = useState<VisibleLayers>(defaultVisibility);
  const [labels, setLabels] = useState(true);
  const [selection, setSelection] = useState<Set<number>>(new Set());
  const [brush, setBrushState] = useState<Record<string, string>>({});
  const [brushMode, setBrushMode] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [busyLayer, setBusyLayer] = useState<LayerId | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [riverDraft, setRiverDraft] = useState<number[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const autosave = useMemo(() => makeAutosaver(), []);

  // --- boot: restore the autosaved map, and ask the server what mode it is in
  useEffect(() => {
    loadMap()
      .then((restored) => {
        if (restored) dispatch({ type: 'load', map: restored });
      })
      .catch((e) => setError(`Could not read the autosave: ${e instanceof Error ? e.message : e}`))
      .finally(() => setLoaded(true));
    setApiKey(loadApiKey());
    setPrefs(loadPrefs());
    void detectTransport().then(setTransport);
    autosave.onError((e) =>
      setError(`Autosave failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }, [autosave]);

  useEffect(() => {
    if (map) autosave.save(map);
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
      if (!map) return;
      setBusyLayer(layer);
      setError(null);
      setProgress({ phase: 'starting' });
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const result = await requestLayer(
          map,
          layer,
          instructionText,
          transport.mode,
          { apiKey: apiKey || null, model: prefs.model, effort: prefs.effort, offline: prefs.offline },
          setProgress,
          controller.signal,
        );
        dispatch({
          type: 'applyGeneration',
          layer,
          data: result.data,
          warnings: result.warnings,
          notes: result.notes,
        });
        setVisible((v) => ({ ...v, [layer]: true }));
        setActiveLayer(layer);
        if (instructionText) setInstruction('');
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        setBusyLayer(null);
        setProgress(null);
        abortRef.current = null;
      }
    },
    [map, transport.mode, apiKey, prefs],
  );

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
      onSave={(nextKey, nextPrefs) => {
        setApiKey(nextKey.trim());
        saveApiKey(nextKey, nextPrefs.remember);
        setPrefs(nextPrefs);
        savePrefs(nextPrefs);
        setShowSettings(false);
      }}
    />
  ) : null;

  if (!loaded) return <div className="setup">Loading…</div>;

  if (!map) {
    return (
      <>
        {settings}
        <SetupScreen
          transport={transport}
          keyPresent={apiKey.trim().length > 0 || prefs.offline}
          onOpenSettings={() => setShowSettings(true)}
          onImport={handleImport}
          onCreate={(description, cols, rows, name) =>
            dispatch({ type: 'load', map: createMapState(description, cols, rows, name) })
          }
        />
      </>
    );
  }

  const canEdit = map.layers[activeLayer].data !== null;


  return (
    <div className="app">
      {settings}
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
                ? `your browser · ${prefs.model}`
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
            busyLayer={busyLayer}
            onSelect={(id) => {
              setActiveLayer(id);
              setRiverDraft(null);
            }}
            onToggleVisible={(id) => setVisible((v) => ({ ...v, [id]: !v[id] }))}
            onGenerate={(id) => void runGeneration(id, null)}
          />

          {busyLayer && (
            <div className="section">
              <div className="progress">
                Generating {LAYER_META[busyLayer].label.toLowerCase()}
                {progress?.phase ? ` - ${progress.phase}` : ''}
                {progress?.chars ? ` (${progress.chars.toLocaleString()} chars)` : ''}
                <div className="bar">
                  <i />
                </div>
              </div>
              <button
                className="tiny"
                style={{ marginTop: 6 }}
                onClick={() => abortRef.current?.abort()}
              >
                cancel
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
          busy={busyLayer !== null}
          riverDraft={riverDraft}
          setRiverDraft={setRiverDraft}
        />
      </div>
    </div>
  );
}

