import { create } from "zustand";
import { useStore } from "./store";

/**
 * What an orchestrator shows: its chat, its Workers tab (and the worker whose
 * thread that tab shows), or, for a feature owner, its Team tab (and the
 * meeting it was opened on).
 */
export type ThreadView = { tab: "chat" | "workers" | "team"; worker?: string; meeting?: string };

const TABS = ["chat", "workers", "team"];

const KEY = "aura.worker-threads.v1";

function loadViews(): Record<string, ThreadView> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return Object.fromEntries(Object.entries(saved).filter(([, value]) => value && typeof value === "object" && "tab" in value && TABS.includes(value.tab as string)
      && (!("worker" in value) || typeof value.worker === "string") && (!("meeting" in value) || typeof value.meeting === "string"))) as Record<string, ThreadView>;
  } catch { return {}; }
}

/** Orchestrator id → its view. Saved across restarts; orchestrators not in it show their chat. */
export const useWorkerThreads = create<{ views: Record<string, ThreadView> }>(() => ({ views: loadViews() }));

/** Read the saved views again, as a reload does. */
export function reloadWorkerThreads() {
  useWorkerThreads.setState({ views: loadViews() });
}

function setView(orchestratorId: string, patch: Partial<ThreadView>) {
  useWorkerThreads.setState((s) => ({ views: { ...s.views, [orchestratorId]: { ...(s.views[orchestratorId] ?? { tab: "chat" }), ...patch } } }));
  try { localStorage.setItem(KEY, JSON.stringify(useWorkerThreads.getState().views)); } catch { /* Keep the view usable when storage is unavailable. */ }
}

/** Show an orchestrator's Workers tab, on `workerId`'s thread when given (else the one open last), selecting the orchestrator. */
export function openWorkerThread(orchestratorId: string, workerId?: string) {
  const st = useStore.getState();
  if (st.selectedId !== orchestratorId) st.select(orchestratorId);
  setView(orchestratorId, workerId ? { tab: "workers", worker: workerId } : { tab: "workers" });
}

/** Show a feature owner's Team tab, on `meetingId` when given, selecting the owner. Never opened by Aura itself, only by the user. */
export function openTeam(ownerId: string, meetingId?: string) {
  const st = useStore.getState();
  if (st.selectedId !== ownerId) st.select(ownerId);
  setView(ownerId, { tab: "team", meeting: meetingId });
}

/** Back to the orchestrator's chat. The thread open last opens again with the Workers tab. */
export function closeWorkerThreads(orchestratorId: string) {
  setView(orchestratorId, { tab: "chat" });
}
