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
import type { HexDimensions } from '../../shared/types.js';
import HexSizeInput from './HexSizeInput.js';

export type SettingsTab = 'map' | 'display' | 'generation' | 'key';

const MODELS = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 (best maps)' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (cheaper, faster)' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (cheapest, roughest)' },
];

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const ELEVATION_STYLES: { id: Prefs['elevationStyle']; label: string; hint: string }[] = [
  { id: 'colour', label: 'Colour', hint: 'Hexes are tinted from low to high ground' },
  { id: 'contours', label: 'Terrain marks', hint: 'Hills and mountains are drawn as symbols' },
];

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
  /** The open map's hex size; null on the create screen, where no map exists yet. */
  hexDimensions: HexDimensions | null;
  onSaveHexDimensions: (next: HexDimensions) => void;
  /** Whether the open map lets cities and polities occupy water; null on the create screen. */
  allowUnderwater: boolean | null;
  onSaveAllowUnderwater: (allow: boolean) => void;
  initialTab?: SettingsTab;
}

export default function SettingsDialog(props: SettingsDialogProps) {
  const [key, setKey] = useState(props.apiKey);
  const [prefs, setPrefs] = useState<Prefs>(props.prefs);
  const [hex, setHex] = useState<HexDimensions | null>(props.hexDimensions);
  const [underwater, setUnderwater] = useState<boolean | null>(props.allowUnderwater);
  const [reveal, setReveal] = useState(false);
  const [protect, setProtect] = useState(props.locked);
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const browserMode = props.mode === 'browser';
  const suspect = key.trim().length > 0 && !looksLikeKey(key);
  const canEncrypt = cryptoAvailable();

  const tabs: { id: SettingsTab; label: string }[] = [
    ...(hex ? [{ id: 'map' as const, label: 'Map' }] : []),
    { id: 'display', label: 'Display' },
    ...(browserMode
      ? [
          { id: 'generation' as const, label: 'Generation' },
          { id: 'key' as const, label: 'API key' },
        ]
      : []),
  ];
  const [tab, setTab] = useState<SettingsTab>(
    tabs.some((t) => t.id === props.initialTab) ? props.initialTab! : tabs[0]!.id,
  );

  // Re-encryption is only needed when the key itself changed, or protection was
  // just switched on. An already-protected, unchanged key must not force the
  // passphrase to be retyped to save an unrelated setting.
  const keyChanged = key.trim() !== props.apiKey.trim();
  const needsEncrypt = protect && key.trim().length > 0 && (keyChanged || !props.locked);
  const passMismatch = needsEncrypt && passphrase.length > 0 && passphrase !== confirm;
  const passTooShort = needsEncrypt && passphrase.length > 0 && passphrase.length < 8;
  const blocked =
    browserMode && needsEncrypt && (passphrase.length === 0 || passMismatch || passTooShort);

  const save = () => {
    if (hex && hex !== props.hexDimensions) props.onSaveHexDimensions(hex);
    if (underwater !== null && underwater !== props.allowUnderwater) {
      props.onSaveAllowUnderwater(underwater);
    }
    props.onSave(key, prefs, needsEncrypt ? passphrase : protect ? null : '');
  };

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div
        className="modal settings"
        role="dialog"
        aria-label="Settings"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" aria-label="Close settings" onClick={props.onClose}>
            ×
          </button>
        </header>

        <div className="tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'tab active' : 'tab'}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="modal-body">
          {!browserMode && (
            <div className="notice info" style={{ marginBottom: 14 }}>
              <b>A generation server is answering.</b> It holds the API key and model settings;
              this page never sees a key, so there is nothing to enter for generation.
            </div>
          )}

          {tab === 'map' && hex && (
            <div className="stack">
              <h3>Hex size</h3>
              <HexSizeInput value={hex} onChange={setHex} />
              {underwater !== null && (
                <>
                  <h3>Water</h3>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={underwater}
                      onChange={(e) => setUnderwater(e.target.checked)}
                    />
                    Allow underwater cities and polities
                  </label>
                  <p className="hint">
                    Off by default: cities stand on land and polities partition only land, so
                    anything on a Sea or Lake hex is removed when the geography changes. Turning
                    this off removes any underwater cities and claims the map already has (each
                    layer can undo it).
                  </p>
                </>
              )}
            </div>
          )}

          {tab === 'display' && (
            <div className="stack">
              <h3>Elevation</h3>
              <div className="segmented" role="radiogroup" aria-label="Elevation representation">
                {ELEVATION_STYLES.map((o) => (
                  <button
                    key={o.id}
                    type="button"
                    role="radio"
                    aria-checked={prefs.elevationStyle === o.id}
                    className={prefs.elevationStyle === o.id ? 'seg active' : 'seg'}
                    onClick={() => setPrefs({ ...prefs, elevationStyle: o.id })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <p className="hint">
                {ELEVATION_STYLES.find((o) => o.id === prefs.elevationStyle)?.hint}.
              </p>
              <h3>Labels</h3>
              <label className="check">
                <input
                  type="checkbox"
                  checked={prefs.labels}
                  onChange={(e) => setPrefs({ ...prefs, labels: e.target.checked })}
                />
                Show names on the map
              </label>
            </div>
          )}

          {tab === 'generation' && browserMode && (
            <div className="stack">
              <label className="check">
                <input
                  type="checkbox"
                  checked={prefs.offline}
                  onChange={(e) => setPrefs({ ...prefs, offline: e.target.checked })}
                />
                Use the offline procedural generator instead of the API (no key needed, much worse
                maps)
              </label>

              <div className="row">
                <div className="grow">
                  <label>Model</label>
                  <select
                    value={prefs.model}
                    onChange={(e) => setPrefs({ ...prefs, model: e.target.value })}
                  >
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
              <div className="row">
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
              <p className="hint">
                Lower effort is cheaper and faster; coastlines, ranges and climate belts get less
                coherent. A 50×50 layer at high effort is a few minutes of thinking.
              </p>
              <p className="hint">
                The model reasons and writes out of one budget, and on a hard layer almost all of it
                goes on reasoning — a big polity map can spend tens of thousands of tokens deciding
                before it writes a single row. The budget is what it paces itself against: raise it
                if a layer keeps running out of room, lower it to spend less. Between{' '}
                {MIN_TASK_BUDGET.toLocaleString()} and {MAX_TASK_BUDGET.toLocaleString()}.
              </p>
            </div>
          )}

          {tab === 'key' && browserMode && (
            <div className="stack">
              <div className="notice info">
                <b>This page has no server.</b> It calls the Anthropic API directly from your
                browser using a key you provide below. The key is stored only in this browser, is
                sent only to api.anthropic.com, and is not part of the site anyone else downloads.
              </div>

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
                  Get one at console.anthropic.com. Use a key with a spend limit set - it is the
                  only thing standing between a typo in a 50×50 grid and a surprising bill.
                </p>
              </div>

              {insecureOrigin() && (
                <div className="notice error">
                  This page is not on a secure origin. Do not enter a real key: it cannot be
                  protected in transit or at rest here.
                </div>
              )}

              <label className="check">
                <input
                  type="checkbox"
                  checked={prefs.remember}
                  onChange={(e) => setPrefs({ ...prefs, remember: e.target.checked })}
                />
                Remember the key in this browser (otherwise it is forgotten when the tab closes)
              </label>

              {prefs.remember && canEncrypt && (
                <div className="stack" style={{ gap: 6 }}>
                  <label className="check">
                    <input
                      type="checkbox"
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
                      {passTooShort && (
                        <p className="hint" style={{ color: 'var(--warn)' }}>
                          Use at least 8 characters.
                        </p>
                      )}
                      {passMismatch && (
                        <p className="hint" style={{ color: 'var(--warn)' }}>
                          The two passphrases differ.
                        </p>
                      )}
                      <p className="hint" style={{ margin: 0 }}>
                        The key is stored as AES-GCM ciphertext and unlocked once per session. The
                        passphrase itself is never stored, so it cannot be recovered - if you
                        forget it, delete the key and paste a new one. This protects the key
                        against someone reading this browser's storage; it cannot protect it from
                        script running on this page while it is unlocked.
                      </p>
                    </>
                  )}
                </div>
              )}

              {(key.trim().length > 0 || props.locked) && (
                <div>
                  <button
                    className="danger"
                    onClick={() => {
                      setKey('');
                      props.onForget();
                    }}
                  >
                    forget key
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="modal-foot row">
          <span className="grow" />
          <button onClick={props.onClose}>cancel</button>
          <button className="primary" disabled={blocked} onClick={save}>
            save
          </button>
        </footer>
      </div>
    </div>
  );
}
