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
