// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { UiApi } from "@aura/mod-sdk/ui";
import type { PrEntry, SessionView } from "../shared/types";
import { session } from "../test/fixtures";
import { setCtx } from "./ctx";
import { cachedView, keepOpenSessions } from "./openSessions";
import { PrStatusSection } from "./PrStatusSection";
import { RENEW_MS } from "./usePullStatus";

const NOW = Date.parse("2026-11-27T10:00:30Z");

function view(sessionId: string, number: number, title: string): SessionView {
  const entry: PrEntry = {
    ref: { url: `https://github.com/acme/api/pull/${number}`, repo: "acme/api", number, sources: [{ sessionId, title: sessionId, worker: false }] },
    status: {
      url: `https://github.com/acme/api/pull/${number}`, repo: "acme/api", number, title, author: "me", updatedAt: "2026-11-27T09:00:00Z", state: "open",
      reviewers: { reviewed: [], pending: [], complete: true },
      checks: { state: "passing", passing: 1, failing: 0, pending: 0, total: 1, open: [], complete: true },
      readiness: { ready: true, reasons: [] },
      merge: { reviewDecision: "", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headSha: "", headRef: "", sameRepo: true, squashAllowed: true, canMerge: true, account: "github.com:me" },
    },
    readAt: "2026-11-27T10:00:00Z",
    error: null,
  };
  return { sessionId, pulls: [entry], blocked: null };
}

const views: Record<string, SessionView> = { a: view("a", 1, "PR of A"), b: view("b", 2, "PR of B") };
/** `ctx.sessions`: the open sessions, as Aura reports them. */
let open: string[] = [];
const listeners = new Set<(ids: string[]) => void>();
const sessions = {
  open: () => open,
  onOpenChange: (fn: (ids: string[]) => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
const setTabs = (...ids: string[]) =>
  act(() => {
    open = ids;
    listeners.forEach((fn) => fn(ids));
  });

function fakeCtx() {
  const pending: Array<() => void> = [];
  let hold = false;
  const rpc = vi.fn(async (name: string, p?: any) => {
    if (name !== "watch" || p?.background) return name === "watch" ? null : true;
    if (!hold) return views[p.sessionId];
    return new Promise((resolve) => pending.push(() => resolve(views[p.sessionId])));
  });
  const ctx = {
    rpc, on: () => () => {}, onConnection: () => () => {}, sessions,
    storage: { get: () => undefined, set: () => {}, delete: () => {} },
  } as unknown as UiApi;
  setCtx(ctx);
  return { rpc, ctx, pending, setHold: (on: boolean) => (hold = on) };
}

describe("sessions open in tabs", () => {
  let stop: () => void = () => {};
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    stop();
    cleanup();
    setCtx(null);
    open = [];
    listeners.clear();
    vi.useRealTimers();
  });

  it("keeps a background watch per open session, renewed, and lets go of a closed one", async () => {
    const ctx = fakeCtx();
    await setTabs("a", "b");
    stop = keepOpenSessions(ctx.ctx);
    const background = () => ctx.rpc.mock.calls.filter(([n, p]) => n === "watch" && p.background).map(([, p]) => p.sessionId);
    expect(background()).toEqual(["a", "b"]);
    await act(async () => void vi.advanceTimersByTime(RENEW_MS));
    expect(background()).toEqual(["a", "b", "a", "b"]);
    await setTabs("a");
    expect(ctx.rpc).toHaveBeenLastCalledWith("unwatch", { viewer: expect.stringMatching(/:b$/) });
  });

  it("shows a session's cards at once when switching back, then refreshes them", async () => {
    const ctx = fakeCtx();
    await setTabs("a", "b");
    stop = keepOpenSessions(ctx.ctx);
    const { rerender } = render(<PrStatusSection session={session("a")} />);
    expect(await screen.findByRole("article", { name: /PR of A/ })).toBeTruthy();
    rerender(<PrStatusSection session={session("b")} />);
    expect(await screen.findByRole("article", { name: /PR of B/ })).toBeTruthy();
    // Back to A while GitHub is slow: its cards are there before any answer, dated.
    ctx.setHold(true);
    rerender(<PrStatusSection session={session("a")} />);
    expect(screen.getByRole("article", { name: /PR of A/ })).toBeTruthy();
    expect(screen.getByText("updated 30s ago")).toBeTruthy();
    expect(ctx.rpc).toHaveBeenLastCalledWith("watch", expect.objectContaining({ sessionId: "a", refresh: true }));
    await act(async () => ctx.pending.splice(0).forEach((release) => release()));
  });

  it("forgets a session's cards when its tab closes", async () => {
    const ctx = fakeCtx();
    await setTabs("a", "b");
    stop = keepOpenSessions(ctx.ctx);
    const { rerender } = render(<PrStatusSection session={session("b")} />);
    await screen.findByRole("article", { name: /PR of B/ });
    rerender(<PrStatusSection session={session("a")} />);
    await screen.findByRole("article", { name: /PR of A/ });
    expect(cachedView("b")).not.toBeNull();
    await setTabs("a");
    expect(cachedView("b")).toBeNull();
    ctx.setHold(true);
    rerender(<PrStatusSection session={session("b")} />);
    expect(screen.queryByRole("article")).toBeNull();
    await act(async () => ctx.pending.splice(0).forEach((release) => release()));
  });
});
