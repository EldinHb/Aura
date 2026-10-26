import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PullRequest, SubmittedReview } from "../../gen";
import type { RpcClient } from "../../lib/rpc";
import { useStore } from "../../state/store";
import { ReviewSidebar } from "./ReviewSidebar";
import { mineGroup, reviewerEntries, reviewStatus, useReviews, visiblePulls } from "./state";
import { inboxFixture, pullFixture } from "./fixtures";
vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k), clear: () => values.clear() } });
});
const HEAD = pullFixture.head_sha;
const review = (reviewer: string, state: string, extra: Partial<SubmittedReview> = {}): SubmittedReview => ({ reviewer, state, submitted_at: "2026-10-05T10:00:00Z", commit_sha: HEAD, bot: false, ...extra });
const pr = (number: number, extra: Partial<PullRequest> = {}): PullRequest =>
  ({ ...pullFixture, id: `acme/widget#${number}`, number, title: `PR ${number}`, author: "reviewer", updated_at: `2026-10-0${number % 10}T10:00:00Z`, ...extra });
const ready: Partial<PullRequest> = { state: "open", can_merge: true, merge_blocked_by: null };
beforeEach(() => {
  localStorage.clear();
  useReviews.setState({ inbox: { ...inboxFixture, pulls: [] }, error: null, hidden: false, collapsed: false, mineCollapsed: false, showHidden: false, groupsCollapsed: {} });
  useStore.setState({ prSelection: null, client: { call: vi.fn(async () => useReviews.getState().inbox), onNotification: () => () => {}, onState: () => () => {} } as unknown as RpcClient });
});
afterEach(cleanup);

it.each([
  ["no reviews at all", {}, "waiting"],
  ["only a bot reviewed", { reviews: [review("copilot", "COMMENTED", { bot: true })] }, "waiting"],
  ["a comment on the current head", { reviews: [review("alice", "COMMENTED")] }, "reviewed"],
  ["an approval, merge blocked by checks", { review_decision: "APPROVED", reviews: [review("alice", "APPROVED")] }, "reviewed"],
  ["new commits since every review", { reviews: [review("alice", "APPROVED", { commit_sha: "old" }), review("bob", "COMMENTED", { commit_sha: "old" })] }, "waiting"],
  ["new commits since one of two reviews", { reviews: [review("alice", "APPROVED", { commit_sha: "old" }), review("bob", "COMMENTED")] }, "reviewed"],
  ["mergeable without reviews", { ...ready }, "ready"],
  ["mergeable and reviewed", { ...ready, reviews: [review("alice", "APPROVED")] }, "ready"],
  ["changes requested", { review_decision: "CHANGES_REQUESTED", reviews: [review("alice", "CHANGES_REQUESTED")] }, "respond"],
  ["changes requested by a reviewer GitHub did not count", { review_decision: "", reviews: [review("alice", "CHANGES_REQUESTED")] }, "respond"],
  ["a thread waits on you, even when mergeable", { ...ready, unanswered_threads: 2, reviews: [review("alice", "APPROVED")] }, "respond"],
  ["a bot requested changes", { reviews: [review("bot", "CHANGES_REQUESTED", { bot: true })] }, "waiting"],
] as [string, Partial<PullRequest>, string][])("puts a PR with %s in one group", (_, extra, group) => {
  expect(mineGroup(pr(1, extra))).toBe(group);
});

it("never counts a bot's review as reviewed", () => {
  expect(reviewStatus({ review_decision: "REVIEW_REQUIRED", reviews: [review("copilot", "COMMENTED", { bot: true })] })).toEqual({ label: "review required" });
  expect(reviewStatus({ review_decision: "", reviews: [review("copilot", "APPROVED", { bot: true })] })).toBeUndefined();
});

it("lists people by verdict, then pending requests, then bots", () => {
  const entries = reviewerEntries(pr(1, {
    reviews: [review("copilot-pull-request-reviewer", "COMMENTED", { bot: true }), review("carol", "COMMENTED"), review("alice", "APPROVED", { commit_sha: "old" }), review("bob", "CHANGES_REQUESTED")],
    requested: [{ name: "dave", kind: "user" }, { name: "acme/core", kind: "team" }, { name: "carol", kind: "user" }, { name: "copilot", kind: "bot" }],
  }));
  expect(entries.map((e) => `${e.name} ${e.mark}${e.stale ? "↻" : ""}${e.bot ? " bot" : ""}${e.pending ? " pending" : ""}`)).toEqual([
    "bob ✗", "alice ✓↻", "carol ✎ pending", "dave … pending", "@core … pending", "copilot-pull-request-reviewer ✎ bot", "copilot … bot pending",
  ]);
  expect(entries.map((e) => e.describe)).toContain("alice: approved, new commits since");
  expect(entries.map((e) => e.describe)).toContain("carol: commented, asked again");
  expect(entries.map((e) => e.describe)).toContain("team acme/core: review requested");
  expect(entries.map((e) => e.describe)).toContain("copilot-pull-request-reviewer (bot): commented");
});

it("shows three reviewers on a row and the rest as +N, all of them in the tooltip", () => {
  const busy = pr(1, { reviews: [review("alice", "APPROVED"), review("bob", "COMMENTED"), review("copilot", "COMMENTED", { bot: true })], requested: [{ name: "dave", kind: "user" }, { name: "erin", kind: "user" }] });
  useReviews.setState({ inbox: { ...inboxFixture, pulls: [], mine: [busy] } });
  render(<ReviewSidebar />);
  const line = screen.getByTitle("PR 1").querySelector(".pr-reviewers")!;
  expect([...line.querySelectorAll(".pr-reviewer")].map((e) => e.textContent)).toEqual(["alice ✓", "bob ✎", "dave …", "+2"]);
  expect(line.getAttribute("title")!.split("\n")).toHaveLength(5);
  expect(line.getAttribute("title")).toContain("copilot (bot): commented");
});

