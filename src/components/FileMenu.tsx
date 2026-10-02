import { useEffect, useRef, useState } from 'react';

export interface FileMenuProps {
  onNewMap: () => void;
  onSaves: () => void;
  onImport: (file: File) => void;
  onExportJson: (withHistory: boolean) => void;
  onExportParseJson: () => void;
  onExportImage: () => void;
  onExportDecisions: () => void;
}

/**
 * Everything that moves a map in or out of the app, in one place: new, saved
 * copies in this browser, import, and every export.
 */
export default function FileMenu(props: FileMenuProps) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointer);
    // Put the keyboard on the first item, so the menu can be worked without a mouse.
    wrap.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    return () => window.removeEventListener('pointerdown', onPointer);
  }, [open]);

  const pick = (run: () => void) => () => {
    setOpen(false);
    run();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    const items = [...(wrap.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      button.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(index + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(index - 1 + items.length) % items.length]?.focus();
    }
  };

  return (
    <div className="menu-wrap" ref={wrap} onKeyDown={onKeyDown}>
      <button
        ref={button}
        className="tiny"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        File ▾
      </button>
      <input
        ref={fileInput}
        type="file"
        accept="application/json,.json"
        className="visually-hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) props.onImport(file);
          e.target.value = '';
        }}
      />
      {open && (
        <div className="menu" role="menu" aria-label="File">
          <button role="menuitem" onClick={pick(props.onNewMap)}>
            New map…
          </button>
          <button role="menuitem" onClick={pick(props.onSaves)}>
            Saved maps…
          </button>
          <button role="menuitem" onClick={pick(() => fileInput.current?.click())}>
            Import map JSON…
          </button>
          <hr />
          <button role="menuitem" onClick={pick(props.onExportImage)}>
            Export image (PNG or SVG)…
          </button>
          <button role="menuitem" onClick={pick(() => props.onExportJson(false))}>
            Export map JSON
          </button>
          <button role="menuitem" onClick={pick(() => props.onExportJson(true))}>
            Export map JSON with undo history
          </button>
          <button role="menuitem" onClick={pick(props.onExportParseJson)}>
            Export map JSON for parsing (no history or decisions)
          </button>
          <button role="menuitem" onClick={pick(props.onExportDecisions)}>
            Export decision record (Markdown)
          </button>
        </div>
      )}
    </div>
  );
}
