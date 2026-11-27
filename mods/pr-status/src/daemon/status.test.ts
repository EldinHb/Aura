import { describe, expect, it } from "vitest";
import { checksRollup, MAX_PAGES, mergeReadiness, readStatuses, reviewerGroups, toStatus } from "./status";
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

describe("reviewerGroups: dismissed reviews (review item 7)", () => {
  it("keeps a reviewer whose latest review was dismissed, as Dismissed, not as a verdict", () => {
    const groups = reviewerGroups(prNode({ reviews: [["alice", "DISMISSED"], ["bob", "APPROVED"]], opinions: [["alice", "DISMISSED"], ["bob", "APPROVED"]] }));
    expect(groups.reviewed.map((r) => [r.name, r.state])).toEqual([["bob", "APPROVED"], ["alice", "DISMISSED"]]);
  });

  it("keeps a dismissed review as the previous one of a re-requested reviewer", () => {
    const groups = reviewerGroups(prNode({ requested: [["User", "alice"]], reviews: [["alice", "DISMISSED"]] }));
    expect(groups.pending).toEqual([{ name: "alice", kind: "user", state: "PENDING", previous: "DISMISSED" }]);
  });
});

describe("reviewerGroups: a re-requested reviewer's verdict (cli#13899)", () => {
  it("keeps a change request GitHub only lists in latestOpinionatedReviews", () => {
    // As GitHub answers for cli#13899: BagToad re-requested, his change request gone from latestReviews.
    const node = prNode({ reviewDecision: "CHANGES_REQUESTED", requested: [["User", "BagToad"]], reviews: [["copilot-pull-request-reviewer", "COMMENTED", "Bot"]], opinions: [["BagToad", "CHANGES_REQUESTED"]] });
    const groups = reviewerGroups(node);
    expect(groups.pending).toEqual([{ name: "BagToad", kind: "user", state: "PENDING", previous: "CHANGES_REQUESTED" }]);
    expect(groups.reviewed.map((r) => r.name)).toEqual(["copilot-pull-request-reviewer"]);
    // Not re-requested: shown with the verdict.
    const plain = reviewerGroups(prNode({ opinions: [["carol", "APPROVED"]] }));
    expect(plain.reviewed).toEqual([{ name: "carol", kind: "user", state: "APPROVED", previous: null }]);
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
    expect(checksRollup(null)).toEqual({ state: "none", passing: 0, failing: 0, pending: 0, total: 0, open: [], complete: true });
    expect(checksRollup({ state: "FAILURE", contexts: { totalCount: 150, nodes: [] } })).toMatchObject({ state: "failing", total: 150 });
  });
});

describe("checks past the first page (review item 1)", () => {
  const passing = Array.from({ length: 100 }, (_, i) => run(`job-${String(i).padStart(3, "0")}`));

  it("takes GitHub's rollup when a page is only partly read", () => {
    const rollup = prNode({ checks: passing, checksTotal: 140, rollup: "FAILURE" }).commits.nodes[0].commit.statusCheckRollup!;
    expect(checksRollup(rollup)).toMatchObject({ state: "failing", passing: 100, failing: 0, total: 140, complete: false });
    expect(checksRollup({ ...rollup, contexts: { ...rollup.contexts, pageInfo: { hasNextPage: true } } })).toMatchObject({ state: "failing", complete: false });
  });

  it("reads the remaining pages of the head commit's checks", async () => {
    const { gh, state, pages } = fakeGithub({ 1: prNode({ number: 1, checks: passing, checksTotal: 101, morePages: ["checks"] }) });
    state.page = (query, variables) => {
      expect(query).toContain("object(oid:$oid)");
      expect(variables).toMatchObject({ owner: "acme", name: "api", oid: "head", after: "checks-1" });
      return { repository: { object: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false, endCursor: "x" }, nodes: [run("zz-deploy", "FAILURE")] } } } } };
    };
    const [status] = await readStatuses(gh, [ref]);
    expect(pages).toHaveLength(1);
    expect(status).toMatchObject({ checks: { state: "failing", passing: 100, failing: 1, complete: true }, readiness: { ready: false, reasons: ["checks_failing"] } });
  });

  it("stops after MAX_PAGES and then trusts GitHub's rollup", async () => {
    const { gh, state, pages } = fakeGithub({ 1: prNode({ number: 1, checks: passing, checksTotal: 5000, rollup: "FAILURE", morePages: ["checks"] }) });
    state.page = () => ({ repository: { object: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: true, endCursor: "n" }, nodes: [run("more")] } } } } });
    const [status] = await readStatuses(gh, [ref]);
    expect(pages).toHaveLength(MAX_PAGES - 1);
    expect(status).toMatchObject({ checks: { state: "failing", failing: 0, complete: false }, readiness: { ready: false, reasons: ["checks_failing"] } });
  });

  it("is not ready when GitHub says UNSTABLE, whatever the checks read say", () => {
    const open = { state: "open" as const, mergeable: "MERGEABLE", reviewDecision: "APPROVED" };
    expect(mergeReadiness({ ...open, mergeStateStatus: "UNSTABLE", checks: "passing" })).toEqual({ ready: false, reasons: ["unstable"] });
    expect(mergeReadiness({ ...open, mergeStateStatus: "UNSTABLE", checks: "failing" })).toEqual({ ready: false, reasons: ["checks_failing"] });
  });
});

describe("reviewers past the first page (review item 5)", () => {
  it("reads every page of latest and opinionated reviews before grouping", async () => {
    const { gh, state } = fakeGithub({ 1: prNode({ number: 1, reviews: [["alice", "COMMENTED"]], morePages: ["reviews", "opinions"] }) });
    state.page = (query) =>
      query.includes("latestOpinionatedReviews")
        ? { repository: { pullRequest: { latestOpinionatedReviews: { pageInfo: { hasNextPage: false }, nodes: [{ state: "CHANGES_REQUESTED", author: { login: "alice" } }] } } } }
        : { repository: { pullRequest: { latestReviews: { pageInfo: { hasNextPage: false }, nodes: [{ state: "APPROVED", author: { __typename: "User", login: "zed" } }] } } } };
    const [status] = await readStatuses(gh, [ref]);
    expect(status).toMatchObject({ reviewers: { complete: true, reviewed: [{ name: "alice", state: "CHANGES_REQUESTED" }, { name: "zed", state: "APPROVED" }] } });
  });

  it("marks the reviewers incomplete when pages are left or a page fails", async () => {
    const { gh } = fakeGithub({ 1: prNode({ number: 1, reviews: [["alice", "APPROVED"]], morePages: ["reviews"] }) });
    const [status] = await readStatuses(gh, [ref]);
    expect(status).toMatchObject({ reviewers: { complete: false, reviewed: [{ name: "alice" }] } });
    expect(reviewerGroups(prNode({ morePages: ["requests"] })).complete).toBe(false);
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
