import { useState } from 'react';
import type { Effort } from '../../core/config.js';
import { looksLikeKey, type Prefs } from '../api/settings.js';
import type { TransportMode } from '../api/client.js';

const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 (best maps)' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (cheaper, faster)' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (cheapest, roughest)' },
];

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface SettingsDialogProps {
  mode: TransportMode;
  apiKey: string;
  prefs: Prefs;
  onSave: (apiKey: string, prefs: Prefs) => void;
  onClose: () => void;
}

export default function SettingsDialog(props: SettingsDialogProps) {
  const [key, setKey] = useState(props.apiKey);
  const [prefs, setPrefs] = useState<Prefs>(props.prefs);
  const [reveal, setReveal] = useState(false);
  const browserMode = props.mode === 'browser';
  const suspect = key.trim().length > 0 && !looksLikeKey(key);

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        {browserMode ? (
          <div className="notice info">
            <b>This page has no server.</b> It calls the Anthropic API directly from your browser
            using a key you provide below. The key is stored only in this browser, is sent only to
            api.anthropic.com, and is not part of the site anyone else downloads.
          </div>
        ) : (
          <div className="notice info">
            <b>A generation server is answering.</b> It holds the API key; this page never sees one,
            so there is nothing to enter here.
          </div>
        )}

        {browserMode && (
          <div className="stack" style={{ marginTop: 12 }}>
            <div>
              <label>Anthropic API key</label>
              <div className="row">
                <input
                  type={reveal ? 'text' : 'password'}
                  placeholder="sk-ant-..."
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
                <button className="tiny" onClick={() => setReveal(!reveal)}>
                  {reveal ? 'hide' : 'show'}
                </button>
              </div>
              {suspect && (
                <p className="hint" style={{ color: 'var(--warn)' }}>
                  That does not look like an Anthropic key (they start with <code>sk-ant-</code>).
                </p>
              )}
              <p className="hint">
                Get one at console.anthropic.com. Use a key with a spend limit set - it is the only
                thing standing between a typo in a 50×50 grid and a surprising bill.
              </p>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 12 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={prefs.remember}
                onChange={(e) => setPrefs({ ...prefs, remember: e.target.checked })}
              />
              Remember the key in this browser (otherwise it is forgotten when the tab closes)
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 12 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={prefs.offline}
                onChange={(e) => setPrefs({ ...prefs, offline: e.target.checked })}
              />
              Use the offline procedural generator instead of the API (no key needed, much worse maps)
            </label>

            <div className="row">
              <div className="grow">
                <label>Model</label>
                <select value={prefs.model} onChange={(e) => setPrefs({ ...prefs, model: e.target.value })}>
                  {MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ width: 120 }}>
                <label>Effort</label>
                <select
                  value={prefs.effort}
                  onChange={(e) => setPrefs({ ...prefs, effort: e.target.value as Effort })}
                >
                  {EFFORTS.map((e) => (
                    <option key={e} value={e}>
                      {e}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p className="hint" style={{ marginTop: 0 }}>
              Lower effort is cheaper and faster; coastlines, ranges and climate belts get less
              coherent. A 50×50 layer at high effort is a few minutes of thinking.
            </p>
          </div>
        )}

        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          {browserMode && key.trim().length > 0 && (
            <button
              className="danger"
              onClick={() => {
                setKey('');
                props.onSave('', prefs);
              }}
            >
              forget key
            </button>
          )}
          <span className="grow" />
          <button onClick={props.onClose}>cancel</button>
          <button className="primary" onClick={() => props.onSave(key, prefs)}>
            save
          </button>
        </div>
      </div>
    </div>
  );
}
