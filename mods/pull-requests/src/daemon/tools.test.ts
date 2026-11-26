import { describe, expect, it } from "vitest";
import type { PreReview, PullRequest, ReviewInbox } from "@aura/github-client";
import { pullArg, severity, side, verdict } from "./orchestrated";
import { comment } from "./runner";
import { NAMES, describeInbox, describeReview, request, tools } from "./tools";

function review(): PreReview {
  return {
    id: "r1",
    pull: { id: "wortell/vidara.portal#2730", title: "Signals", head_sha: "b".repeat(40) } as PullRequest,
    config: { provider: "", model: null, effort: null, prompt_mode: "", prompt: "" },
    instructions: "",
    status: "ready",
    phase: "done",
    error: null,
    created_at: "",
    updated_at: "",
    revision: 3,
    reviewed_sha: "a".repeat(40),
    merge_base: "",
    context_mode: "recorded",
    context_note: null,
    diff: "diff --git a/x b/x\n",
    log_tail: [],
    result: {
      summary: "Fine.",
      verdict: "approve",
      risk: "low",
      confidence: 0.9,
      comments: [
        comment({ id: "c1", path: "Tests.cs", line: 56, side: "RIGHT", severity: "nit", body: "Rename", valid: true }),
        comment({
          id: "c2",
          path: "Other.cs",
          line: 2,
          start_line: 1,
          side: "LEFT",
          severity: "minor",
          body: "Mine",
          user_authored: true,
          deleted: true,
          position_note: "Outside the reviewed diff; included in the review body.",
        }),
      ],
    },
    submitted_url: null,
    submission: null,
    agent: { provider: "Codex", model: "gpt-5.5", model_id: null, effort: "high" },
    source: { orchestrator: "o1", orchestrator_title: "Lead", worker: "w1", worker_title: "Review 2730" },
  };
}

describe("orchestrator tools", () => {
  it("call their own method for this orchestrator with their arguments", () => {
    const all = tools();
    expect(all.map((t) => t.name)).toEqual([...NAMES]);
    const methods = new Set<string>();
    for (const name of NAMES) {
      const [method, p] = request(name, "o1", { pull: "o/r#1", orchestrator: "someone else" })!;
      expect(method.startsWith("orchestrator.reviews.")).toBe(true);
      expect(p).toEqual({ pull: "o/r#1", orchestrator: "o1" });
      methods.add(method);
    }
    expect(methods.size).toBe(NAMES.length);
    expect(request("submit_review", "o1", {})).toBeNull();
    for (const t of all) {
      expect(t.description.toLowerCase()).not.toContain("submits");
      const schema = t.inputSchema as any;
      for (const key of schema.required ?? []) expect(schema.properties).toHaveProperty(key);
      expect(t.name).toMatch(/^[a-z0-9_]+$/);
    }
  });

  it("read a review with its ids, state and who did it", () => {
    const text = describeReview(review(), true);
    for (const want of [
      'Pre-review `r1` of wortell/vidara.portal#2730 "Signals" at revision 3: ready (ready for the user',
      "Signed: Codex · model gpt-5.5 · effort high",
      "Recorded by the orchestrator Lead (`o1`), from the review by its worker Review 2730 (`w1`)",
      "Reviewed commit: aaaaaaaaaa (the PR was at bbbbbbbbbb when Aura last read it)",
      "Verdict: approve · risk low · confidence 90%",
      "- `c1` Tests.cs:56 RIGHT [nit]: Rename",
      "- `c2` Other.cs:1-2 LEFT [minor, the user's, deleted]: Mine",
      "  Outside the reviewed diff",
      "```diff\ndiff --git a/x b/x",
      "Posting it to GitHub is the user's",
    ]) {
      expect(text).toContain(want);
    }
    expect(describeReview(review(), false)).not.toContain("```diff");
  });

  it("read the inbox as the user's list with each PR's latest pre-review", () => {
    const pull = (n: number, hidden: boolean) =>
      ({ id: `o/r#${n}`, title: `PR ${n}`, author: "bob", state: "open", checks: "SUCCESS", hidden, draft: false, review_decision: "", my_review: null }) as unknown as PullRequest;
    const r = review();
    r.pull = pull(1, false);
    const elsewhere = review();
    elsewhere.id = "r2";
    const inbox = {
      account: "github.com:alice",
      pulls: [pull(1, false), pull(2, true)],
      mine: [],
      reviewed: [],
      reviews: [r, elsewhere],
      last_synced: null,
      error: null,
      blocked: null,
    } as unknown as ReviewInbox;
    const text = describeInbox(inbox, false);
    expect(text).toContain("Needs the user's review (1):\n- o/r#1 \"PR 1\" (by bob, checks success) · pre-review `r1` ready");
    expect(text).not.toContain("o/r#2");
    expect(text).toContain("Pre-reviews of PRs not on these lists:\n- `r2` ready of wortell/vidara.portal#2730");
    expect(describeInbox(inbox, true)).toContain('o/r#2 "PR 2" (by bob, checks success, hidden)');
    expect(describeInbox({ ...inbox, account: null }, false)).toContain("gh auth login");
  });

  it("name a pull like GitHub does", () => {
    for (const given of [
      { pull: "wortell/vidara.portal#2730" },
      { pull: "https://github.com/wortell/vidara.portal/pull/2730/files" },
      { repo: "wortell/vidara.portal", number: 2730 },
    ]) {
      expect(pullArg(given)).toEqual(["wortell/vidara.portal", 2730]);
    }
    for (const wrong of [{ pull: "vidara.portal#2730" }, { pull: "o/r#x" }, {}]) expect(() => pullArg(wrong)).toThrow();
  });

  it("read verdicts and sides as GitHub and the editor spell them", () => {
    expect(verdict("APPROVE")).toBe("approve");
    expect(verdict("changes requested")).toBe("request_changes");
    expect(() => verdict("lgtm")).toThrow();
    expect(side(null)).toBe("RIGHT");
    expect(side("left")).toBe("LEFT");
    expect(severity("Nit")).toBe("nit");
    expect(() => severity("style")).toThrow();
  });
});
