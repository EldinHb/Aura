import { describe, expect, it } from "vitest";
import type { PrEntry } from "../shared/types";
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
