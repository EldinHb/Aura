// @vitest-environment jsdom
// On a host without ctx.sessions or openView's options (Aura 0.4.0): nothing breaks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UiApi } from "@aura/mod-sdk/ui";
import { useStore } from "@aura/host";
import type { PrEntry, SessionView } from "../shared/types";
import { session } from "../test/fixtures";
import { setCtx } from "./ctx";
import { cachedView, keepOpenSessions } from "./openSessions";
import { PrStatusSection } from "./PrStatusSection";

function view(sessionId: string, number: number): SessionView {
  const entry: PrEntry = {
    ref: { url: `https://github.com/acme/api/pull/${number}`, repo: "acme/api", number, sources: [{ sessionId, title: sessionId, worker: false }] },
    status: {
      url: `https://github.com/acme/api/pull/${number}`, repo: "acme/api", number, title: `PR of ${sessionId}`, author: "me", updatedAt: "2026-11-27T09:00:00Z", state: "open",
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

/** The UiApi of Aura 0.4.0: no `sessions`, and `openView(viewId, props)` only. */
function oldHostCtx() {
  const opened: unknown[][] = [];
  const rpc = vi.fn(async (name: string, p?: any) => (name === "watch" ? (p.background ? null : view(p.sessionId, p.sessionId === "a" ? 1 : 2)) : name === "unwatch" ? true : null));
  const ctx = {
    rpc, on: () => () => {}, onConnection: () => () => {},
    storage: { get: () => undefined, set: () => {}, delete: () => {} },
    openView: (viewId: string, props?: unknown) => void opened.push([viewId, props]),
  } as unknown as UiApi;
  setCtx(ctx);
  return { ctx, rpc, opened };
}

describe("on an older host (Aura 0.4.0)", () => {
  let stop: () => void = () => {};
  beforeEach(() => act(() => useStore.setState({ selectedId: "a" })));
  afterEach(() => {
    stop();
    cleanup();
    setCtx(null);
    useStore.setState({ selectedId: null });
  });

  it("keeps the selected session's cards only, following the selection", async () => {
    const { ctx, rpc } = oldHostCtx();
    stop = keepOpenSessions(ctx);
    expect(rpc).toHaveBeenCalledWith("watch", expect.objectContaining({ sessionId: "a", background: true }));
    const { rerender } = render(<PrStatusSection session={session("a")} />);
    expect(await screen.findByRole("article", { name: /PR of a/ })).toBeTruthy();
    expect(cachedView("a")).not.toBeNull();
    act(() => useStore.setState({ selectedId: "b" }));
    rerender(<PrStatusSection session={session("b")} />);
    expect(await screen.findByRole("article", { name: /PR of b/ })).toBeTruthy();
    // "a" is no longer open: its cards and background watch went.
    expect(cachedView("a")).toBeNull();
    expect(rpc).toHaveBeenCalledWith("unwatch", { viewer: expect.stringMatching(/:a$/) });
  });

  it("opens a PR's page with the old two-argument openView", async () => {
    const { opened } = oldHostCtx();
    render(<PrStatusSection session={session("a")} />);
    fireEvent.click(await screen.findByRole("button", { name: "PR of a" }));
    expect(opened).toEqual([["pr", { key: "https://github.com/acme/api/pull/1", title: "#1 PR of a", repo: "acme/api", number: 1, url: "https://github.com/acme/api/pull/1" }]]);
  });
});
