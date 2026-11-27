import { describe, expect, it } from "vitest";
import type { Github } from "@aura/github-client";
import { fakeGithub, prNode } from "../test/fixtures";
import { PAGE_QUERY, pageCheck, pageFile, readFiles, readPage, SNAPSHOT_TRIES, snippet, timelineItem, toPage } from "./page";

const actor = (login: string) => ({ login });

describe("timelineItem", () => {
  it("maps comments, reviews with their line comments, and events", () => {
    expect(timelineItem({ __typename: "IssueComment", author: actor("alice"), body: "Looks good", createdAt: "2026-11-27T08:00:00Z", url: "u1" }))
      .toEqual({ kind: "comment", author: "alice", body: "Looks good", at: "2026-11-27T08:00:00Z", url: "u1" });
    const review = timelineItem({
      __typename: "PullRequestReview", author: actor("bob"), state: "CHANGES_REQUESTED", body: "A few things", submittedAt: "t", url: "u2",
      comments: { nodes: [{ author: actor("bob"), body: "Off by one", createdAt: "t", url: "u3", path: "src/limit.ts", line: 12, originalLine: 10,
        diffHunk: "@@ -1,5 +1,6 @@\n a\n b\n-c\n+d\n e" }] },
    });
    expect(review).toEqual({ kind: "review", state: "CHANGES_REQUESTED", author: "bob", body: "A few things", at: "t", url: "u2",
      comments: [{ author: "bob", body: "Off by one", at: "t", url: "u3", path: "src/limit.ts", line: 12, snippet: [" b", "-c", "+d", " e"] }], moreComments: 0 });
    expect(timelineItem({ __typename: "PullRequestCommit", commit: { abbreviatedOid: "abc1234", messageHeadline: "Add limiter", committedDate: "t", url: "u", author: { name: "Sam", user: null } } }))
      .toEqual({ kind: "commit", at: "t", author: "Sam", sha: "abc1234", message: "Add limiter", url: "u" });
    expect(timelineItem({ __typename: "HeadRefForcePushedEvent", actor: actor("sam"), createdAt: "t", beforeCommit: { abbreviatedOid: "1111111" }, afterCommit: { abbreviatedOid: "2222222" } }))
      .toEqual({ kind: "force_push", at: "t", actor: "sam", before: "1111111", after: "2222222" });
    expect(timelineItem({ __typename: "ReviewRequestedEvent", actor: actor("sam"), createdAt: "t", requestedReviewer: { __typename: "Team", combinedSlug: "acme/core" } }))
      .toMatchObject({ kind: "review_requested", reviewer: "acme/core" });
    expect(timelineItem({ __typename: "LabeledEvent", actor: actor("sam"), createdAt: "t", label: { name: "bug", color: "d73a4a" } }))
      .toEqual({ kind: "labeled", at: "t", actor: "sam", label: { name: "bug", color: "d73a4a" } });
    expect(timelineItem({ __typename: "UnlabeledEvent", actor: null, createdAt: "t", label: { name: "x", color: "nonsense" } }))
      .toEqual({ kind: "unlabeled", at: "t", actor: "ghost", label: { name: "x", color: "888888" } });
    expect(timelineItem({ __typename: "MergedEvent", actor: actor("sam"), createdAt: "t", commit: { abbreviatedOid: "3333333" }, mergeRefName: "main" }))
      .toEqual({ kind: "merged", at: "t", actor: "sam", sha: "3333333", base: "main" });
    for (const [typename, kind] of [["ClosedEvent", "closed"], ["ReopenedEvent", "reopened"], ["ReadyForReviewEvent", "ready_for_review"], ["ConvertToDraftEvent", "converted_to_draft"]]) {
      expect(timelineItem({ __typename: typename, actor: actor("sam"), createdAt: "t" })).toEqual({ kind, at: "t", actor: "sam" });
    }
  });

  it("leaves out pending reviews, empty replies and what the page does not show", () => {
    expect(timelineItem({ __typename: "PullRequestReview", state: "PENDING", author: actor("me"), comments: { nodes: [] } })).toBeNull();
    expect(timelineItem({ __typename: "PullRequestReview", state: "COMMENTED", body: "", author: actor("me"), comments: { nodes: [] } })).toBeNull();
    expect(timelineItem({ __typename: "SubscribedEvent" })).toBeNull();
  });

  it("keeps the last lines of a hunk as the snippet", () => {
    expect(snippet("@@ -1 +1 @@\n1\n2\n3\n4\n5\n6", 3)).toEqual(["4", "5", "6"]);
  });
});

