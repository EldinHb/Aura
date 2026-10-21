import { create } from "zustand";
import { useStore } from "./store";

/**
 * Orchestrator id → the worker whose thread its Workers tab shows ("" for
 * none picked yet). Orchestrators not in it show their chat.
 */
export const useWorkerThreads = create<{ open: Record<string, string> }>(() => ({ open: {} }));

/** Show an orchestrator's Workers tab, on `workerId`'s thread when given, selecting the orchestrator. */
export function openWorkerThread(orchestratorId: string, workerId?: string) {
  const st = useStore.getState();
  if (st.selectedId !== orchestratorId) st.select(orchestratorId);
  useWorkerThreads.setState((s) => ({ open: { ...s.open, [orchestratorId]: workerId ?? s.open[orchestratorId] ?? "" } }));
}

/** Back to the orchestrator's chat. */
export function closeWorkerThreads(orchestratorId: string) {
  useWorkerThreads.setState((s) => {
    const { [orchestratorId]: _closed, ...open } = s.open;
    return { open };
  });
}