it("marks bots in the reviewer line", () => {
  useReviews.setState({ inbox: { ...inboxFixture, pulls: [], mine: [pr(1, { reviews: [review("copilot", "COMMENTED", { bot: true })] })] } });
  render(<ReviewSidebar />);
  expect(document.querySelector(".pr-reviewer.bot")?.textContent).toBe("copilot ✎");
  expect(screen.getByRole("button", { name: /Waiting for review/ })).toBeTruthy();
});

it("groups your pull requests in precedence order and leaves out empty groups", () => {
  const mine = [
    pr(1, { reviews: [review("alice", "COMMENTED")] }),
    pr(2),
    pr(3, { unanswered_threads: 1 }),
    pr(4, { reviews: [review("alice", "COMMENTED")] }),
  ];
  useReviews.setState({ inbox: { ...inboxFixture, pulls: [], mine } });
  render(<ReviewSidebar />);
  expect([...document.querySelectorAll(".pr-group-toggle")].map((b) => b.textContent)).toEqual([
    "▾ Needs your review 0", "▾ Your pull requests 4", "▾ Needs your response 1", "▾ Waiting for review 1", "▾ Reviewed 2",
  ]);
  expect([...document.querySelectorAll(".pr-sidebar-row .title")].map((t) => t.textContent)).toEqual(["⑂ PR 3", "⑂ PR 2", "⑂ PR 4", "⑂ PR 1"]);
  expect(visiblePulls(useReviews.getState(), []).mine.map((p) => p.number)).toEqual([3, 2, 4, 1]);
});

it("remembers a collapsed group", () => {
  useReviews.setState({ inbox: { ...inboxFixture, pulls: [], mine: [pr(1, { reviews: [review("alice", "COMMENTED")] }), pr(2)] } });
  render(<ReviewSidebar />);
  fireEvent.click(screen.getByRole("button", { name: /Reviewed/ }));
  expect(screen.queryByTitle("PR 1")).toBe(null);
  expect(screen.getByTitle("PR 2")).toBeTruthy();
  expect(localStorage.getItem("aura.reviews.group.reviewed")).toBe("true");
  expect(visiblePulls(useReviews.getState(), []).mine.map((p) => p.number)).toEqual([2]);
  fireEvent.click(screen.getByRole("button", { name: /Reviewed/ }));
  expect(localStorage.getItem("aura.reviews.group.reviewed")).toBe("false");
  expect(screen.getByTitle("PR 1")).toBeTruthy();
});

it("lists PRs you reviewed with new commits first, and no group when there are none", () => {
  const mine = review("reviewer", "APPROVED");
  const reviewed = [pr(5, { my_review: mine }), pr(3, { my_review: { ...mine, commit_sha: "old" } }), pr(4, { my_review: mine })];
  useReviews.setState({ inbox: { ...inboxFixture, pulls: [pr(9)], reviewed } });
  const { unmount } = render(<ReviewSidebar />);
  expect(screen.getByRole("button", { name: /You reviewed/ }).textContent).toBe("▾ You reviewed 3");
  const rows = [...document.querySelectorAll(".pr-sidebar-row")].map((r) => r.querySelector(".title")!.textContent);
  expect(rows).toEqual(["⑂ PR 9", "⑂ PR 3", "⑂ PR 5", "⑂ PR 4"]);
  expect(screen.getByTitle("PR 3").querySelector(".chip.new")?.textContent).toBe("↻ new commits");
  expect(screen.getByTitle("PR 5").querySelector(".chip.new")).toBe(null);
  expect(screen.getByTitle("PR 3").textContent).toContain("you approved");
  expect(visiblePulls(useReviews.getState(), []).review.map((p) => p.number)).toEqual([9, 3, 5, 4]);
  unmount();
  useReviews.setState({ inbox: { ...inboxFixture, pulls: [], reviewed: [] } });
  render(<ReviewSidebar />);
  expect(screen.queryByRole("button", { name: /You reviewed/ })).toBe(null);
});

it("lists pull requests from a daemon older than the review fields", async () => {
  // As 0.2.8 sent them: no reviews, requests or threads on a PR, no reviewer on a review, no "reviewed" list.
  const old = ({ reviews: _r, requested: _q, unanswered_threads: _t, ...rest }: PullRequest) => rest;
  const { reviewed: _, ...inbox } = { ...inboxFixture, pulls: [old(pr(1, { my_review: { state: "APPROVED", submitted_at: "2026-10-05T10:00:00Z", commit_sha: "old" } as SubmittedReview }))], mine: [old(pr(2))] };
  useStore.setState({ client: { call: vi.fn(async () => inbox), onNotification: () => () => {}, onState: () => () => {} } as unknown as RpcClient });
  await useReviews.getState().refresh();
  render(<ReviewSidebar />);
  expect(screen.getByTitle("PR 1")).toBeTruthy();
  expect(screen.getByTitle("PR 2")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Waiting for review/ })).toBeTruthy();
});

it("says when the GitHub login expired instead of showing a stale error", () => {
  useReviews.setState({ inbox: { ...inboxFixture, error: "Bad credentials (HTTP 401)", blocked: "GitHub login expired. Run `gh auth login`; Aura reconnects by itself." } });
  render(<ReviewSidebar />);
  const notice = screen.getByRole("status");
  expect(notice.textContent).toBe("GitHub login expired. Run gh auth login; Aura reconnects by itself.");
  expect(notice.querySelector("code")?.textContent).toBe("gh auth login");
  expect(screen.queryByText(/Bad credentials/)).toBeNull();
});
