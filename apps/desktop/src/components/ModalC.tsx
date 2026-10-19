import { useEffect, useRef, type ReactNode } from "react";
import { useStore } from "../state/store";
import { useRestoreFocus } from "./restoreFocus";

/**
 * Minimal modal shell: overlay, focus trap, Escape closes via closeDialog.
 * Keyboard handling for the dialog body lives in the dialog itself via `onKeyDown`.
 */
export function ModalC({
  title,
  children,
  footer,
  width,
  height,
  onKeyDown,
  className,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  height?: string;
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeDialog = useStore((s) => s.closeDialog);

  useRestoreFocus();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const first = el.querySelector<HTMLElement>("[data-autofocus]") ?? el;
    first.focus();
  }, []);

  const trap = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      closeDialog();
      return;
    }
    if (e.key === "Tab" && ref.current) {
      const focusables = [...ref.current.querySelectorAll<HTMLElement>('button, input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute("disabled") && x.tabIndex >= 0);
      if (focusables.length === 0) return;
      const idx = focusables.indexOf(document.activeElement as HTMLElement);
      let next = idx + (e.shiftKey ? -1 : 1);
      if (next < 0) next = focusables.length - 1;
      if (next >= focusables.length) next = 0;
      focusables[next].focus();
      e.preventDefault();
      return;
    }
    onKeyDown?.(e);
  };

  return (
    <div className="overlay" role="presentation">
      <div
        className={`modal ${className ?? ""}`}
        role="dialog"
        aria-modal="true"
        ref={ref}
        tabIndex={-1}
        style={{ width: width ?? undefined, maxHeight: height ?? undefined, height: height ?? undefined }}
        onKeyDown={trap}
      >
        <div className="modal-head">{title}</div>
        <div className="modal-body" style={{ flex: 1, minHeight: 0 }}>
          {children}
        </div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
