/**
 * Usage history lives in the daemon (see `usage.*` in docs/design/remote.md).
 * The app asks for what it shows, keeps each open session's turns so the
 * line under a reply has its cost, and tells the user when the daily summary
 * comes in (`usage_report`).
 */
import { useEffect } from "react";
import { create } from "zustand";
import type {
  DailyUsageSettings, SessionUsage, UsageGroupBy, UsageReport, UsageSummary, Event,
} from "../../gen";
import { registerCommands } from "../../lib/commands";
import { rpc, shownRpc } from "../../lib/call";
import { desktopNotify } from "../../lib/notify";
import { selectLocalClient, useStore } from "../../state/store";
import { fmtCost, fmtTokens, timeZone, totalTokens, tzOffsetMinutes } from "./format";

/**
 * History and summaries are read from the computer the window shows (a remote
 * allows `usage.summary/session/report/reports`); the daily summary is this
 * computer's setting, like the rest of Settings.
 */
export const usage = {
  summary: (q: { from?: Date; to?: Date; groupBy?: UsageGroupBy; splitBy?: UsageGroupBy; limit?: number }) =>
    shownRpc<UsageSummary>("usage.summary", {
      from: q.from?.toISOString(), to: q.to?.toISOString(), groupBy: q.groupBy ?? "day",
      ...(q.splitBy ? { splitBy: q.splitBy } : {}), ...(q.limit ? { limit: q.limit } : {}),
      tzOffsetMinutes: tzOffsetMinutes(q.from), timeZone: timeZone(),
    }),
  session: (id: string, includeWorkers = false) => shownRpc<SessionUsage>("usage.session", { id, includeWorkers }),
  report: (from: Date, to: Date, title: string) =>
    shownRpc<UsageReport>("usage.report", { from: from.toISOString(), to: to.toISOString(), title, tzOffsetMinutes: tzOffsetMinutes(from), timeZone: timeZone() }),
  reports: () => shownRpc<UsageReport[]>("usage.reports"),
  /** This computer's daily summaries, whichever computer the window shows. */
  localReports: () => rpc<UsageReport[]>("usage.reports"),
  daily: () => rpc<DailyUsageSettings>("usage.daily"),
  setDaily: (s: DailyUsageSettings) => rpc<DailyUsageSettings>("usage.set_daily", s),
};

/** Each session's own turns as the daemon keeps them, for the line under its replies. */
type TurnUsageState = {
  bySession: Record<string, SessionUsage | undefined>;
  load: (id: string) => Promise<void>;
};
const inFlight = new Map<string, Promise<void>>();
export const useTurnUsage = create<TurnUsageState>((set) => ({
  bySession: {},
  load: (id) => {
    const running = inFlight.get(id);
    if (running) return running;
    // Through a promise all the way: a client that cannot call fails here, not in the transcript.
    const p = Promise.resolve()
      .then(() => usage.session(id))
      .then((u) => set((s) => ({ bySession: { ...s.bySession, [id]: u } })))
      .catch(() => { /* the line falls back to the turn's own usage */ })
      .finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
  },
}));

/** The daily summaries Aura wrote; `unread` until the user opens the dashboard. */
type ReportState = { latest: UsageReport | null; unread: boolean; seen: () => void };
export const useUsageReports = create<ReportState>((set) => ({
  latest: null, unread: false,
  seen: () => set({ unread: false }),
}));

export function reportLine(r: UsageReport): string {
  const t = r.totals;
  return t.turns === 0 ? "No agent turns." : `${fmtCost(t.costUsd)} · ${fmtTokens(totalTokens(t))} tokens · ${t.turns} turns`;
}

export function openUsage(sessionId?: string) {
  useStore.getState().openDialog(sessionId ? { kind: "session-usage", sessionId } : { kind: "usage" });
}

/**
 * Keep the shown sessions' turn usage current and announce this computer's
 * daily summary. Mount once per window.
 */
export function useUsageSync() {
  const client = useStore((s) => s.client);
  const local = useStore(selectLocalClient);
  useEffect(() => {
    if (!client) return;
    // Another computer's sessions: what was loaded for the last one no longer refreshes.
    useTurnUsage.setState({ bySession: {} });
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const off = client.onEvent((ev: Event) => {
      if (ev.type !== "turn_completed") return;
      const id = ev.session_id;
      if (!useTurnUsage.getState().bySession[id]) return;
      // The record is written as the turn ends; one fetch per burst of turns.
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => { timers.delete(id); void useTurnUsage.getState().load(id); }, 300));
    });
    return () => { off(); timers.forEach(clearTimeout); };
  }, [client]);
  useEffect(() => {
    // The daily summary is written by this computer's daemon; a remote's own is not announced here.
    if (!local) return;
    const off = local.onEvent((ev: Event) => {
      if (ev.type !== "usage_report") return;
      useUsageReports.setState({ latest: ev.report, unread: true });
      void desktopNotify(`Usage summary: ${ev.report.title}`, reportLine(ev.report), { usageReport: ev.report.id });
      useStore.getState().toast(`Usage summary: ${reportLine(ev.report)}`, "info", { actions: [{ label: "Open", run: () => openUsage() }] });
    });
    Promise.resolve().then(() => usage.localReports()).then((all) => { if (all[0]) useUsageReports.setState((s) => ({ latest: s.latest ?? all[0] })); }).catch(() => {});
    return off;
  }, [local]);
}

export function registerUsageCommands() {
  return registerCommands([
    { id: "usage.open", title: "Usage and cost…", group: "Usage", keywords: ["tokens", "cost", "spend", "dashboard", "billing"], run: () => openUsage() },
    {
      id: "usage.session", title: "Usage of this session…", group: "Usage", keywords: ["tokens", "cost", "context"],
      run: () => { const id = useStore.getState().selectedId; if (id) openUsage(id); },
    },
  ]);
}
