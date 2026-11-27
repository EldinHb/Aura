/**
 * The sessions open in this window, for mods (`ctx.sessions`): each session's main-area tab,
 * in tab order, and the selected session. Read-only; mods do not see the tabs themselves.
 */
import { useStore } from "../state/store";

type State = ReturnType<typeof useStore.getState>;

export function openSessionIds(st: Pick<State, "tabs" | "selectedId"> = useStore.getState()): string[] {
  const ids = st.tabs.flatMap((t) => (t.kind === "session" ? [t.sessionId] : []));
  if (st.selectedId && !ids.includes(st.selectedId)) ids.push(st.selectedId);
  return ids;
}

/** Call `fn` with the open sessions whenever that list changes; returns the unsubscribe. */
export function onOpenSessionsChange(fn: (ids: string[]) => void): () => void {
  let last = openSessionIds().join("\n");
  return useStore.subscribe((st) => {
    const ids = openSessionIds(st);
    const key = ids.join("\n");
    if (key === last) return;
    last = key;
    fn(ids);
  });
}