describe("pageCheck and pageFile", () => {
  it("maps checks with durations, words and links", () => {
    expect(pageCheck({ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "TIMED_OUT", startedAt: "2026-11-27T08:00:00Z", completedAt: "2026-11-27T08:04:30Z", detailsUrl: "d", checkSuite: { workflowRun: { workflow: { name: "CI" } } } }))
      .toEqual({ name: "build", workflow: "CI", state: "failing", label: "Timed out", seconds: 270, url: "d" });
    expect(pageCheck({ __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-11-27T08:00:00Z", completedAt: null, detailsUrl: null }))
      .toMatchObject({ state: "pending", label: "In progress", seconds: null, url: null });
    expect(pageCheck({ __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED" })).toMatchObject({ state: "skipped", label: "Skipped" });
    expect(pageCheck({ __typename: "StatusContext", context: "ci/legacy", state: "ERROR", targetUrl: "t" })).toEqual({ name: "ci/legacy", workflow: "", state: "failing", label: "Error", seconds: null, url: "t" });
  });

  it("maps changed files, renames and missing patches", () => {
    expect(pageFile({ filename: "b.ts", previous_filename: "a.ts", status: "renamed", additions: 1, deletions: 2, patch: "@@ -1 +1 @@\n-a\n+b" }))
      .toEqual({ path: "b.ts", previous: "a.ts", status: "renamed", additions: 1, deletions: 2, patch: "@@ -1 +1 @@\n-a\n+b" });
    expect(pageFile({ filename: "logo.png", status: "added", additions: 0, deletions: 0 })).toMatchObject({ patch: null, previous: null });
  });
});

/** The answer to PAGE_QUERY, with its lists. */
function pagePr(over: Record<string, unknown> = {}) {
  return {
    number: 7, title: "Add limits", url: "https://github.com/acme/api/pull/7", body: "Adds **limits**.", createdAt: "2026-11-26T08:00:00Z",
    author: actor("sam"), baseRefName: "main", headRefName: "feature/limits", baseRefOid: "0".repeat(40), headRefOid: "f".repeat(40), headRepository: { nameWithOwner: "acme/api" },
    additions: 120, deletions: 8, changedFiles: 3, assignees: { nodes: [actor("sam")] }, labels: { nodes: [{ name: "feature", color: "a2eeef" }] },
    milestone: { title: "v2", url: "m" }, comments: { totalCount: 2 },
    commits: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [{ commit: { oid: "f".repeat(40), abbreviatedOid: "fffffff", messageHeadline: "Add limiter", committedDate: "t", url: "c", author: { name: "Sam", user: actor("sam") } } }] },
    checks: { nodes: [{ commit: { oid: "f".repeat(40), statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [
      { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" },
    ] } } } }] },
    timelineItems: { pageInfo: { hasNextPage: true, endCursor: "t1" }, nodes: [
      { __typename: "IssueComment", author: actor("alice"), body: "First", createdAt: "t", url: "u" },
    ] },
    ...over,
  };
}

describe("readPage", () => {
  it("reads the page in one query plus the pages left, and the cards' status", async () => {
    const fake = fakeGithub({ 7: prNode({ number: 7, reviewDecision: "APPROVED" }) });
    const status = fake.gh.request.bind(fake.gh);
    const asked: string[] = [];
    const gh: Github = {
      ...fake.gh,
      account: async () => "github.com:sam",
      request: async (method, path, body: any) => {
        if (body?.query === PAGE_QUERY) {
          asked.push("page");
          expect(body.variables).toEqual({ owner: "acme", name: "api", number: 7 });
          return { data: { repository: { pullRequest: pagePr() } } };
        }
        if (body?.variables?.after === "t1") {
          asked.push("timeline page 2");
          return { data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasNextPage: false }, nodes: [
            { __typename: "PullRequestReview", author: actor("bob"), state: "APPROVED", body: "", submittedAt: "t", url: "r", comments: { nodes: [
              { author: actor("bob"), body: "nit", createdAt: "t", url: "rc", path: "a.ts", line: 3, diffHunk: "@@ -1 +1 @@\n+x" },
            ] } },
          ] } } } } };
        }
        asked.push("status");
        return status(method, path, body);
      },
    };
    const page = await readPage(gh, "acme/api", 7);
    expect(asked).toEqual(["page", "timeline page 2", "status"]);
    expect(page.timeline.map((t) => t.kind)).toEqual(["comment", "review"]);
    expect(page).toMatchObject({
      title: "Add limits", base: "main", head: "feature/limits", headRepo: "acme/api", commitCount: 1, changedFiles: 3, commentCount: 3,
      assignees: ["sam"], labels: [{ name: "feature", color: "a2eeef" }], milestone: { title: "v2", url: "m" }, complete: true, nextMs: 60_000,
      status: { state: "open", merge: { reviewDecision: "APPROVED", account: "github.com:sam" } },
    });
    // Failing checks first.
    expect(page.checks.map((c) => [c.name, c.state])).toEqual([["test", "failing"], ["lint", "passing"]]);
  });

  it("marks the page incomplete when a page cannot be read", () => {
    const page = toPage("acme/api", pagePr(), {} as never, false, "now", 60_000);
    expect(page.complete).toBe(false);
  });
});

