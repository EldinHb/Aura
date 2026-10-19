import { useEffect, useState } from "react";

/**
 * Give the keyboard back, when a dialog closes, to what had it when the dialog opened. Read while rendering, before
 * any child takes focus (a native `autoFocus` does so before effects run). Skipped when the element is gone, or when
 * the keyboard is already somewhere other than the page itself: whoever closed the dialog moved it on purpose.
 */
export function useRestoreFocus() {
  const [prev] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(
    () => () => {
      const now = document.activeElement;
      if (now && now !== document.body) return;
      if (prev && prev !== document.body && prev.isConnected) prev.focus?.();
    },
    [prev],
  );
}
