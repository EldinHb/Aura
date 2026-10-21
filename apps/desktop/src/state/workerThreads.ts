import { create } from "zustand";
import { useStore } from "./store";

/** What an orchestrator shows: its chat or its Workers tab, and the worker whose thread that tab shows. */
export type ThreadView = { tab: "chat" | "workers"; worker?: string };

const KEY = "aura.worker-threads.v1";

function loadViews(): Record<string, ThreadView> {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return Object.fromEntries(Object.entries(saved).filter(([, value]) => value && typeof value === "object" && "tab" in value && (value.tab === "chat" || value.tab === "workers")
      && (!("worker" in value) || typeof value.worker === "string"))) as Record<string, ThreadView>;
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

/** Back to the orchestrator's chat. The thread open last opens again with the Workers tab. */
export function closeWorkerThreads(orchestratorId: string) {
  setView(orchestratorId, { tab: "chat" });
}
