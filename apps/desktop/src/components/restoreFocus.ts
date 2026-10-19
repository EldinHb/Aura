import { useEffect, useState, type RefObject } from "react";

/** Marks a dialog-like container (modal, palette) whose opener is recorded, so a dialog opened from it can inherit it. */
const FOCUS_SCOPE = "data-focus-scope";
const openers = new WeakMap<Element, HTMLElement | null>();

/**
 * What the keyboard should go back to when a dialog opened now closes: what has it now; or, when that is inside
 * another dialog or the palette, whatever that one would give it back to. That one is on its way out (the palette
 * closes as it runs a command, a dialog that opens the next one closes), so its own elements will be gone.
 */
function opener(): HTMLElement | null {
  const el = document.activeElement as HTMLElement | null;
  const scope = el?.closest(`[${FOCUS_SCOPE}]`);
  return scope && openers.has(scope) ? (openers.get(scope) ?? null) : el;
}

/**
 * Give the keyboard back, when a dialog closes, to what had it when the dialog opened. Read while rendering, before
 * any child takes focus (a native `autoFocus` does so before effects run). Skipped when the element is gone, or when
 * the keyboard is already somewhere other than the page itself: whoever closed the dialog moved it on purpose.
 * `scope` is the dialog's container, marked `data-focus-scope`.
 */
export function useRestoreFocus(scope: RefObject<HTMLElement | null>) {
  const [prev] = useState(opener);
  useEffect(() => {
    const el = scope.current;
    if (el) openers.set(el, prev);
  }, [scope, prev]);
  useEffect(
    () => () => {
      const now = document.activeElement;
      if (now && now !== document.body) return;
      if (prev && prev !== document.body && prev.isConnected) prev.focus?.();
    },
    [prev],
  );
}
