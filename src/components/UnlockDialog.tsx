import { useState } from 'react';

/**
 * Shown when a passphrase-protected key is stored. The key is decrypted into
 * memory for this page load only; nothing plaintext is ever written back.
 */
export default function UnlockDialog({
  onUnlock,
  onForget,
  onDismiss,
}: {
  onUnlock: (passphrase: string) => Promise<void>;
  onForget: () => void;
  onDismiss: () => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = () => {
    setBusy(true);
    setError(null);
    onUnlock(passphrase)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 'min(420px, 100%)' }}>
        <h2>Unlock your API key</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          This browser holds an encrypted Anthropic key. Enter the passphrase to use it for this
          session.
        </p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          placeholder="Passphrase"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && passphrase) submit();
          }}
        />
        {error && (
          <div className="notice error" style={{ marginTop: 8 }}>
            {error}
          </div>
        )}
        <div className="row" style={{ marginTop: 14 }}>
          <button className="danger" onClick={onForget}>
            forget it
          </button>
          <span className="grow" />
          <button onClick={onDismiss}>later</button>
          <button className="primary" disabled={busy || !passphrase} onClick={submit}>
            {busy ? 'unlocking…' : 'unlock'}
          </button>
        </div>
      </div>
    </div>
  );
}
