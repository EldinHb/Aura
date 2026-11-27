import { describe, expect, it } from "vitest";
import type { PrEntry } from "../shared/types";
import { reviewSummary } from "./labels";
import { splitPulls } from "./order";

const pr = (number: number, state: string, ready: boolean, updatedAt: string): PrEntry => ({
  ref: { url: `https://github.com/acme/api/pull/${number}`, repo: "acme/api", number, sources: [] },
  status: { number, state, updatedAt, readiness: state === "open" || state === "draft" ? { ready, reasons: [] } : null } as unknown as PrEntry["status"],
  readAt: null,
  error: null,
});

describe("splitPulls (QA: a stable order)", () => {
  const pulls = [
    pr(1, "open", true, "2026-11-27T08:00:00Z"),
    pr(2, "open", false, "2026-11-27T07:00:00Z"),
    pr(3, "draft", false, "2026-11-27T09:00:00Z"),
    pr(4, "open", false, "2026-11-27T09:00:00Z"),
    pr(5, "merged", false, "2026-11-27T06:00:00Z"),
    pr(6, "open", true, "2026-11-27T08:00:00Z"),
    pr(7, "closed", false, "2026-11-27T09:30:00Z"),
  ];

  it("orders by readiness group, then most recently updated, then number, whatever the input order", () => {
    const order = (list: PrEntry[]) => {
      const { active, done } = splitPulls(list);
      return [active.map((e) => e.ref.number), done.map((e) => e.ref.number)];
    };
    const expected = [[4, 2, 6, 1, 3], [7, 5]];
    expect(order(pulls)).toEqual(expected);
    expect(order([...pulls].reverse())).toEqual(expected);
    expect(order([pulls[3], pulls[0], pulls[6], pulls[1], pulls[5], pulls[2], pulls[4]])).toEqual(expected);
  });
});

describe("reviewSummary (QA: the merge box agrees with GitHub's decision)", () => {
  const person = (name: string, state: string, previous: string | null = null) => ({ name, kind: "user" as const, state: state as never, previous: previous as never });
  const summary = (decision: string, reviewed: ReturnType<typeof person>[], pending: ReturnType<typeof person>[]) =>
    reviewSummary({ reviewers: { reviewed, pending, complete: true }, merge: { reviewDecision: decision } as never });

  it("says changes are requested when GitHub decided so, naming a re-requested reviewer (cli#13899)", () => {
    expect(summary("CHANGES_REQUESTED", [], [person("BagToad", "PENDING", "CHANGES_REQUESTED")])).toEqual({ tone: "err", text: "Changes requested by BagToad" });
    expect(summary("CHANGES_REQUESTED", [], [])).toEqual({ tone: "err", text: "Changes requested" });
  });

  it("follows GitHub's decision over what single reviews say", () => {
    expect(summary("APPROVED", [person("alice", "APPROVED"), person("bob", "COMMENTED")], [])).toEqual({ tone: "ok", text: "Approved by alice" });
    expect(summary("REVIEW_REQUIRED", [person("alice", "APPROVED")], [person("bob", "PENDING")])).toEqual({ tone: "warn", text: "Review required · approved by alice" });
    expect(summary("REVIEW_REQUIRED", [], [])).toEqual({ tone: "warn", text: "Review required" });
  });

  it("without a required review, reports what reviewers said", () => {
    expect(summary("", [person("alice", "CHANGES_REQUESTED")], [])).toEqual({ tone: "err", text: "Changes requested by alice" });
    expect(summary("", [], [person("alice", "PENDING", "APPROVED")])).toEqual({ tone: "ok", text: "Approved by alice" });
    expect(summary("", [person("carol", "COMMENTED")], [])).toEqual({ tone: "", text: "Reviewed" });
    expect(summary("", [], [person("dave", "PENDING")])).toEqual({ tone: "", text: "No reviews yet" });
  });
});
