// @vitest-environment jsdom
// QA: the "updated Xs ago" label of the section.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { UiApi } from "@aura/mod-sdk/ui";
import type { PrEntry, SessionView } from "../shared/types";
import { session } from "../test/fixtures";
import { setCtx } from "./ctx";
import { PrStatusSection } from "./PrStatusSection";

const NOW = Date.parse("2026-11-27T10:10:00Z");

function entry(number: number, state: "open" | "merged", readAt: string): PrEntry {
  return {
    ref: { url: `https://github.com/acme/api/pull/${number}`, repo: "acme/api", number, sources: [{ sessionId: "lead", title: "Lead", worker: false }] },
    status: {
      url: `https://github.com/acme/api/pull/${number}`, repo: "acme/api", number, title: `PR ${number}`, author: "me", updatedAt: "2026-11-27T09:00:00Z", state,
      reviewers: { reviewed: [], pending: [], complete: true },
      checks: { state: "passing", passing: 1, failing: 0, pending: 0, total: 1, open: [], complete: true },
      readiness: state === "open" ? { ready: true, reasons: [] } : null,
      merge: { reviewDecision: "", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", headSha: "", headRef: "", sameRepo: true, squashAllowed: true, canMerge: true, account: "github.com:me" },
    } as PrEntry["status"],
    readAt,
    error: null,
  };
}

function fakeCtx(view: SessionView) {
  const rpc = vi.fn(async (name: string) => (name === "unwatch" ? true : view));
  setCtx({ rpc, on: () => () => {}, onConnection: () => () => {}, storage: { get: () => undefined, set: () => {}, delete: () => {} } } as unknown as UiApi);
}

describe("updated label", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    setCtx(null);
    vi.useRealTimers();
  });

  // A merged PR is read once and then left alone, so its readAt only ages. The label takes the
  // oldest readAt of all cards, so beside a merged PR it says "9m ago" while the open PR was
  // read 5 s ago, and keeps growing for as long as the merged PR is listed. Seen in the real app:
  // cards refreshed at :06:35 and :07:42 while the label read "2m ago", "3m ago".
  // Fixed: the label takes the oldest read of the PRs still polled (see ui/order.ts).
  it("is not held back by a merged PR that is never read again", async () => {
    fakeCtx({
      sessionId: "lead", blocked: null,
      pulls: [entry(1, "merged", "2026-11-27T10:00:00Z"), entry(2, "open", "2026-11-27T10:09:55Z")],
    });
    render(<PrStatusSection session={session("lead", { title: "Lead" })} />);
    await act(async () => {});
    expect(screen.getByText("updated 5s ago")).toBeTruthy();
  });
});
