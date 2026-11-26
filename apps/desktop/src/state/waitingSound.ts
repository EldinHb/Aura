/**
 * Plays the waiting sound when a session goes from working to waiting for
 * the user (its work finished, failed, or it asks something). The main window
 * owns it, so detached session windows do not play it a second time.
 */
import { useEffect } from "react";
import { categoryOf, useStore, type AppState, type SessionCategory } from "./store";
import { playSound } from "../lib/sound";

/** At most one sound this often, however many sessions finish together. */
const GAP_MS = 1500;

/** The sessions that went from working to waiting between two snapshots. */
export function newlyWaiting(before: Map<string, SessionCategory>, sessions: AppState["sessions"]): string[] {
  const out: string[] = [];
  for (const s of Object.values(sessions)) {
    if (before.get(s.id) === "working" && categoryOf(s) === "waiting") out.push(s.id);
  }
  return out;
}

export function snapshot(sessions: AppState["sessions"]): Map<string, SessionCategory> {
  return new Map(Object.values(sessions).map((s) => [s.id, categoryOf(s)]));
}

export function useWaitingSound(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    let before = snapshot(useStore.getState().sessions);
    let last = 0;
    return useStore.subscribe((st, prev) => {
      if (st.sessions === prev.sessions) return;
      const now = newlyWaiting(before, st.sessions);
      before = snapshot(st.sessions);
      if (now.length === 0) return;
      const { waitingSound, waitingSoundVolume, waitingSoundFile, waitingSoundWhenViewing } = st.settings;
      // The session on screen in a window in front tells the user by itself.
      const viewing = document.hasFocus() && !st.modView && st.selectedId !== null && now.every((id) => id === st.selectedId);
      if (viewing && !waitingSoundWhenViewing) return;
      const t = Date.now();
      if (t - last < GAP_MS) return;
      last = t;
      playSound(waitingSound, waitingSoundVolume, waitingSoundFile);
    });
  }, [enabled]);
}
