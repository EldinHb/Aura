// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { UiApi } from "@aura/mod-sdk/ui";
import { useStore } from "@aura/host";
import type { PrEntry, SessionView } from "../shared/types";
import { session } from "../test/fixtures";
import { setCtx } from "./ctx";
import { PrStatusSection } from "./PrStatusSection";
import { RENEW_MS } from "./usePullStatus";

const NOW = Date.parse("2026-11-27T10:00:30Z");

function entry(over: Partial<PrEntry["ref"]> & { status?: any; error?: string | null } = {}): PrEntry {
  const number = over.number ?? 1;
  return {
    ref: { url: `https://github.com/acme/api/pull/${number}`, repo: "acme/api", number, sources: over.sources ?? [{ sessionId: "lead", title: "Lead", worker: false }] },
    status: over.status === undefined ? {
      url: `https://github.com/acme/api/pull/${number}`, repo: "acme/api", number, title: "Add rate limiting", author: "me", state: "open",
      reviewers: {
        reviewed: [{ name: "alice", kind: "user", state: "APPROVED", previous: null }],
        pending: [{ name: "bob", kind: "user", state: "PENDING", previous: "CHANGES_REQUESTED" }, { name: "acme/core", kind: "team", state: "PENDING", previous: null }],
      },
      checks: { state: "failing", passing: 7, failing: 1, pending: 1, total: 9, open: [
        { name: "test", url: "https://ci.example/test", state: "failing" }, { name: "e2e", url: null, state: "pending" },
      ] },
      readiness: { ready: false, reasons: ["review_required", "checks_failing"] },
    } : over.status,
    readAt: "2026-11-27T10:00:00Z",
    error: over.error ?? null,
  };
}

function fakeCtx(view: SessionView) {
  const listeners = new Map<string, (p: any) => void>();
  const rpc = vi.fn(async (name: string, _params?: any) => (name === "unwatch" ? true : view));
  const ctx = { rpc, on: (name: string, fn: (p: any) => void) => { listeners.set(name, fn); return () => listeners.delete(name); }, onConnection: () => () => {} };
  setCtx(ctx as unknown as UiApi);
  return { rpc, emit: (name: string, p: unknown) => listeners.get(name)?.(p) };
}

const lead = session("lead", { title: "Lead" });

describe("PrStatusSection", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    setCtx(null);
    vi.useRealTimers();
  });

  it("is hidden while the session tree has no PRs", async () => {
    fakeCtx({ sessionId: "lead", pulls: [], blocked: null });
    const { container } = render(<PrStatusSection session={lead} />);
    await act(async () => {});
    expect(container.innerHTML).toBe("");
  });

  it("shows state, readiness, checks and reviewer groups as text", async () => {
    fakeCtx({ sessionId: "lead", pulls: [entry()], blocked: null });
    render(<PrStatusSection session={lead} />);
    const card = await screen.findByRole("article", { name: "Pull request #1: Add rate limiting" });
    expect(within(card).getByText("Open")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "Add rate limiting" }).getAttribute("href")).toBe("https://github.com/acme/api/pull/1");
    expect(card.textContent).toContain("Not ready: Required reviews missing · Checks failing");
    expect(screen.getByText("updated 30s ago")).toBeTruthy();

    const reviewed = within(card).getByRole("group", { name: "Reviewed" });
    expect(reviewed.textContent).toContain("aliceApproved");
    const pending = within(card).getByRole("group", { name: "Still to review" });
    expect(pending.textContent).toContain("bobRe-requested");
    expect(pending.textContent).toContain("acme/core (team)Pending");
  });

  it("expands the checks to the failing and pending ones, linked", async () => {
    fakeCtx({ sessionId: "lead", pulls: [entry()], blocked: null });
    render(<PrStatusSection session={lead} />);
    const toggle = await screen.findByRole("button", { name: /Checks failing · 1 failing · 1 pending · 7 passing/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("list", { name: "Failing and pending checks" });
    expect(within(list).getByRole("link", { name: "test" }).getAttribute("href")).toBe("https://ci.example/test");
    expect(list.textContent).toContain("Pendinge2e");
  });

  it("names the worker a PR came from and selects it on click", async () => {
    fakeCtx({ sessionId: "lead", pulls: [entry({ sources: [{ sessionId: "lead", title: "Lead", worker: false }, { sessionId: "w1", title: "API limits", worker: true }] })], blocked: null });
    render(<PrStatusSection session={lead} />);
    const card = await screen.findByRole("article");
    expect(card.textContent).toContain("from this session, worker API limits");
    fireEvent.click(within(card).getByRole("button", { name: "worker API limits" }));
    expect(useStore.getState().selectedId).toBe("w1");
  });

  it("says why it is not updating and keeps the dated data", async () => {
    fakeCtx({ sessionId: "lead", pulls: [entry({ status: { ...entry().status, state: "merged", readiness: null } })], blocked: "GitHub login expired." });
    render(<PrStatusSection session={lead} />);
    expect((await screen.findByRole("status")).textContent).toContain("Not updating: GitHub login expired.");
    expect(screen.getByText("Merged")).toBeTruthy();
    expect(screen.queryByText(/Ready to merge|Not ready/)).toBeNull();
    expect(screen.getByText("updated 30s ago")).toBeTruthy();
  });

  it("hides who is still to review once a PR is merged or closed", async () => {
    const done = (state: string, number: number) => entry({ number, status: { ...entry({ number }).status, state, readiness: null } });
    fakeCtx({ sessionId: "lead", pulls: [done("merged", 1), done("closed", 2), entry({ number: 3 })], blocked: null });
    render(<PrStatusSection session={lead} />);
    const cards = await screen.findAllByRole("article");
    expect(cards.map((c) => within(c).queryByRole("group", { name: "Still to review" }) !== null)).toEqual([false, false, true]);
    expect(within(cards[0]).getByRole("group", { name: "Reviewed" })).toBeTruthy();
  });

  it("watches while shown, renews, refreshes on demand, follows changes and lets go when unmounted", async () => {
    const { rpc, emit } = fakeCtx({ sessionId: "lead", pulls: [entry()], blocked: null });
    const { unmount } = render(<PrStatusSection session={lead} />);
    await screen.findByRole("article");
    expect(rpc).toHaveBeenCalledWith("watch", expect.objectContaining({ sessionId: "lead", refresh: true }));
    await act(async () => void vi.advanceTimersByTime(RENEW_MS));
    expect(rpc).toHaveBeenLastCalledWith("watch", expect.objectContaining({ sessionId: "lead", refresh: false }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh pull request status" })));
    expect(rpc).toHaveBeenLastCalledWith("refresh", { sessionId: "lead" });
    await act(async () => emit("changed", { sessionIds: ["other"] }));
    expect(rpc).not.toHaveBeenCalledWith("view", expect.anything());
    await act(async () => emit("changed", { sessionIds: ["lead"] }));
    expect(rpc).toHaveBeenLastCalledWith("view", { sessionId: "lead" });
    const viewer = rpc.mock.calls.find(([name]) => name === "watch")![1].viewer;
    unmount();
    expect(rpc).toHaveBeenLastCalledWith("unwatch", { viewer });
  });
});
