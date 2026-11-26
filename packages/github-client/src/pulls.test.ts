import { describe, expect, it } from "vitest";
import { pages, validateRepo } from "./github";
import { activity, BATCH, fromGraphql, pull, pulls, refPath, requestedAt, reviewsByOthers, unansweredThreads, activityOf, mergeBlocker, emptyPull } from "./pulls";
import { fakeGithub } from "./testing/fake";

describe("pages", () => {
  const paginated = (failSecond: boolean) => {
    let count = 0;
    const gh = fakeGithub(() => {
      const page = count++;
      if (page === 1 && failSecond) throw new Error("rate limited");
      return page === 0 ? Array.from({ length: 100 }, () => ({ id: 1 })) : [{ id: 2 }];
    });
    return { gh, count: () => count };
  };

  it("reads all pages", async () => {
    const { gh, count } = paginated(false);
    expect((await pages(gh, "repos/o/r/issues/1/comments")).length).toBe(101);
    expect(count()).toBe(2);
    expect(gh.calls[0].path).toBe("repos/o/r/issues/1/comments?per_page=100&page=1");
  });

  it("does not report partial pages as complete", async () => {
    const { gh } = paginated(true);
    await expect(pages(gh, "repos/o/r/issues/1/comments")).rejects.toThrow();
  });
});

it("counts review requests addressed to you or a team", () => {
  const events = [
    { createdAt: "2026-10-01T09:00:00Z", requestedReviewer: { __typename: "User", login: "Alice" } },
    { createdAt: "2026-10-03T09:00:00Z", requestedReviewer: { __typename: "User", login: "bob" } },
    { createdAt: "2026-10-02T09:00:00Z", requestedReviewer: { __typename: "Team" } },
  ];
  expect(requestedAt(events, "alice")).toBe("2026-10-02T09:00:00Z");
  expect(requestedAt([events[1]], "alice")).toBeNull();
  expect(requestedAt(null, "alice")).toBeNull();
});

it("keeps slashes in branch paths and encodes the rest", () => {
  expect(refPath("feat/login")).toBe("feat/login");
  expect(refPath("fix/#12 a%b")).toBe("fix/%2312%20a%25b");
  expect(refPath("é")).toBe("%C3%A9");
  for (const bad of ["", "a//b", "../main", "a/./b", "/a"]) expect(() => refPath(bad), bad).toThrow();
});

it("rejects unsafe repository paths", () => {
  for (const repo of ["../repo", "owner/../repo", "owner/repo?token=x", "-owner/repo/extra"]) expect(() => validateRepo(repo)).toThrow();
  expect(() => validateRepo("owner/repo.name")).not.toThrow();
});

it("counts comment-only reviews, and an approval outranks a later comment", () => {
  const review = (login: string, kind: string, state: string) => ({ state, submittedAt: "2026-10-05T10:00:00Z", author: { __typename: kind, login }, commit: { oid: "c1" } });
  const p = {
    latestReviews: {
      nodes: [
        review("alice", "User", "COMMENTED"),
        review("bob", "User", "COMMENTED"),
        review("me", "User", "COMMENTED"),
        review("copilot-pull-request-reviewer", "Bot", "COMMENTED"),
        review("carol", "User", "PENDING"),
        review("dave", "User", "DISMISSED"),
      ],
    },
    latestOpinionatedReviews: { nodes: [{ state: "APPROVED", author: { login: "Bob" } }] },
  };
  const reviews = reviewsByOthers(p, ["Me"]);
  // The author's own replies, drafts and dismissed reviews are skipped; bots are kept and marked.
  expect(reviews.map((r) => [r.reviewer, r.state, r.commit_sha, r.bot])).toEqual([
    ["alice", "COMMENTED", "c1", false],
    ["bob", "APPROVED", "c1", false],
    ["copilot-pull-request-reviewer", "COMMENTED", "c1", true],
  ]);
  expect(reviewsByOthers({}, [])).toEqual([]);
});

