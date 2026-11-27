// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { UiApi } from "@aura/mod-sdk/ui";
import { useStore } from "@aura/host";
import type { PrEntry, SessionView } from "../shared/types";
import { session } from "../test/fixtures";
import { setCtx } from "./ctx";
import { DONE_OPEN_KEY, PrStatusSection } from "./PrStatusSection";
import { RENEW_MS } from "./usePullStatus";

const NOW = Date.parse("2026-11-27T10:00:30Z");
/** Merge facts of a PR that does not offer "Squash and merge" (not approved). */
const noMerge = { reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", headSha: "a".repeat(40), headRef: "feature", sameRepo: true, squashAllowed: true, canMerge: true, account: "github.com:me" };

function entry(over: Partial<PrEntry["ref"]> & { status?: any; error?: string | null } = {}): PrEntry {
  const number = over.number ?? 1;
  return {
    ref: { url: `https://github.com/acme/api/pull/${number}`, repo: "acme/api", number, sources: over.sources ?? [{ sessionId: "lead", title: "Lead", worker: false }] },
    status: over.status === undefined ? {
      url: `https://github.com/acme/api/pull/${number}`, repo: "acme/api", number, title: "Add rate limiting", author: "me", updatedAt: "2026-11-27T09:00:00Z", state: "open",
      reviewers: {
        reviewed: [{ name: "alice", kind: "user", state: "APPROVED", previous: null }],
        pending: [{ name: "bob", kind: "user", state: "PENDING", previous: "CHANGES_REQUESTED" }, { name: "acme/core", kind: "team", state: "PENDING", previous: null }],
        complete: true,
      },
      checks: { state: "failing", passing: 7, failing: 1, pending: 1, total: 9, open: [
        { name: "test", url: "https://ci.example/test", state: "failing" }, { name: "e2e", url: null, state: "pending" },
      ], complete: true },
      readiness: { ready: false, reasons: ["review_required", "checks_failing"] },
      merge: noMerge,
    } : over.status,
    readAt: "2026-11-27T10:00:00Z",
    error: over.error ?? null,
  };
}

/** `ctx.storage`, kept across renders of one test. */
const stored = new Map<string, unknown>();

function fakeCtx(view: SessionView) {
  const openView = vi.fn();
  const listeners = new Map<string, (p: any) => void>();
  const rpc = vi.fn(async (name: string, _params?: any) => (name === "unwatch" ? true : view));
  const ctx = {
    rpc, on: (name: string, fn: (p: any) => void) => { listeners.set(name, fn); return () => listeners.delete(name); }, onConnection: () => () => {},
    storage: { get: (k: string) => stored.get(k), set: (k: string, v: unknown) => void stored.set(k, v), delete: (k: string) => void stored.delete(k) },
    openView,
    // No session counts as open, so no test sees cards another one cached (openSessions.test covers that).
    sessions: { open: () => [], onOpenChange: () => () => {} },
  };
  setCtx(ctx as unknown as UiApi);
  return { rpc, openView, emit: (name: string, p: unknown) => listeners.get(name)?.(p) };
}

const lead = session("lead", { title: "Lead" });

describe("PrStatusSection", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    stored.clear();
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
    expect(within(card).getByRole("link", { name: "Open #1 on GitHub" }).getAttribute("href")).toBe("https://github.com/acme/api/pull/1");
    expect(card.textContent).toContain("Not ready: Required reviews missing · Checks failing");
    expect(screen.getByText("updated 30s ago")).toBeTruthy();

    const reviewed = within(card).getByRole("group", { name: "Reviewed" });
    expect(reviewed.textContent).toContain("aliceApproved");
    const pending = within(card).getByRole("group", { name: "Still to review" });
    expect(pending.textContent).toContain("bobRe-requested");
    expect(pending.textContent).toContain("acme/core (team)Pending");
  });

  it("opens the PR's page in a tab from its title, the same tab every time", async () => {
    const { openView } = fakeCtx({ sessionId: "lead", pulls: [entry()], blocked: null });
    render(<PrStatusSection session={lead} />);
    const title = await screen.findByRole("button", { name: "Add rate limiting" });
    fireEvent.click(title);
    fireEvent.click(title);
    const page = { key: "https://github.com/acme/api/pull/1", title: "#1 Add rate limiting", repo: "acme/api", number: 1, url: "https://github.com/acme/api/pull/1" };
    expect(openView.mock.calls).toEqual([["pr", page, { preview: false }], ["pr", page, { preview: false }]]);
  });

  it("shows a card without data once, with one error line (QA)", async () => {
    const failed = { ...entry({ status: null, error: "Could not resolve to a PullRequest" }), readAt: null };
    fakeCtx({ sessionId: "lead", pulls: [failed], blocked: null });
    const { unmount } = render(<PrStatusSection session={lead} />);
    const card = await screen.findByRole("article");
    expect(card.textContent!.match(/acme\/api ?#1/g)).toHaveLength(1);
    expect(within(card).getAllByText(/Could not read/)).toHaveLength(1);
    unmount();
    // With the section saying why nothing updates, the card does not say it again.
    fakeCtx({ sessionId: "lead", pulls: [failed], blocked: "GitHub login expired." });
    render(<PrStatusSection session={lead} />);
    expect((await screen.findByRole("status")).textContent).toContain("GitHub login expired.");
    expect(within(screen.getByRole("article")).queryByText(/Could not read/)).toBeNull();
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
    expect(card.querySelector(".prs-sources")!.getAttribute("title")).toBe("from this session, worker API limits");
    fireEvent.click(within(card).getByRole("button", { name: "worker API limits" }));
    expect(useStore.getState().selectedId).toBe("w1");
  });

  it("says why it is not updating and keeps the dated data", async () => {
    fakeCtx({ sessionId: "lead", pulls: [entry()], blocked: "GitHub login expired." });
    render(<PrStatusSection session={lead} />);
    expect((await screen.findByRole("status")).textContent).toContain("Not updating: GitHub login expired.");
    expect(screen.getByRole("article").textContent).toContain("Not ready");
    expect(screen.getByText("updated 30s ago")).toBeTruthy();
  });

  const done = (state: string, number: number, title = `Done ${number}`) =>
    entry({ number, status: { ...entry({ number }).status, title, state, readiness: null } });
  const withStatus = (number: number, over: object) => entry({ number, status: { ...entry({ number }).status, title: `PR ${number}`, ...over } });

  it("lists open PRs first: not ready, then ready, then drafts", async () => {
    fakeCtx({ sessionId: "lead", blocked: null, pulls: [
      withStatus(1, { state: "draft", readiness: { ready: false, reasons: ["draft"] } }),
      done("merged", 2),
      withStatus(3, { readiness: { ready: true, reasons: [] } }),
      withStatus(4, {}),
    ] });
    render(<PrStatusSection session={lead} />);
    const cards = await screen.findAllByRole("article");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["Pull request #4: PR 4", "Pull request #3: PR 3", "Pull request #1: PR 1"]);
  });

  it("folds merged and closed PRs into one remembered group of one-line links", async () => {
    const { openView } = fakeCtx({ sessionId: "lead", pulls: [done("merged", 1, "Ship it"), done("closed", 2), entry({ number: 3 })], blocked: null });
    const { unmount } = render(<PrStatusSection session={lead} />);
    expect(await screen.findAllByRole("article")).toHaveLength(1);
    const toggle = screen.getByRole("button", { name: "Merged & closed (2)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("list", { name: "Merged and closed pull requests" })).toBeNull();
    fireEvent.click(toggle);
    const list = screen.getByRole("list", { name: "Merged and closed pull requests" });
    const row = within(list).getByRole("button", { name: /Ship it/ });
    expect(row.textContent).toBe("MergedShip it#1");
    expect(within(list).getByRole("link", { name: "Open #1 on GitHub" }).getAttribute("href")).toBe("https://github.com/acme/api/pull/1");
    // Like an open PR's title, the row opens the PR's page in a tab (QA).
    fireEvent.click(row);
    expect(openView).toHaveBeenCalledWith("pr", { key: "https://github.com/acme/api/pull/1", title: "#1 Ship it", repo: "acme/api", number: 1, url: "https://github.com/acme/api/pull/1" }, { preview: false });
    expect(within(list).queryByRole("group")).toBeNull();
    expect(stored.get(DONE_OPEN_KEY)).toBe(true);
    unmount();
    render(<PrStatusSection session={lead} />);
    expect((await screen.findByRole("button", { name: "Merged & closed (2)" })).getAttribute("aria-expanded")).toBe("true");
  });

  it("sums up more than two sources on one line, and lists them when unfolded", async () => {
    const sources = [{ sessionId: "lead", title: "Lead", worker: false },
      ...[1, 2, 3].map((n) => ({ sessionId: `w${n}`, title: `#24${n} worker with a long name`, worker: true }))];
    fakeCtx({ sessionId: "lead", pulls: [entry({ sources })], blocked: null });
    render(<PrStatusSection session={lead} />);
    const card = await screen.findByRole("article");
    const summary = within(card).getByRole("button", { name: "this session + 3 workers" });
    expect(summary.parentElement!.getAttribute("title")).toBe("from this session, worker #241 worker with a long name, worker #242 worker with a long name, worker #243 worker with a long name");
    fireEvent.click(summary);
    fireEvent.click(within(card).getByRole("button", { name: "worker #242 worker with a long name" }));
    expect(useStore.getState().selectedId).toBe("w2");
  });

  it("shows dismissed reviews, an UNSTABLE merge state and an incomplete reviewer list (review items 1, 5, 7)", async () => {
    const base = entry().status;
    fakeCtx({ sessionId: "lead", pulls: [entry({ status: {
      ...base,
      reviewers: { reviewed: [{ name: "erin", kind: "user", state: "DISMISSED", previous: null }], pending: [{ name: "finn", kind: "user", state: "PENDING", previous: "DISMISSED" }], complete: false },
      readiness: { ready: false, reasons: ["unstable"] },
    } })], blocked: null });
    render(<PrStatusSection session={lead} />);
    const card = await screen.findByRole("article");
    expect(within(card).getByRole("group", { name: "Reviewed" }).textContent).toContain("erinDismissed");
    expect(within(card).getByTitle("finn: re-requested, previously dismissed")).toBeTruthy();
    expect(card.textContent).toContain("Not ready: Checks not passing");
    expect(card.textContent).toContain("Too many reviewers to list them all here");
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
    // The kept view was asked for once at the start; another session's change asks nothing more.
    const views = () => rpc.mock.calls.filter(([n]) => n === "view").length;
    expect(views()).toBe(1);
    await act(async () => emit("changed", { sessionIds: ["other"] }));
    expect(views()).toBe(1);
    await act(async () => emit("changed", { sessionIds: ["lead"] }));
    expect(rpc).toHaveBeenLastCalledWith("view", { sessionId: "lead" });
    const viewer = rpc.mock.calls.find(([name]) => name === "watch")![1].viewer;
    unmount();
    expect(rpc).toHaveBeenLastCalledWith("unwatch", { viewer });
  });
});
