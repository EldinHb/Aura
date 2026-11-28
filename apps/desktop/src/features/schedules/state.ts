/**
 * Scheduled tasks live in the daemon, which starts their sessions whether or
 * not the app is open. The app mirrors the list and keeps it current through
 * `schedules.changed`, which the daemon sends on every change, from the app,
 * an orchestrator's tools or a run.
 */
import { useEffect } from "react";
import { create } from "zustand";
import type { ClearHistory, HistoryCounts, Schedule, ScheduledRun, ScheduledTask, ScheduledTaskInput } from "../../gen";
import { registerCommands } from "../../lib/commands";
import { setFocus } from "../../commands/core";
import { useStore, selectLocalClient } from "../../state/store";
import { rpc } from "../../lib/call";

type ScheduleState = {
  tasks: ScheduledTask[]; loaded: boolean; error: string | null;
  /** Bumped on every `schedules.changed`, so an open history reloads. */
  version: number;
  refresh: () => Promise<void>;
};

export const useSchedules = create<ScheduleState>((set) => ({
  tasks: [], loaded: false, error: null, version: 0,
  refresh: async () => {
    // Whatever comes back, the sidebar must not take the app down with it.
    try { const tasks = await rpc<ScheduledTask[] | null>("schedules.list"); set({ tasks: Array.isArray(tasks) ? tasks : [], loaded: true, error: null }); }
    catch (e) { set({ error: e instanceof Error ? e.message : String(e), loaded: true }); }
  },
}));

export const schedules = {
  create: (input: ScheduledTaskInput) => rpc<ScheduledTask>("schedules.create", input),
  update: (id: string, input: ScheduledTaskInput) => rpc<ScheduledTask>("schedules.update", { id, ...input }),
  remove: (id: string) => rpc<ScheduledTask>("schedules.delete", { id }),
  setEnabled: (id: string, enabled: boolean) => rpc<ScheduledTask>("schedules.set_enabled", { id, enabled }),
  run: (id: string) => rpc<ScheduledRun>("schedules.run", { id }),
  runs: (id: string, limit = 50) => rpc<ScheduledRun[]>("schedules.runs", { id, limit }),
  /** Entries of each result in the whole history, which Clear history removes from. */
  historyCounts: (id: string) => rpc<HistoryCounts>("schedules.history_counts", { id }),
  clearHistory: (id: string, only: ClearHistory) => rpc<{ removed: number; task: ScheduledTask }>("schedules.clear_history", { id, only }),
  preview: (schedule: Schedule, count = 3) => rpc<string[]>("schedules.preview", { schedule, count }),
};

/** Keep the task list current. Mount once per window. */
export function useScheduleSync() {
  const client = useStore(selectLocalClient);
  useEffect(() => {
    if (!client) return;
    const refresh = () => void useSchedules.getState().refresh();
    refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = client.onNotification((method) => {
      if (method !== "schedules.changed") return;
      useSchedules.setState((s) => ({ version: s.version + 1 }));
      if (timer) return;
      timer = setTimeout(() => { timer = undefined; refresh(); }, 100);
    });
    const offState = client.onState((s) => { if (s === "open") refresh(); });
    return () => { off(); offState(); clearTimeout(timer); };
  }, [client]);
}

export function openSchedules(taskId?: string, create = false) {
  useStore.getState().openDialog({ kind: "schedules", taskId, create });
}

/** Open the session a run started, like picking it in the sidebar. */
export function openRunSession(sessionId: string) {
  const app = useStore.getState();
  if (!app.sessions[sessionId]) { app.toast("That session was deleted", "warn"); return; }
  app.closeDialog();
  app.select(sessionId);
  setFocus("main");
}

export function registerScheduleCommands() {
  return registerCommands([
    { id: "schedules.open", title: "Scheduled tasks…", group: "Scheduled tasks", keywords: ["cron", "recurring", "timer", "schedule", "automation"], run: () => openSchedules() },
    { id: "schedules.new", title: "New scheduled task…", group: "Scheduled tasks", keywords: ["cron", "recurring", "timer", "schedule"], run: () => openSchedules(undefined, true) },
  ]);
}
