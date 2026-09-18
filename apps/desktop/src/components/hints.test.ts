import { describe, it, expect } from "vitest";
import { generateLabels, filterLabels } from "./hints";

describe("generateLabels", () => {
  it("uses single letters when they suffice", () => {
    expect(generateLabels(3)).toEqual(["a", "s", "d"]);
    expect(generateLabels(9).length).toBe(9);
  });
  it("switches to uniform two-letter labels beyond the alphabet and stays prefix-free", () => {
    const labels = generateLabels(20);
    expect(labels.length).toBe(20);
    expect(labels.every((l) => l.length === 2)).toBe(true);
    expect(new Set(labels).size).toBe(20);
    for (const a of labels) for (const b of labels) if (a !== b) expect(b.startsWith(a)).toBe(false);
  });
  it("handles zero and large counts", () => {
    expect(generateLabels(0)).toEqual([]);
    expect(generateLabels(100).every((l) => l.length === 3)).toBe(true);
  });
});

describe("filterLabels", () => {
  it("filters by typed prefix", () => {
    expect(filterLabels(["as", "ad", "sa"], "a")).toEqual(["as", "ad"]);
    expect(filterLabels(["as", "ad", "sa"], "")).toHaveLength(3);
  });
});
