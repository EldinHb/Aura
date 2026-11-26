import { describe, expect, it } from "vitest";
import { createTestHost } from "@aura/mod-sdk/testing";
import type { PreReview } from "@aura/github-client";
import { AgentRunner, DEFAULT_PROMPT, instructions, parseResult, prompt, schema, validateResult } from "./runner";

const config = { provider: "codex", model: null, effort: null, prompt_mode: "default", prompt: "" };

describe("runner", () => {
  it("keeps explicit instructions when replacing", () => {
    expect(instructions({ ...config, prompt_mode: "replace", prompt: "Focus on migrations" })).toBe("Focus on migrations");
    expect(instructions({ ...config, prompt_mode: "append", prompt: "Also docs" })).toBe(`${DEFAULT_PROMPT}\n\nAlso docs`);
    expect(() => instructions({ ...config, prompt_mode: "replace", prompt: "  " })).toThrow("Invalid prompt mode");
  });

  it("fails invalid output", () => {
    expect(() => validateResult(parseResult({}))).toThrow("invalid review metadata");
    expect(() =>
      validateResult(parseResult({ summary: "", verdict: "comment", risk: "low", confidence: null, comments: [{ path: "a", line: 1, side: "UP", body: "x", severity: "nit" }] })),
    ).toThrow("invalid finding");
  });

  it("asks the agent read-only, with the schema, and keeps the model that ran", async () => {
    const host = createTestHost({ id: "pull-requests" });
    host.state.agent = async (o) => {
      o.onProgress?.("x".repeat(500));
      return {
        output: { summary: "S", verdict: "approve", risk: "low", confidence: 0.5, comments: [{ path: "a.rs", line: 2, start_line: null, side: "RIGHT", body: "B", severity: "nit", rationale: null }] },
        text: "",
        modelId: "claude-opus-5-5",
      };
    };
    const review = {
      instructions: "Review",
      config: { ...config, provider: "claude", model: "opus", effort: "high" },
      pull: { id: "o/r#1" },
      context_mode: "worktree",
      context_note: null,
      diff: "diff",
    } as unknown as PreReview;
    const lines: string[] = [];
    const out = await new AgentRunner(host.api).run(review, "/w", (l) => lines.push(l));
    expect(out.model_id).toBe("claude-opus-5-5");
    expect(out.result.comments[0]).toMatchObject({ path: "a.rs", line: 2, valid: false, user_authored: false });
    expect(lines[0].length).toBe(300);
    const run = host.record.agentRuns[0];
    expect(run).toMatchObject({ provider: "claude", model: "opus", effort: "high", cwd: "/w", access: "read-only", jsonSchema: schema() });
    expect(run.prompt).toBe(prompt(review));
    expect(run.prompt).toContain("Return ONLY JSON matching this schema");
  });
});
