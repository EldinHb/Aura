import { describe, expect, it } from "vitest";
import { positions, validate } from "./diff";
import { comment } from "./runner";

const DIFF = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,2 +3,2 @@\n same\n-old\n+new\n";

describe("diff", () => {
  it("maps both sides", () => {
    const p = positions(DIFF).get("x")!;
    expect(p[0].has(4)).toBe(true);
    expect(p[1].has(4)).toBe(true);
    expect(p[1].has(5)).toBe(false);
  });

  it("does not relocate edited invalid positions", () => {
    const c = [comment({ path: "x", line: 5, side: "RIGHT" })];
    validate(c, DIFF, false);
    expect(c[0].valid).toBe(false);
    validate(c, DIFF, true);
    expect(c[0].line).toBe(4);
    expect(c[0].valid).toBe(true);
  });

  it("finds a file by a unique suffix and refuses ambiguous ones", () => {
    const two = "diff --git a/a/x b/a/x\n--- a/a/x\n+++ b/a/x\n@@ -1 +1 @@\n-1\n+2\ndiff --git a/b/x b/b/x\n--- a/b/x\n+++ b/b/x\n@@ -1 +1 @@\n-1\n+2\n";
    const c = [comment({ path: "./x", line: 1, side: "RIGHT" }), comment({ path: "a/x", line: 1, side: "RIGHT" })];
    validate(c, two, false);
    expect(c[0].valid).toBe(false);
    expect(c[0].position_note).toContain("No unambiguous file");
    expect(c[1].valid).toBe(true);
  });

  it("checks every line of a range", () => {
    const c = [comment({ path: "x", line: 4, start_line: 3, side: "RIGHT" }), comment({ path: "x", line: 4, start_line: 4, side: "RIGHT" })];
    validate(c, DIFF, false);
    expect(c[0].valid).toBe(true);
    expect(c[1].valid).toBe(false);
  });
});
