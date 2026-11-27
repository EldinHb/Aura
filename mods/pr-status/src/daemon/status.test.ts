import { describe, expect, it } from "vitest";
import { checksRollup, mergeReadiness, readStatuses, reviewerGroups, toStatus } from "./status";
import { ctxStatus, fakeGithub, prNode, run } from "../test/fixtures";

const ref = { url: "https://github.com/acme/api/pull/1", repo: "acme/api", number: 1 };

describe("reviewerGroups", () => {
  it("splits who reviewed from who is still to review", () => {
    const groups = reviewerGroups(prNode({
      requested: [["User", "bob"], ["Team", "acme/core"]],
      reviews: [["alice", "APPROVED"], ["carol", "COMMENTED"], ["dave", "CHANGES_REQUESTED"]],
    }));
    expect(groups.reviewed).toEqual([
      { name: "dave", kind: "user", state: "CHANGES_REQUESTED", previous: null },
      { name: "alice", kind: "user", state: "APPROVED", previous: null },
      { name: "carol", kind: "user", state: "COMMENTED", previous: null },
    ]);
    expect(groups.pending).toEqual([
      { name: "bob", kind: "user", state: "PENDING", previous: null },
      { name: "acme/core", kind: "team", state: "PENDING", previous: null },
    ]);
  });

  it("counts a re-requested reviewer as pending again, keeping their earlier review", () => {
    const groups = reviewerGroups(prNode({ requested: [["User", "Alice"]], reviews: [["alice", "APPROVED"]] }));
    expect(groups.reviewed).toEqual([]);
    expect(groups.pending).toEqual([{ name: "Alice", kind: "user", state: "PENDING", previous: "APPROVED" }]);
  });

  it("shows the latest verdict over a later comment, marks bots and leaves the author out", () => {
    const groups = reviewerGroups(prNode({
      author: "me",
      reviews: [["alice", "COMMENTED"], ["me", "COMMENTED"], ["copilot[bot]", "COMMENTED", "Bot"]],
      opinions: [["alice", "CHANGES_REQUESTED"]],
      requested: [["Bot", "copilot"]],
    }));
    expect(groups.reviewed.map((r) => [r.name, r.kind, r.state])).toEqual([
      ["alice", "user", "CHANGES_REQUESTED"],
      ["copilot[bot]", "bot", "COMMENTED"],
    ]);
    expect(groups.pending).toEqual([{ name: "copilot", kind: "bot", state: "PENDING", previous: null }]);
  });
});

describe("checksRollup", () => {
  it("counts check runs and statuses and lists failing then pending ones", () => {
    const checks = checksRollup(prNode({ checks: [
      run("lint"), run("test", "FAILURE"), run("e2e", null, "IN_PROGRESS"), run("docs", "SKIPPED"),
      run("deploy", "CANCELLED"), ctxStatus("ci/legacy", "PENDING"), ctxStatus("license", "SUCCESS"),
    ] }).commits.nodes[0].commit.statusCheckRollup);
    expect(checks).toMatchObject({ state: "failing", passing: 3, failing: 2, pending: 2, total: 7 });
    expect(checks.open.map((c) => [c.name, c.state, c.url])).toEqual([
      ["deploy", "failing", "https://ci.example/deploy"],
      ["test", "failing", "https://ci.example/test"],
      ["ci/legacy", "pending", null],
      ["e2e", "pending", "https://ci.example/e2e"],
    ]);
  });

  it("is pending while any check runs and nothing fails", () => {
    expect(checksRollup({ state: "PENDING", contexts: { totalCount: 2, nodes: [run("a"), ctxStatus("b", "EXPECTED")] } }).state).toBe("pending");
  });

  it("is passing when everything passed, none without checks, and falls back on GitHub's state", () => {
    expect(checksRollup({ state: "SUCCESS", contexts: { totalCount: 1, nodes: [run("a", "NEUTRAL")] } }).state).toBe("passing");
    expect(checksRollup(null)).toEqual({ state: "none", passing: 0, failing: 0, pending: 0, total: 0, open: [] });
    expect(checksRollup({ state: "FAILURE", contexts: { totalCount: 150, nodes: [] } })).toMatchObject({ state: "failing", total: 150 });
  });
});

describe("mergeReadiness", () => {
  const open = { state: "open" as const, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", checks: "passing" as const };

  it("is ready when GitHub reports a clean merge", () => {
    expect(mergeReadiness(open)).toEqual({ ready: true, reasons: [] });
    expect(mergeReadiness({ ...open, mergeStateStatus: "HAS_HOOKS", reviewDecision: "" })).toEqual({ ready: true, reasons: [] });
  });

  it("gives every reason that applies", () => {
    expect(mergeReadiness({ state: "draft", mergeable: "CONFLICTING", mergeStateStatus: "DRAFT", reviewDecision: "CHANGES_REQUESTED", checks: "failing" }))
      .toEqual({ ready: false, reasons: ["draft", "changes_requested", "checks_failing", "conflicts"] });
    expect(mergeReadiness({ ...open, mergeStateStatus: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", checks: "pending" }))
      .toEqual({ ready: false, reasons: ["review_required", "checks_pending"] });
    expect(mergeReadiness({ ...open, mergeStateStatus: "BEHIND" })).toEqual({ ready: false, reasons: ["behind"] });
    expect(mergeReadiness({ ...open, mergeable: "MERGEABLE", mergeStateStatus: "DIRTY" })).toEqual({ ready: false, reasons: ["conflicts"] });
  });

  it("blames branch protection only when nothing else explains a block", () => {
    expect(mergeReadiness({ ...open, mergeStateStatus: "BLOCKED" })).toEqual({ ready: false, reasons: ["blocked"] });
  });

  it("is not ready while GitHub computes mergeability, and has nothing to say once merged or closed", () => {
    expect(mergeReadiness({ ...open, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" })).toEqual({ ready: false, reasons: ["unknown"] });
    expect(mergeReadiness({ ...open, state: "merged" })).toBeNull();
    expect(mergeReadiness({ ...open, state: "closed" })).toBeNull();
  });
});

describe("toStatus and readStatuses", () => {
  it("maps a node", () => {
    const status = toStatus(ref, prNode({ isDraft: true, mergeStateStatus: "DRAFT", title: "WIP" }));
    expect(status).toMatchObject({ title: "WIP", state: "draft", author: "me", readiness: { ready: false, reasons: ["draft"] } });
    expect(toStatus(ref, prNode({ state: "MERGED" })).state).toBe("merged");
  });

  it("reads many PRs in one query and fails only the one GitHub cannot return", async () => {
    const { gh, queries } = fakeGithub({ 1: prNode({ number: 1 }), 2: prNode({ number: 2, title: "Two" }) });
    const out = await readStatuses(gh, [ref, { url: "https://github.com/acme/api/pull/2", repo: "acme/api", number: 2 }, { url: "https://github.com/acme/api/pull/3", repo: "acme/api", number: 3 }]);
    expect(queries).toEqual([[1, 2, 3]]);
    expect((out[1] as { title: string }).title).toBe("Two");
    expect(out[2]).toBeInstanceOf(Error);
  });

  it("fails every PR of a query that fails as a whole", async () => {
    const { gh, state } = fakeGithub();
    state.fail = new Error("offline");
    const out = await readStatuses(gh, [ref]);
    expect((out[0] as Error).message).toBe("offline");
  });
});
