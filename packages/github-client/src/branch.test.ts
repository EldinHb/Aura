import { expect, it } from "vitest";
import { branchPull } from "./branch";
import { fakeGithub } from "./testing/fake";

function node(number: number, state: string, headRepo: string): Record<string, any> {
  return {
    number, title: `PR ${number}`, url: `https://github.com/owner/repo/pull/${number}`,
    state, isDraft: false, reviewDecision: "APPROVED", headRefOid: "abc",
    author: { login: "me" }, headRepository: { nameWithOwner: headRepo },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  };
}
const fake = (nodes: unknown[]) => fakeGithub(() => ({ data: { repository: { pullRequests: { nodes } } } }));

it("prefers the open pull request of the branch", async () => {
  const gh = fake([node(3, "MERGED", "owner/repo"), node(2, "OPEN", "owner/repo"), node(1, "CLOSED", "owner/repo")]);
  const pull = (await branchPull(gh, "owner/repo", "owner/repo", "feature"))!;
  expect([pull.number, pull.state, pull.checks, pull.review_decision]).toEqual([2, "open", "SUCCESS", "APPROVED"]);
  expect(gh.calls[0].body.variables).toEqual({ owner: "owner", name: "repo", head: "feature" });
});

it("reports comment-only reviews by others", async () => {
  const open = node(2, "OPEN", "owner/repo");
  open.reviewDecision = "REVIEW_REQUIRED";
  open.latestReviews = { nodes: [
    { state: "COMMENTED", submittedAt: "2026-10-05T10:00:00Z", author: { __typename: "User", login: "alice" }, commit: { oid: "abc" } },
    { state: "COMMENTED", submittedAt: "2026-10-05T11:00:00Z", author: { __typename: "User", login: "me" }, commit: { oid: "abc" } },
  ] };
  const pull = (await branchPull(fake([open]), "owner/repo", "owner/repo", "feature"))!;
  expect(pull.reviews.map((r) => [r.reviewer, r.state])).toEqual([["alice", "COMMENTED"]]);
});

it("falls back to the latest merged or closed pull request", async () => {
  const pull = (await branchPull(fake([node(3, "MERGED", "owner/repo"), node(1, "CLOSED", "owner/repo")]), "owner/repo", "owner/repo", "feature"))!;
  expect([pull.number, pull.state]).toEqual([3, "merged"]);
});

it("ignores branches with the same name in other forks", async () => {
  expect((await branchPull(fake([node(5, "OPEN", "someone/repo"), node(4, "OPEN", "Me/Repo")]), "owner/repo", "me/repo", "main"))?.number).toBe(4);
  expect(await branchPull(fake([node(5, "OPEN", "someone/repo")]), "owner/repo", "me/repo", "main")).toBeNull();
});

it("rejects unsafe repositories", async () => {
  await expect(branchPull(fake([]), "owner/../repo", "owner/repo", "feature")).rejects.toThrow();
  await expect(branchPull(fake([]), "owner/repo", "owner/repo", "")).rejects.toThrow();
});
