/**
 * What the user has yet to see. The daemon keeps it on the session
 * (`Session.attention`): set when the agent stops, cleared here when the user
 * opens the session. The inbox counts what waits on the user.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { Attention, Session } from "../gen";
import { unreadChanges, usePullChanges } from "../features/reviews/changes";
import { selectPendingCount, useStore, type AppState } from "./store";

/** The sidebar marker of each kind. */
export const ATTENTION: Record<Attention, { className: string; label: string }> = {
  done: { className: "done", label: "Finished since you last looked" },
  failed: { className: "failed", label: "Failed since you last looked" },
  waiting: { className: "waiting", label: "Waiting on you since you last looked" },
};

const subscribeFocus = (onChange: () => void) => {
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
};

/** Whether the user is looking at this window. */
export function useWindowFocused(): boolean {
  return useSyncExternalStore(subscribeFocus, () => document.visibilityState === "visible" && document.hasFocus());
}

/** Whether something of Aura's own covers the session: a dialog (the inbox among them) or the command palette. */
export const selectCovered = (s: AppState) => s.dialog.kind !== "none" || s.paletteOpen;

/** The session the user is looking at: selected, shown, nothing over it, in a focused window. */
export function useViewedSessionId(): string | null {
  const focused = useWindowFocused();
  const selected = useStore((s) => (s.prSelection || s.reviewHistoryOpen || selectCovered(s) ? null : s.selectedId));
  return focused ? selected : null;
}

/** Clear the attention of the session the user is looking at, also when it stops while they do. */
export function useMarkViewedSeen() {
  const viewed = useViewedSessionId();
  const attention = useStore((s) => (viewed ? s.sessions[viewed]?.attention : null));
  useEffect(() => {
    if (!viewed || !attention) return;
    const st = useStore.getState();
    const session = st.sessions[viewed];
    // Cleared right away so the marker does not linger for the round trip.
    if (session) st.upsertSession({ ...session, attention: null });
    st.client?.markSeen(viewed).catch((error: unknown) => console.warn(`Could not mark session ${viewed} seen:`, error));
  }, [viewed, attention]);
}

/** The most urgent attention among the workers hidden under a collapsed orchestrator. */
export function hiddenAttention(hidden: Session[]): Attention | null {
  for (const kind of ["waiting", "failed", "done"] as const) if (hidden.some((w) => w.attention === kind)) return kind;
  return null;
}

/** How many rows the inbox lists: approvals and questions waiting in any session, and unread changes on followed pull requests. */
export function inboxCount(st: AppState, changes = usePullChanges.getState().changes): number {
  return selectPendingCount(st) + unreadChanges(changes, st.settings.pullChangesMuted).length;
}

export function useInboxCount(): number {
  const changes = usePullChanges((s) => s.changes);
  return useStore((st) => inboxCount(st, changes));
}
