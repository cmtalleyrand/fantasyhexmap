import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';

type BaseProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'defaultValue'>;

/**
 * A text or number field that commits once, on blur or Enter, rather than on
 * every keystroke. Every commit is an undo entry and a journal entry, so typing
 * a twelve-letter name must be one change, not twelve. Escape reverts the draft.
 *
 * `allowEmpty` lets an empty value through (an optional field such as a short
 * name); otherwise an empty draft is treated as a slip and reverted.
 */
export default function CommitInput({
  value,
  onCommit,
  allowEmpty = false,
  ...rest
}: BaseProps & {
  value: string | number;
  onCommit: (value: string) => void;
  allowEmpty?: boolean;
}) {
  const shown = String(value);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === shown.trim() || (!trimmed && !allowEmpty)) {
      setDraft(shown);
      return;
    }
    onCommit(trimmed);
  };

  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          const input = e.currentTarget;
          setDraft(shown);
          // Blur once the reset has rendered, so the blur commits nothing.
          requestAnimationFrame(() => input.blur());
        }
      }}
    />
  );
}

/**
 * A colour picker that commits when the picker is closed. React's `onChange`
 * on a colour input fires continuously while the user drags across the
 * palette; the native `change` event fires once, with the final colour.
 */
export function CommitColour({
  value,
  onCommit,
  ...rest
}: BaseProps & { value: string; onCommit: (value: string) => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const latest = useRef({ value, onCommit });
  latest.current = { value, onCommit };

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    const onNativeChange = () => {
      if (input.value !== latest.current.value) latest.current.onCommit(input.value);
    };
    input.addEventListener('change', onNativeChange);
    return () => input.removeEventListener('change', onNativeChange);
  }, []);

  return (
    <input
      {...rest}
      ref={ref}
      type="color"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}

/** Normalises "#abc", "abc", "A1B2C3" and "#a1b2c3" to "#a1b2c3"; null if it is none of those. */
export function parseHexColour(text: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!m) return null;
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  return `#${hex.toLowerCase()}`;
}

/**
 * A text field for a colour's hex code: easy to select and copy, and accepts a
 * pasted code. Commits on blur or Enter; anything that is not a colour reverts.
 */
export function CommitHex({
  value,
  onCommit,
  ...rest
}: BaseProps & { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const parsed = parseHexColour(draft);
    setDraft(parsed ?? value);
    if (parsed && parsed !== value.toLowerCase()) onCommit(parsed);
  };
  return (
    <input
      {...rest}
      value={draft}
      spellCheck={false}
      maxLength={7}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') {
          const input = e.currentTarget;
          setDraft(value);
          requestAnimationFrame(() => input.blur());
        }
      }}
    />
  );
}

/** Copy text to the clipboard; resolves false if the browser refuses. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
