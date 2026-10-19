import { useEffect, useState, type RefObject } from "react";

/** Marks a dialog-like container (modal, palette) whose opener is recorded, so a dialog opened from it can inherit it. */
const FOCUS_SCOPE = "data-focus-scope";

/**
 * Where the keyboard was when a dialog opened, and, when that was inside another dialog or the palette, the record of
 * that one. The element itself comes first; the inherited record is for when it is gone by the time this dialog closes
 * (the palette closes as it runs a command, a dialog that opens the next one closes). When the outer one stays open,
 * as a dialog does under a palette that is cancelled, its element is still there and the keyboard goes back into it.
 */
type Opener = { el: HTMLElement | null; outer?: Opener };
const openers = new WeakMap<Element, Opener>();

function opener(): Opener {
  const el = document.activeElement as HTMLElement | null;
  const scope = el?.closest(`[${FOCUS_SCOPE}]`);
  return { el, outer: scope ? openers.get(scope) : undefined };
}

/** The nearest recorded element still on the page. */
function target(record: Opener | undefined): HTMLElement | null {
  for (let r = record; r; r = r.outer) if (r.el && r.el !== document.body && r.el.isConnected) return r.el;
  return null;
}

/**
 * Give the keyboard back, when a dialog closes, to what had it when the dialog opened. Read while rendering, before
 * any child takes focus (a native `autoFocus` does so before effects run). Left alone when the keyboard is already
 * somewhere other than the page itself: whoever closed the dialog moved it on purpose. `scope` is the dialog's
 * container, marked `data-focus-scope`.
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
      target(prev)?.focus?.();
    },
    [prev],
  );
}
