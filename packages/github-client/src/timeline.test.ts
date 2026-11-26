import { expect, it } from "vitest";
import { emptyPull } from "./pulls";
import { legacyLists, timeline, timelineItem, timelineThread } from "./timeline";
import { fakeGithub } from "./testing/fake";
import type { PullTimeline, TimelineItem } from "./types";

/** Answers each query with the next page and records the variables it was sent. */
function paged(answers: unknown[]) {
  const sent: any[] = [];
  const gh = fakeGithub((_method, path, body) => {
    expect(path).toBe("graphql");
    sent.push(body.variables);
    return answers.shift();
  });
  return { gh, sent };
}
const pr = () => emptyPull({ repo: "o/r", number: 7 });
type Conn = [unknown[], string | null];
function page(items: Conn | null, threads: Conn | null) {
  const conn = ([nodes, next]: Conn) => ({ pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes });
  const p: Record<string, unknown> = { commits: { totalCount: 3 } };
  if (items) p.timelineItems = conn(items);
  if (threads) p.reviewThreads = conn(threads);
  return { data: { repository: { pullRequest: p } } };
}

it("pages each connection on its own cursor", async () => {
  const comment = (id: string) => ({ __typename: "IssueComment", id, body: "hi", createdAt: "2026-10-01T10:00:00Z", url: "u", author: { login: "ann" } });
  const { gh, sent } = paged([
    page([[comment("c1")], "i1"], [[{ id: "t1", comments: { totalCount: 0, nodes: [] } }], null]),
    page([[comment("c2")], null], null),
  ]);
  const t = await timeline(gh, pr());
  expect(t.items.map((i) => i.id)).toEqual(["c1", "c2"]);
  expect(t.threads.length).toBe(1);
  expect(t.commits).toBe(3);
  expect(sent[1].items).toBe("i1");
  // The threads were complete.
  expect([sent[1].withItems, sent[1].withThreads]).toEqual([true, false]);
});

it("fails the read on errors", async () => {
  const { gh } = paged([{ errors: [{ message: "nope" }] }]);
  await expect(timeline(gh, pr())).rejects.toThrow();
});

it("reads reviews, events and threads", () => {
  const review = timelineItem({ __typename: "PullRequestReview", id: "R1", databaseId: 42, body: "", state: "CHANGES_REQUESTED", createdAt: "2026-10-01T09:00:00Z", submittedAt: "2026-10-01T09:05:00Z", url: "u", author: null })!;
  expect([review.kind, review.at, review.actor, review.review_id]).toEqual(["review", "2026-10-01T09:05:00Z", "ghost", 42]);
  const commit = timelineItem({ __typename: "PullRequestCommit", id: "C", url: "u", commit: { oid: "abc", messageHeadline: "Fix it", committedDate: "2026-10-01T08:00:00Z", author: { name: "Ann", user: null } } })!;
  expect([commit.actor, commit.subject, commit.sha]).toEqual(["Ann", "Fix it", "abc"]);
  const team = timelineItem({ __typename: "ReviewRequestedEvent", id: "E", createdAt: "x", actor: { login: "ann" }, requestedReviewer: { combinedSlug: "o/core" } })!;
  expect(team.subject).toBe("o/core");
  const hidden = { __typename: "CrossReferencedEvent", id: "X", createdAt: "x", actor: { login: "ann" }, source: {} };
  // A reference the token cannot see is left out.
  expect(timelineItem(hidden)).toBeNull();
  expect(timelineItem({ __typename: "SomethingNew" })).toBeNull();
  const ref = timelineItem({ __typename: "CrossReferencedEvent", id: "X", createdAt: "x", actor: { login: "ann" }, source: { number: 5, title: "Bug", url: "v", repository: { nameWithOwner: "o/r" } } })!;
  expect([ref.subject, ref.url]).toEqual(["o/r#5 Bug", "v"]);

  const th = timelineThread({
    id: "T", isResolved: true, isOutdated: false, path: "a.rs", line: 9, originalLine: 8, resolvedBy: { login: "bob" },
    comments: { totalCount: 3, nodes: [
      { id: "c1", body: "first", createdAt: "t1", url: "u1", diffHunk: "@@ -1 +1 @@", author: { login: "ann" }, pullRequestReview: { databaseId: 42 } },
      { id: "c2", body: "reply", createdAt: "t2", url: "u2", diffHunk: "@@ -1 +1 @@", author: { login: "bob" }, pullRequestReview: { databaseId: 43 } },
    ] },
  });
  expect([th.review_id, th.line, th.resolved, th.more, th.diff_hunk]).toEqual([42, 9, true, 1, "@@ -1 +1 @@"]);
});

it("keeps the REST shape in the legacy lists", () => {
  const item = (patch: Partial<TimelineItem>): TimelineItem => ({ kind: "", id: "", at: "", actor: "", body: "", url: "", state: "", review_id: null, subject: "", previous: "", color: "", sha: "", before: "", ...patch });
  const comment = { id: "t", author: "ann", at: "", body: "", url: "" };
  const t: PullTimeline = {
    items: [item({ kind: "comment", id: "c", body: "hi", actor: "ann" }), item({ kind: "review", id: "r", state: "APPROVED", actor: "bob" }), item({ kind: "labeled" })],
    threads: [{ id: "", path: "a.rs", line: null, original_line: null, resolved: false, outdated: false, resolved_by: "", diff_hunk: "", review_id: null, comments: [comment, comment], more: 0 }],
    commits: 1,
  };
  const [comments, reviews, threads] = legacyLists(t);
  expect(comments).toEqual([{ id: "c", body: "hi", html_url: "", created_at: "", user: { login: "ann" } }]);
  expect(reviews[0].state).toBe("APPROVED");
  expect(threads.length).toBe(2);
  expect([threads[0].path, threads[0].line]).toEqual(["a.rs", null]);
});