describe("one snapshot (review 5, items 1 and 5)", () => {
  /** A transport where the page query shows head `pageHeads[i]` on its i-th read and the status read whatever `node` has. */
  function snapshot(pageHeads: string[], statusHead: string) {
    const node = prNode({ number: 7, reviewDecision: "APPROVED" });
    node.headRefOid = statusHead;
    const fake = fakeGithub({ 7: node });
    const status = fake.gh.request.bind(fake.gh);
    let reads = 0;
    const gh: Github = {
      ...fake.gh,
      account: async () => "github.com:sam",
      request: async (method, path, body: any) => {
        if (body?.query === PAGE_QUERY) {
          const head = pageHeads[Math.min(reads++, pageHeads.length - 1)];
          return { data: { repository: { pullRequest: pagePr({ headRefOid: head, timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] } }) } } };
        }
        return status(method, path, body);
      },
    };
    return { gh, reads: () => reads };
  }

  it("reads again when a push lands between the page and the status, and shows one head", async () => {
    const t = snapshot(["a".repeat(40), "b".repeat(40)], "b".repeat(40));
    const page = await readPage(t.gh, "acme/api", 7);
    expect(t.reads()).toBe(2);
    expect(page.headSha).toBe("b".repeat(40));
    expect(page.status.merge.headSha).toBe("b".repeat(40));
  });

  it("fails rather than offer a merge of a head the page does not show", async () => {
    const t = snapshot(["a".repeat(40)], "b".repeat(40));
    await expect(readPage(t.gh, "acme/api", 7)).rejects.toThrow(/changed while it was read/);
    expect(t.reads()).toBe(SNAPSHOT_TRIES);
  });

  it("says how many line comments of a review were not read, and marks the page incomplete", () => {
    const review = timelineItem({ __typename: "PullRequestReview", author: actor("bob"), state: "COMMENTED", body: "Many notes", submittedAt: "t", url: "r",
      comments: { totalCount: 73, nodes: Array.from({ length: 50 }, () => ({ author: actor("bob"), body: "x", path: "a.ts", line: 1, diffHunk: "@@\n+x" })) } });
    expect(review).toMatchObject({ kind: "review", moreComments: 23 });
    const page = toPage("acme/api", pagePr({ timelineItems: { pageInfo: { hasNextPage: false }, nodes: [{ __typename: "PullRequestReview", author: actor("bob"), state: "COMMENTED", body: "b", submittedAt: "t", url: "r",
      comments: { totalCount: 51, nodes: [{ author: actor("bob"), body: "x", path: "a.ts", line: 1, diffHunk: "" }] } }] } }), {} as never, true, "now", 60_000);
    expect(page.complete).toBe(false);
  });
});

describe("readFiles", () => {
  it("reads every page of the changed files", async () => {
    const paths: string[] = [];
    const gh = { request: async (method: string, path: string) => {
      paths.push(`${method} ${path}`);
      const page = Number(/&page=(\d+)/.exec(path)![1]);
      return page === 1 ? Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, status: "modified", additions: 1, deletions: 0, patch: "@@" })) : [{ filename: "last.ts", status: "added", additions: 3, deletions: 0 }];
    } } as unknown as Github;
    const files = await readFiles(gh, "acme/api", 7);
    expect(paths).toEqual(["GET repos/acme/api/pulls/7/files?per_page=100&page=1", "GET repos/acme/api/pulls/7/files?per_page=100&page=2"]);
    expect(files).toHaveLength(101);
    expect(files[100]).toEqual({ path: "last.ts", previous: null, status: "added", additions: 3, deletions: 0, patch: null });
  });
});

