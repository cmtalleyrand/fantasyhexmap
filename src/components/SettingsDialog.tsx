import { useState } from 'react';
import {
  clampTaskBudget,
  MAX_TASK_BUDGET,
  MIN_TASK_BUDGET,
  type Effort,
} from '../../core/config.js';
import { insecureOrigin, looksLikeKey, type Prefs } from '../api/settings.js';
import { cryptoAvailable } from '../api/keyvault.js';
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
  /**
   * `passphrase` is a string to (re-)encrypt the key at rest, '' to store it
   * as-is, and null to leave whatever is already stored untouched - which is the
   * case when a protected key is unchanged and only other settings were edited.
   */
  onSave: (apiKey: string, prefs: Prefs, passphrase: string | null) => void;
  onForget: () => void;
  onClose: () => void;
  /** True when a passphrase-protected key is already stored. */
  locked: boolean;
}

export default function SettingsDialog(props: SettingsDialogProps) {
  const [key, setKey] = useState(props.apiKey);
  const [prefs, setPrefs] = useState<Prefs>(props.prefs);
  const [reveal, setReveal] = useState(false);
  const [protect, setProtect] = useState(props.locked);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const browserMode = props.mode === 'browser';
  const suspect = key.trim().length > 0 && !looksLikeKey(key);
  const canEncrypt = cryptoAvailable();
  // Re-encryption is only needed when the key itself changed, or protection was
  // just switched on. An already-protected, unchanged key must not force the
  // passphrase to be retyped to save an unrelated setting.
  const keyChanged = key.trim() !== props.apiKey.trim();
  const needsEncrypt = protect && key.trim().length > 0 && (keyChanged || !props.locked);
  const passMismatch = needsEncrypt && passphrase.length > 0 && passphrase !== confirm;
  const passTooShort = needsEncrypt && passphrase.length > 0 && passphrase.length < 8;
  const blocked =
    browserMode && needsEncrypt && (passphrase.length === 0 || passMismatch || passTooShort);

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

            {insecureOrigin() && (
              <div className="notice error">
                This page is not on a secure origin. Do not enter a real key: it cannot be protected
                in transit or at rest here.
              </div>
            )}

            <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 12 }}>
              <input
                type="checkbox"
                style={{ width: 'auto' }}
                checked={prefs.remember}
                onChange={(e) => setPrefs({ ...prefs, remember: e.target.checked })}
              />
              Remember the key in this browser (otherwise it is forgotten when the tab closes)
            </label>

            {prefs.remember && canEncrypt && (
              <div className="stack" style={{ gap: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 12 }}>
                  <input
                    type="checkbox"
                    style={{ width: 'auto' }}
                    checked={protect}
                    onChange={(e) => setProtect(e.target.checked)}
                  />
                  Protect the stored key with a passphrase
                </label>
                {protect && !needsEncrypt && (
                  <p className="hint" style={{ margin: 0 }}>
                    The stored key is already encrypted. Change the key above to set a new
                    passphrase.
                  </p>
                )}
                {protect && needsEncrypt && (
                  <>
                    <div className="row">
                      <input
                        type="password"
                        placeholder="Passphrase"
                        autoComplete="new-password"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                      />
                      <input
                        type="password"
                        placeholder="Confirm"
                        autoComplete="new-password"
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                      />
                    </div>
                    {passTooShort && <p className="hint" style={{ color: 'var(--warn)' }}>Use at least 8 characters.</p>}
                    {passMismatch && <p className="hint" style={{ color: 'var(--warn)' }}>The two passphrases differ.</p>}
                    <p className="hint" style={{ margin: 0 }}>
                      The key is stored as AES-GCM ciphertext and unlocked once per session. The
                      passphrase itself is never stored, so it cannot be recovered - if you forget
                      it, delete the key and paste a new one. This protects the key against someone
                      reading this browser's storage; it cannot protect it from script running on
                      this page while it is unlocked.
                    </p>
                  </>
                )}
              </div>
            )}

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
            <div className="row" style={{ marginTop: 8 }}>
              <div style={{ width: 160 }}>
                <label>Token budget</label>
                <input
                  type="number"
                  min={MIN_TASK_BUDGET}
                  max={MAX_TASK_BUDGET}
                  step={5000}
                  value={prefs.taskBudget}
                  onChange={(e) =>
                    setPrefs({ ...prefs, taskBudget: clampTaskBudget(Number(e.target.value)) })
                  }
                />
              </div>
            </div>
            <p className="hint" style={{ marginTop: 0 }}>
              Lower effort is cheaper and faster; coastlines, ranges and climate belts get less
              coherent. A 50×50 layer at high effort is a few minutes of thinking.
            </p>
            <p className="hint" style={{ marginTop: 4 }}>
              The model reasons and writes out of one budget, and on a hard layer almost all of it
              goes on reasoning — a big polity map can spend tens of thousands of tokens deciding
              before it writes a single row. The budget is what it paces itself against: raise it if
              a layer keeps running out of room, lower it to spend less. Between{' '}
              {MIN_TASK_BUDGET.toLocaleString()} and {MAX_TASK_BUDGET.toLocaleString()}.
            </p>
          </div>
        )}

        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          {browserMode && (key.trim().length > 0 || props.locked) && (
            <button
              className="danger"
              onClick={() => {
                setKey('');
                props.onForget();
              }}
            >
              forget key
            </button>
          )}
          <span className="grow" />
          <button onClick={props.onClose}>cancel</button>
          <button
            className="primary"
            disabled={blocked}
            onClick={() => props.onSave(key, prefs, needsEncrypt ? passphrase : protect ? null : '')}
          >
            save
          </button>
        </div>
      </div>
    </div>
  );
}
