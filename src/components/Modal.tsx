import { useEffect, useRef, type ReactNode } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A dialog over the app: backdrop, Escape to close, keyboard focus held inside
 * while it is open and handed back to whatever had it when it closes.
 *
 * `onClose` is what Escape and a click on the backdrop do. Leave it out for a
 * dialog that must be answered with one of its own buttons.
 */
export default function Modal({
  label,
  onClose,
  className = '',
  children,
}: {
  /** What a screen reader announces the dialog as. */
  label: string;
  onClose?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    // Focus what the dialog asks for, else its first field or button, else the dialog itself.
    const first =
      dialog?.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ??
      dialog?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]), select, textarea') ??
      dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialog)?.focus();
    return () => previous?.focus?.();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // Keep Escape from also reaching the map, where it would clear the selection.
      e.stopPropagation();
      if (close.current) {
        e.preventDefault();
        close.current();
      }
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) return;
    const firstItem = items[0]!;
    const lastItem = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === firstItem) {
      e.preventDefault();
      lastItem.focus();
    } else if (!e.shiftKey && document.activeElement === lastItem) {
      e.preventDefault();
      firstItem.focus();
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => close.current?.()} onKeyDown={onKeyDown}>
      <div
        ref={ref}
        className={`modal ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
