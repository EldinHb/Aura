import { useCallback, useEffect, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useStore } from "../state/store";
import clsx from "clsx";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type ModalProps = {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  /** Called on Escape / backdrop click. Defaults to closeDialog. */
  onClose?: () => void;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLDivElement>) => void;
  className?: string;
};

/** Shared modal shell: backdrop, focus trap, Escape to close, autofocus. */
export function Modal({ title, children, footer, width, onClose, onKeyDown, className }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeDialog = useStore((s) => s.closeDialog);
  const close = onClose ?? closeDialog;

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const first = root.querySelector<HTMLElement>("[data-autofocus]") ?? root.querySelector<HTMLElement>("input, textarea, select") ?? root.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
  }, []);

  const handleKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Tab" && ref.current) {
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) return;
      const idx = items.indexOf(document.activeElement as HTMLElement);
      let next = e.shiftKey ? idx - 1 : idx + 1;
      if (idx === -1) next = 0;
      if (next < 0) next = items.length - 1;
      if (next >= items.length) next = 0;
      e.preventDefault();
      items[next].focus();
      return;
    }
    onKeyDown?.(e);
  };

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()} role="presentation">
      <div ref={ref} className={clsx("modal", className)} style={width ? { width: `min(${width}px, 92vw)` } : undefined} role="dialog" aria-modal="true" onKeyDown={handleKey}>
        <div className="modal-head">{title}</div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

function isEditableTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

/**
 * Keyboard list navigation. Up/Down, Ctrl+J/K, Ctrl+N/P, Home/End, PageUp/PageDown,
 * Enter activates; digits 1-9 jump (Alt+digit while typing in an input).
 */
/** 0-based index for a 1–9 key. Uses `code` so Option+digit works on macOS (where `key` is e.g. "£"). */
function digitIndex(e: ReactKeyboardEvent | KeyboardEvent): number | null {
  const m = /^Digit([1-9])$/.exec(e.code ?? "") ?? /^([1-9])$/.exec(e.key);
  return m ? Number(m[1]) - 1 : null;
}

export function useListNav(count: number, onActivate: (index: number) => void, pageSize = 10) {
  const [index, setIndexRaw] = useState(0);
  const clamp = useCallback((i: number) => (count === 0 ? 0 : Math.max(0, Math.min(count - 1, i))), [count]);
  useEffect(() => {
    setIndexRaw((i) => clamp(i));
  }, [count, clamp]);
  const setIndex = useCallback((i: number) => setIndexRaw(clamp(i)), [clamp]);
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent | KeyboardEvent) => {
      const k = e.key;
      const ctrl = e.ctrlKey;
      let handled = true;
      if (k === "ArrowDown" || (ctrl && (k === "j" || k === "n"))) setIndexRaw((i) => clamp(i + 1));
      else if (k === "ArrowUp" || (ctrl && (k === "k" || k === "p"))) setIndexRaw((i) => clamp(i - 1));
      else if (k === "Home" || (ctrl && k === "Home")) setIndexRaw(0);
      else if (k === "End") setIndexRaw(clamp(count - 1));
      else if (k === "PageDown") setIndexRaw((i) => clamp(i + pageSize));
      else if (k === "PageUp") setIndexRaw((i) => clamp(i - pageSize));
      else if (k === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        if (count > 0) onActivate(index);
      } else if (digitIndex(e) !== null && (e.altKey || !isEditableTarget(e.target))) {
        const i = digitIndex(e) as number;
        if (i < count) {
          setIndexRaw(i);
          onActivate(i);
        }
      } else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
      return handled;
    },
    [clamp, count, index, onActivate, pageSize],
  );
  return { index, setIndex, onKeyDown };
}

export type KeyListItem = { id: string; render: ReactNode; command?: string; header?: string };

/** Rows with `.list-item.active`; keeps the active row scrolled into view. */
export function KeyList({ items, index, onSelect, onActivate, empty }: { items: KeyListItem[]; index: number; onSelect: (i: number) => void; onActivate: (i: number) => void; empty?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>(".list-item.active")?.scrollIntoView({ block: "nearest" });
  }, [index]);
  if (items.length === 0) return <div className="list-empty">{empty ?? "Nothing here"}</div>;
  return (
    <div className="list" ref={ref} role="listbox">
      {items.map((it, i) => (
        <div key={it.id}>
          {it.header && <div className="section-title">{it.header}</div>}
          <button
            type="button"
            role="option"
            aria-selected={i === index}
            className={clsx("list-item", i === index && "active")}
            data-command={it.command ?? "list.activate"}
            data-hint
            tabIndex={-1}
            onMouseEnter={() => onSelect(i)}
            onClick={() => onActivate(i)}
          >
            {i < 9 && <kbd className="list-num">{i + 1}</kbd>}
            {it.render}
          </button>
        </div>
      ))}
    </div>
  );
}
