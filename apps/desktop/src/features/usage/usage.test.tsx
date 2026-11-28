import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "../../lib/rpc";
import type { Session, SessionUsage, Turn, TurnUsage, UsageGroup, UsageSummary, UsageTotals } from "../../gen";
import { useStore } from "../../state/store";
import { cacheHitRate, change, compactLine, period, previous, turnLine, tzOffsetMinutes } from "./format";
import { TurnUsageLine } from "./TurnUsageLine";
import { UsageDialog } from "./UsageDialog";
import { SessionUsageDialog } from "./SessionUsageDialog";
import { usage, useTurnUsage, useUsageReports } from "./state";
import { LOCAL } from "../../state/computers";

const totals = (over: Partial<UsageTotals> = {}): UsageTotals => ({
  turns: 1, inputTokens: 1000, outputTokens: 200, cachedInputTokens: 0, cacheWriteTokens: 0, costUsd: 0, estimatedCostUsd: 0, unpricedTurns: 0, ...over,
});
const group = (key: string, label: string, t: Partial<UsageTotals>, parts: UsageGroup[] = []): UsageGroup => ({ key, label, totals: totals(t), parts });
const turnUsage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  turnId: "t1", at: "2026-11-01T10:00:00Z", model: "claude-opus-5-5", inputTokens: 1200, outputTokens: 300, cacheReadTokens: 10_000, cacheWriteTokens: 2000,
  contextUsed: 90_000, contextWindow: 200_000, costUsd: 0.034, estimated: true, ...over,
});

const call = vi.fn();
beforeEach(() => {
  call.mockReset();
  useTurnUsage.setState({ bySession: {} });
  useUsageReports.setState({ latest: null, unread: false });
  useStore.setState({ client: { call, onEvent: () => () => {} } as unknown as RpcClient, computer: LOCAL, localClient: null, sessions: {}, dialog: { kind: "usage" } });
});
afterEach(cleanup);