/** Answers batched PR queries from `repos` (`owner/repo` -> PR numbers that exist). */
function batched(repos: Array<[string, number[]]>, fail = false) {
  const queries: string[] = [];
  const gh = fakeGithub((_method, path, body) => {
    expect(path).toBe("graphql");
    expect(body.variables).toEqual({ login: "me" });
    const query: string = body.query;
    queries.push(query);
    if (fail) return { errors: [{ message: "Something went wrong" }] };
    const data: Record<string, any> = {};
    const errors: any[] = [];
    // r0:repository(owner:"o",name:"r"){… pr0:pullRequest(number:1){...pull} …}
    const blocks = query.split(/(?=r\d+:repository\()/).slice(1);
    for (const block of blocks) {
      const [, alias, owner, name] = /^(r\d+):repository\(owner:"([^"]+)",name:"([^"]+)"\)/.exec(block)!;
      const numbers = repos.find(([r]) => r === `${owner}/${name}`)?.[1];
      if (!numbers) {
        data[alias] = null;
        errors.push({ path: [alias], message: "Could not resolve to a Repository" });
        continue;
      }
      data[alias] = { viewerPermission: "WRITE", squashMergeAllowed: true };
      for (const [, index, n] of block.matchAll(/ pr(\d+):pullRequest\(number:(\d+)\)/g)) {
        const number = Number(n);
        const key = `pr${index}`;
        if (numbers.includes(number)) {
          data[alias][key] = {
            number, title: `PR ${number}`, state: "OPEN", author: { login: "bob" }, headRefOid: "h",
            reviewThreads: { nodes: [
              { isResolved: false, comments: { nodes: [{ author: { __typename: "User", login: "alice" } }] } },
              { isResolved: false, comments: { nodes: [{ author: { __typename: "User", login: "me" } }] } },
              { isResolved: false, comments: { nodes: [{ author: { __typename: "Bot", login: "copilot" } }] } },
              { isResolved: true, comments: { nodes: [{ author: { __typename: "User", login: "alice" } }] } },
            ] },
            reviewRequests: { nodes: [
              { requestedReviewer: { __typename: "User", login: "carol" } },
              { requestedReviewer: { __typename: "Team", combinedSlug: "o/core" } },
              { requestedReviewer: { __typename: "Bot", login: "copilot" } },
            ] },
          };
        } else {
          data[alias][key] = null;
          errors.push({ path: [alias, key], message: `Could not resolve to a PullRequest with the number of ${number}.` });
        }
      }
    }
    return { data, errors };
  });
  return { gh, queries };
}

describe("pulls", () => {
  it("reads pull requests in batches of one query", async () => {
    const ids: Array<[string, number]> = Array.from({ length: 25 }, (_, i) => [(i + 1) % 2 === 0 ? "o/r" : "o/other", i + 1]);
    const all = Array.from({ length: 25 }, (_, i) => i + 1);
    const { gh, queries } = batched([["o/r", all], ["o/other", all]]);
    const read = await pulls(gh, "github.com:me", ids);
    expect(queries.length, `25 PRs take two queries of at most ${BATCH}`).toBe(2);
    const prs = read.map((p) => {
      if (p instanceof Error) throw p;
      return p;
    });
    expect(prs.map((p) => [p.repo, p.number])).toEqual(ids);
    const p = prs[1];
    expect([p.id, p.title, p.state, p.author, p.can_merge]).toEqual(["o/r#2", "PR 2", "open", "bob", true]);
    // Your own last word, a bot's remark and resolved threads wait on no one.
    expect(p.unanswered_threads).toBe(1);
    expect(p.requested.map((r) => [r.name, r.kind])).toEqual([["carol", "user"], ["o/core", "team"], ["copilot", "bot"]]);
    const first = queries[0];
    expect(first.match(/repository\(/g)?.length, "one repository block per repo").toBe(2);
    expect(first.includes("pr19:pullRequest(number:20)") && !first.includes("pr20:")).toBe(true);
    expect(Object.keys(JSON.parse(JSON.stringify(p))), "activity stays out of the JSON").not.toContain("activity");
    expect(activityOf(p)).toBeDefined();
  });

  it("does not fail a batch for one unreadable pull request", async () => {
    const { gh } = batched([["o/r", [1, 3]]]);
    const read = await pulls(gh, "github.com:me", [["o/r", 1], ["o/r", 2], ["o/gone", 7], ["o/r", 3]]);
    expect((read[0] as { number: number }).number).toBe(1);
    expect((read[1] as Error).message).toBe("Unable to read o/r#2: Could not resolve to a PullRequest with the number of 2.");
    expect((read[2] as Error).message).toBe("Unable to read o/gone#7: Could not resolve to a Repository");
    expect((read[3] as { number: number }).number).toBe(3);
    expect((await pull(gh, "github.com:me", "o/r", 3)).number).toBe(3);
    await expect(pull(gh, "github.com:me", "o/r", 2)).rejects.toThrow();
  });

  it("fails the read when GitHub rejects a query as a whole", async () => {
    const { gh } = batched([], true);
    await expect(pulls(gh, "github.com:me", [["o/r", 1]])).rejects.toThrow("Something went wrong");
    // Unsafe names never reach the query.
    await expect(pulls(gh, "github.com:me", [["o/../r", 1]])).rejects.toThrow();
  });
});

it("reads the milestone title", () => {
  const withOne = fromGraphql("a", "me", "o/r", 1, {}, { milestone: { number: 4, title: "Q4" } });
  expect([withOne.milestone, withOne.milestone_title]).toEqual([4, "Q4"]);
  const without = fromGraphql("a", "me", "o/r", 1, {}, { milestone: null });
  expect([without.milestone, without.milestone_title]).toEqual([null, ""]);
});

it("reads who pushed, commented and closed", () => {
  const user = (login: string) => ({ __typename: login.endsWith("[bot]") ? "Bot" : "User", login });
  const d = {
    state: "CLOSED",
    mergedBy: null,
    stateEvents: { nodes: [{ actor: { login: "alice" } }] },
    commits: { totalCount: 4, nodes: [{ commit: { author: { user: { login: "bob" } }, committer: { user: null } } }] },
    comments: { nodes: [{ databaseId: 7, author: user("carol") }, { databaseId: 8, author: user("ci[bot]") }, { author: user("x") }] },
    reviewThreads: { nodes: [
      { isResolved: false, comments: { nodes: [{ databaseId: 20, author: user("alice") }, { databaseId: 21, author: user("me") }] } },
      { isResolved: false, comments: { nodes: [{ databaseId: 30, author: user("me") }, { databaseId: 31, author: user("dave") }] } },
    ] },
    latestReviews: { nodes: [{ databaseId: 99, state: "COMMENTED", author: user("alice") }] },
  };
  const a = activity(d);
  expect([a.commits, a.pushed_by, a.state_actor]).toEqual([4, ["bob"], "alice"]);
  expect(a.comments).toEqual([{ id: 7, author: "carol", bot: false }, { id: 8, author: "ci[bot]", bot: true }]);
  expect(a.thread_comments.map((n) => n.id)).toEqual([20, 21, 30, 31]);
  expect(a.reviews).toEqual([{ id: 99, reviewer: "alice", bot: false, state: "COMMENTED" }]);
  // A thread's latest comment decides.
  expect(unansweredThreads(d.reviewThreads.nodes, "me")).toBe(1);
  const merged = { state: "MERGED", mergedBy: { login: "me" }, stateEvents: { nodes: [{ actor: { login: "alice" } }] } };
  expect(activity(merged).state_actor).toBe("me");
});

it("merges only when GitHub reports ready and checks pass", () => {
  const ready = emptyPull({ state: "open", can_merge: true, merge_methods: ["squash"], checks: "SUCCESS", merge_state: "CLEAN" });
  expect(mergeBlocker(ready)).toBeNull();
  expect(mergeBlocker({ ...ready, state: "merged" })).toBe("This pull request is not open");
  expect(mergeBlocker({ ...ready, checks: "PENDING" })).toBe("Checks are still running");
  expect(mergeBlocker({ ...ready, merge_state: "BLOCKED", review_decision: "REVIEW_REQUIRED" })).toBe("A review is required");
  expect(mergeBlocker({ ...ready, merge_state: "UNKNOWN" })).toBe("GitHub is still checking whether this can be merged");
});
