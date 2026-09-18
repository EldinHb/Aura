import { useStore, selectSelected, selectPendingCount } from "../state/store";
import type { CommandContext } from "../lib/commands";
import { isMac } from "../lib/platform";

export function isEditable(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return (el as HTMLElement).isContentEditable;
}

export function isTerminalEl(el: Element | null): boolean {
  return !!el?.closest(".terminal-wrap");
}

/**
 * Widgets that handle their own plain keys mark themselves `data-keynav`, so the
 * global keymap stands aside while one has focus. Without this a focusable card
 * is invisible to the router: it is neither an input nor a dialog, so bindings
 * like `j` / `k` / `enter` match and get swallowed in the capture phase.
 */
export function isKeyNavEl(el: Element | null): boolean {
  return !!el?.closest("[data-keynav]");
}

/**
 * A focused button or link activates on Enter / Space natively. `nav.activate`
 * and `nav.toggle` are bound to those keys for the list cursor, so without this
 * the global keymap would swallow them and the control would never fire.
 */
export function isActivatableEl(el: Element | null): boolean {
  if (!el) return false;
  return el.tagName === "BUTTON" || (el.tagName === "A" && el.hasAttribute("href"));
}

/** Snapshot of the context used by `when` clauses. Not a hook; safe anywhere. */
export function currentCommandContext(): CommandContext {
  const st = useStore.getState();
  const s = selectSelected(st);
  const active = document.activeElement;
  const t = s ? st.transcripts[s.id] : null;
  const pending = s ? Object.keys(t?.approvals ?? {}).length + Object.keys(t?.inputs ?? {}).length : 0;
  return {
    focus: st.focus,
    inputFocused: isEditable(active) && !isTerminalEl(active),
    terminalFocused: isTerminalEl(active),
    dialogOpen: st.dialog.kind !== "none",
    widgetFocused: isKeyNavEl(active),
    paletteOpen: st.paletteOpen,
    hasSelection: !!s,
    mode: s?.mode ?? null,
    provider: s?.provider ?? null,
    status: s?.status ?? null,
    pending: pending || selectPendingCount(st) > 0 ? Math.max(pending, s ? 0 : selectPendingCount(st)) : 0,
    running: s?.status === "running",
    isMac,
  };
}