describe("usage in numbers", () => {
  it("turns a turn into one line, from the daemon's record or the turn's own usage", () => {
    expect(compactLine(turnLine(turnUsage(), null)!)).toBe("1.2k in · 300 out · 12k cache · ctx 45% · ~$0.034");
    const own = turnLine(undefined, {
      input_tokens: 10, output_tokens: 5, cached_input_tokens: 0, cache_write_tokens: 0, total_cost_usd: 0.5, context_window: null, context_used: 4000, running_totals: false,
    })!;
    expect(compactLine(own)).toBe("10 in · 5 out · ctx 4.0k · $0.500");
    expect(turnLine(undefined, null)).toBeNull();
    // Codex's input includes its cached input: counted once.
    const codex = turnLine(undefined, {
      input_tokens: 100, output_tokens: 20, cached_input_tokens: 80, cache_write_tokens: 0, total_cost_usd: null, context_window: null, context_used: null, running_totals: false,
    }, "codex")!;
    expect([codex.input, codex.cacheRead]).toEqual([20, 80]);
  });

  it("compares with the period before and counts cache reads of all input", () => {
    expect(change(150, 100)).toEqual({ text: "+50%", dir: "up" });
    expect(change(50, 100)).toEqual({ text: "−50%", dir: "down" });
    expect(change(5, 0)).toEqual({ text: "new", dir: "up" });
    expect(change(0, 0)).toBeNull();
    // 800 cache reads (1000 cached less 200 written) of 2000 input.
    expect(cacheHitRate({ inputTokens: 1000, cachedInputTokens: 1000, cacheWriteTokens: 200 })).toBe(0.4);
    expect(cacheHitRate({ inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });

  it("makes periods of local days and the one before", () => {
    const now = new Date(2026, 10, 12, 15, 30); // Thursday
    const week = period("7d", now);
    expect(week.from).toEqual(new Date(2026, 10, 6));
    expect(week.to).toEqual(new Date(2026, 10, 13));
    expect(previous(week)).toEqual({ from: new Date(2026, 9, 30), to: week.from });
    expect(period("week", now).from).toEqual(new Date(2026, 10, 9));
    expect(period("yesterday", now)).toMatchObject({ from: new Date(2026, 10, 11), to: new Date(2026, 10, 12) });
    expect(period("custom", now, { from: "2026-11-01", to: "2026-11-03" })).toMatchObject({ from: new Date(2026, 10, 1), to: new Date(2026, 10, 4) });
    expect(tzOffsetMinutes(now)).toBe(-now.getTimezoneOffset());
  });
});

describe("the line under a reply", () => {
  const turn: Turn = { id: "t1", session_id: "s1", status: "completed", started_at: "", ended_at: "", usage: null, error: null };

  it("shows the daemon's record, marks an estimate and opens the detail", async () => {
    useTurnUsage.setState({ bySession: { s1: { turns: [turnUsage()] } as unknown as SessionUsage } });
    render(<TurnUsageLine sessionId="s1" turn={turn} />);
    const line = screen.getByRole("button", { name: /1.2k in/ });
    expect(line.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(line);
    const detail = screen.getByRole("group", { name: "Turn usage" });
    expect(detail.textContent).toContain("10k cache read");
    expect(detail.textContent).toContain("2.0k cache write");
    expect(detail.textContent).toContain("of 200k (45%) context after");
    expect(detail.textContent).toContain("~$0.034 estimated");
  });

  it("says nothing for a turn that reported no usage", () => {
    const { container } = render(<TurnUsageLine sessionId="s1" turn={turn} />);
    expect(container.textContent).toBe("");
  });
});

const summary = (groupBy: UsageSummary["groupBy"], groups: UsageGroup[], t: Partial<UsageTotals> = {}): UsageSummary => ({
  from: null, to: null, groupBy, totals: totals(t), groups, more: 0,
});

describe("the dashboard", () => {
  beforeEach(() => {
    call.mockImplementation(async (method: string, p: Record<string, unknown>) => {
      if (method === "usage.reports") return [];
      if (method === "usage.report") return { id: "r", title: p.title, from: p.from, to: p.to, generatedAt: "", totals: totals(), previous: totals(), markdown: "## Usage summary: Today\n\n- **Cost:** $3.00" };
      if (method !== "usage.summary") return null;
      switch (p.groupBy) {
        case "day": return summary("day", [
          group("2026-11-10", "2026-11-10", { costUsd: 1 }, [group("claude-opus-5-5", "claude-opus-5-5", { costUsd: 1 })]),
          group("2026-11-11", "2026-11-11", { costUsd: 2 }, [group("gpt-5", "gpt-5", { costUsd: 2, estimatedCostUsd: 2 })]),
        ], { turns: 3, costUsd: 3, estimatedCostUsd: 2 });
        // The period before, for the comparison.
        case "agent": return summary("agent", [], { turns: 2, costUsd: 2 });
        case "session": return summary("session", [group("s1", "Checkout", { costUsd: 2.5 }), group("gone", "Old one", { costUsd: 0.5 })], { costUsd: 3 });
        default: return summary(p.groupBy as UsageSummary["groupBy"], [], {});
      }
    });
  });

  it("shows totals against the period before, the days by model and the biggest sessions", async () => {
    useStore.setState({ sessions: { s1: { id: "s1", title: "Checkout" } as Session } });
    render(<UsageDialog />);
    await waitFor(() => expect(screen.getByText("Cost per day")).toBeTruthy());
    const cost = [...document.querySelectorAll(".usage-card")].find((c) => c.querySelector(".usage-card-label")?.textContent === "Cost")!;
    expect(cost.textContent).toContain("$3.00");
    expect(cost.textContent).toContain("+50%");
    expect(cost.textContent).toContain("~$2.00 estimated");
    expect(screen.getByRole("img", { name: "cost per day" }).querySelectorAll("rect[fill]").length).toBe(2);
    expect(screen.getByText("gpt-5")).toBeTruthy();
    const rows = screen.getAllByRole("row");
    expect(rows[1].textContent).toContain("Checkout");
    expect(rows[2].textContent).toContain("deleted");
    // A session opens its own dashboard.
    fireEvent.click(rows[1]);
    expect(useStore.getState().dialog).toEqual({ kind: "session-usage", sessionId: "s1" });
    // The daily summary is read once the dashboard is open.
    expect(useUsageReports.getState().unread).toBe(false);
  });

  it("writes a summary of a period to read and copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<UsageDialog />);
    await waitFor(() => expect(screen.getByText("Summary")).toBeTruthy());
    const panel = screen.getByText("Summary").closest("section")!;
    await act(async () => { fireEvent.click(within(panel as HTMLElement).getByRole("button", { name: "Today" })); });
    expect(call).toHaveBeenCalledWith("usage.report", expect.objectContaining({ title: "Today", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" })); });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("## Usage summary: Today"));
  });
});

describe("a session's dashboard", () => {
  it("asks for workers of an orchestrator and lists them", async () => {
    const data: SessionUsage = {
      sessionId: "lead", title: "Lead", totals: totals({ costUsd: 1, turns: 2 }), allTotals: totals({ costUsd: 4, turns: 5 }),
      turns: [turnUsage({ turnId: "a", contextUsed: 10_000 }), turnUsage({ turnId: "b", contextUsed: 30_000 })],
      models: [group("claude-opus-5-5", "claude-opus-5-5", { costUsd: 4 })],
      workers: [group("w1", "Backend", { costUsd: 3 })],
    };
    call.mockResolvedValue(data);
    useStore.setState({ sessions: { lead: { id: "lead", title: "Lead", orchestrator: true } as Session, w1: { id: "w1", title: "Backend" } as Session } });
    render(<SessionUsageDialog sessionId="lead" />);
    await waitFor(() => expect(screen.getByText("Workers")).toBeTruthy());
    expect(call).toHaveBeenCalledWith("usage.session", { id: "lead", includeWorkers: true });
    expect(screen.getByText("Cost with workers").parentElement!.textContent).toContain("$1.00 itself");
    expect(screen.getByRole("img", { name: "Context used after each turn" }).querySelectorAll("circle").length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: "Backend" }));
    expect(useStore.getState().dialog).toEqual({ kind: "session-usage", sessionId: "w1" });
  });
});

describe("on a remote computer", () => {
  const localCall = vi.fn();
  beforeEach(() => {
    localCall.mockReset();
    localCall.mockResolvedValue({ enabled: true, time: "18:00" });
    call.mockImplementation(async (method: string, p: Record<string, unknown>) => {
      if (method === "usage.summary") return summary(p.groupBy as UsageSummary["groupBy"], [], {});
      return [];
    });
    useStore.setState({ computer: "remote-1", localClient: { call: localCall, onEvent: () => () => {} } as unknown as RpcClient });
  });

  it("reads its history from it and keeps the daily summary this computer's", async () => {
    await usage.session("s9");
    expect(call).toHaveBeenCalledWith("usage.session", { id: "s9", includeWorkers: false });
    await usage.daily();
    expect(localCall).toHaveBeenCalledWith("usage.daily", {});
    expect(call).not.toHaveBeenCalledWith("usage.daily", expect.anything());
  });

  it("shows its dashboard without this computer's daily summary", async () => {
    useUsageReports.setState({ latest: { id: "r", title: "Yesterday", from: "", to: "", generatedAt: "", totals: totals(), previous: totals(), markdown: "" }, unread: true });
    render(<UsageDialog />);
    await waitFor(() => expect(call).toHaveBeenCalledWith("usage.summary", expect.objectContaining({ groupBy: "day" })));
    expect(screen.getByText(/Usage and cost · Remote computer/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Latest daily" })).toBeNull();
    expect(screen.queryByText("Settings → Usage")).toBeNull();
    expect(localCall).not.toHaveBeenCalledWith("usage.summary", expect.anything());
  });
});
