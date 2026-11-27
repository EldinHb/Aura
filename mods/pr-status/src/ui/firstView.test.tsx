// @vitest-environment jsdom
// QA: after a restart the daemon answers `view` at once (kept data), while `watch` reads GitHub
// for seconds; the cards show from `view` first.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { UiApi } from "@aura/mod-sdk/ui";
import type { SessionView } from "../shared/types";
import { session } from "../test/fixtures";
import { setCtx } from "./ctx";
import { PrStatusSection } from "./PrStatusSection";

const view = (title: string): SessionView => ({
  sessionId: "lead", blocked: null,
  pulls: [{ ref: { url: "https://github.com/acme/api/pull/1", repo: "acme/api", number: 1, sources: [{ sessionId: "lead", title: "Lead", worker: false }] }, status: {
    url: "https://github.com/acme/api/pull/1", repo: "acme/api", number: 1, title, author: "me", updatedAt: "2026-11-27T09:00:00Z", state: "open",
    reviewers: { reviewed: [], pending: [], complete: true }, checks: { state: "passing", passing: 1, failing: 0, pending: 0, total: 1, open: [], complete: true },
    readiness: { ready: true, reasons: [] },
    merge: { reviewDecision: "", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headSha: "", headRef: "", sameRepo: true, squashAllowed: true, canMerge: true, account: "github.com:me" },
  }, readAt: "2026-11-27T09:00:00Z", error: null }],
});

function fakeCtx(answer: (name: string) => Promise<unknown>) {
  setCtx({ rpc: vi.fn(answer), on: () => () => {}, onConnection: () => () => {}, storage: { get: () => undefined, set: () => {}, delete: () => {} }, sessions: { open: () => [], onOpenChange: () => () => {} } } as unknown as UiApi);
}

describe("the first cards", () => {
  afterEach(() => {
    cleanup();
    setCtx(null);
  });

  it("show what the daemon half kept at once, before the watch has read GitHub", async () => {
    let answerWatch!: (v: SessionView) => void;
    fakeCtx((name) => (name === "view" ? Promise.resolve(view("Kept")) : name === "watch" ? new Promise((r) => (answerWatch = r)) : Promise.resolve(true)));
    render(<PrStatusSection session={session("lead")} />);
    await act(async () => {});
    expect(screen.getByRole("article", { name: /Kept/ })).toBeTruthy();
    await act(async () => answerWatch(view("Fresh")));
    expect(screen.getByRole("article", { name: /Fresh/ })).toBeTruthy();
  });

  it("are not replaced by a kept view that arrives after the watch's answer", async () => {
    let answerView!: (v: SessionView) => void;
    fakeCtx((name) => (name === "view" ? new Promise((r) => (answerView = r)) : name === "watch" ? Promise.resolve(view("Fresh")) : Promise.resolve(true)));
    render(<PrStatusSection session={session("lead")} />);
    await act(async () => {});
    await act(async () => answerView(view("Kept")));
    expect(screen.getByRole("article", { name: /Fresh/ })).toBeTruthy();
    expect(screen.queryByRole("article", { name: /Kept/ })).toBeNull();
  });

  it("fall through to the watch when the first view is empty or fails (review)", async () => {
    for (const first of [() => Promise.resolve(null), () => Promise.reject(new Error("daemon restarting")), () => Promise.resolve({ sessionId: "lead" })]) {
      fakeCtx((name) => (name === "view" ? first() : name === "watch" ? Promise.resolve(view("Fresh")) : Promise.resolve(true)));
      render(<PrStatusSection session={session("lead")} />);
      await act(async () => {});
      expect(screen.getByRole("article", { name: /Fresh/ })).toBeTruthy();
      cleanup();
    }
  });
});
