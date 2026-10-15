import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RpcClient } from "../../lib/rpc";
import type { PullTimeline, ReviewThread, TimelineItem } from "../../gen";
import { normalizeDetail, type PullDetail } from "../../lib/pulls";
import { timeAgo } from "../../lib/time";
import { useStore } from "../../state/store";
import { buildTimeline, commitCount, legacyTimeline } from "./conversation";
import { inboxFixture, pullFixture } from "./fixtures";
import { PullWorkspace } from "./PullWorkspace";
import { useReviews } from "./state";

const item = (kind: string, id: string, at: string, over: Partial<TimelineItem> = {}): TimelineItem => ({ kind, id, at, actor: "ann", body: "", url: "", state: "", review_id: null, subject: "", previous: "", color: "", sha: id, before: "", ...over });
const thread = (id: string, review: number | null, at: string, over: Partial<ReviewThread> = {}): ReviewThread => ({ id, path: "src/a.ts", line: 3, original_line: 3, resolved: false, outdated: false, resolved_by: "", diff_hunk: "@@ -1,3 +1,3 @@\n a\n-b\n+c", review_id: review, more: 0, comments: [{ id: `${id}-c`, author: "bob", at, body: `body of ${id}`, url: "" }], ...over });
const detail = (timeline: PullTimeline) => ({ timeline, comments: [], reviews: [], threads: [] });
const pull = { created_at: "2026-10-01T08:00:00Z" };

it("orders entries by time after the description and groups consecutive commits", () => {
  const entries = buildTimeline(pull, detail({
    items: [
      item("comment", "late", "2026-10-03T10:00:00Z"),
      item("commit", "c1", "2026-10-01T09:00:00Z"),
      item("commit", "c2", "2026-10-01T09:30:00Z"),
      item("labeled", "l", "2026-10-02T10:00:00Z", { subject: "bug" }),
      item("commit", "c3", "2026-10-02T11:00:00Z"),
      item("something_new", "x", "2026-10-02T12:00:00Z"),
    ],
    threads: [], commits: 3,
  }));
  expect(entries.map((e) => e.kind)).toEqual(["description", "commits", "event", "commits", "comment"]);
  const first = entries[1];
  expect(first.kind === "commits" && first.items.map((c) => c.id)).toEqual(["c1", "c2"]);
});

it("keeps the order of equal times and places entries without a time after the one before them", () => {
  const entries = buildTimeline(pull, detail({ items: [item("comment", "a", "2026-10-02T10:00:00Z"), item("comment", "b", "2026-10-02T10:00:00Z"), item("comment", "c", ""), item("comment", "d", "2026-10-01T10:00:00Z")], threads: [], commits: 0 }));
  expect(entries.slice(1).map((e) => e.key)).toEqual(["comment:d", "comment:a", "comment:b", "comment:c"]);
});

it("nests threads under the review that started them, oldest first, and lists the rest by time", () => {
  const entries = buildTimeline(pull, detail({
    items: [item("review", "r1", "2026-10-02T10:00:00Z", { review_id: 1, state: "CHANGES_REQUESTED" }), item("comment", "c", "2026-10-02T12:00:00Z")],
    threads: [thread("t2", 1, "2026-10-02T09:59:30Z"), thread("t1", 1, "2026-10-02T09:59:00Z"), thread("orphan", 99, "2026-10-02T11:00:00Z"), thread("empty", 1, "x", { comments: [] })],
    commits: 0,
  }));
  expect(entries.map((e) => e.key)).toEqual(["description", "review:r1", "thread:orphan", "comment:c"]);
  const review = entries[1];
  expect(review.kind === "review" && review.threads.map((t) => t.id)).toEqual(["t1", "t2"]);
});

it("skips empty comment-only reviews but keeps approvals without a body", () => {
  const entries = buildTimeline(pull, detail({ items: [item("review", "empty", "2026-10-02T10:00:00Z", { review_id: 1, state: "COMMENTED" }), item("review", "ok", "2026-10-02T11:00:00Z", { review_id: 2, state: "APPROVED" })], threads: [], commits: 0 }));
  expect(entries.map((e) => e.key)).toEqual(["description", "review:ok"]);
});

it("builds the timeline from the REST lists of an older daemon", () => {
  const legacy = {
    comments: [{ id: 10, body: "Looks good", html_url: "u", created_at: "2026-10-02T09:00:00Z", user: { login: "carol" } }],
    reviews: [
      { id: 1, body: "", html_url: "u", submitted_at: "2026-10-02T10:00:00Z", state: "CHANGES_REQUESTED", user: { login: "bob" } },
      // A reply submitted on its own: a review of its own on GitHub, left out of the timeline.
      { id: 2, body: "", html_url: "u", submitted_at: "2026-10-02T11:00:00Z", state: "COMMENTED", user: { login: "ann" } },
    ],
    threads: [
      { id: 101, body: "Rename this", html_url: "u", created_at: "2026-10-02T10:00:00Z", path: "a.ts", line: 4, diff_hunk: "@@\n+x", pull_request_review_id: 1, user: { login: "bob" } },
      { id: 102, body: "Done", html_url: "u", created_at: "2026-10-02T11:00:00Z", path: "a.ts", line: 4, in_reply_to_id: 101, pull_request_review_id: 2, user: null },
      { id: 103, body: "Gone", html_url: "u", created_at: "2026-10-02T10:00:00Z", path: "b.ts", line: null, pull_request_review_id: 1, user: { login: "bob" } },
    ],
  };
  const t = legacyTimeline(legacy);
  expect(t.threads.map((x) => [x.id, x.review_id, x.outdated, x.comments.map((c) => c.author)])).toEqual([["101", 1, false, ["bob", "ghost"]], ["103", 1, true, ["bob"]]]);
  const entries = buildTimeline(pull, { timeline: null, ...legacy });
  expect(entries.map((e) => e.key)).toEqual(["description", "comment:10", "review:1"]);
  expect(commitCount({ timeline: null })).toBeNull();
});

it("normalizes a detail missing fields an older daemon does not send", () => {
  const d = normalizeDetail({ pull: { ...pullFixture, labels: undefined }, timeline: { items: [{ kind: "comment" }], threads: [{ id: "t" }] } } as unknown as PullDetail);
  expect(d.comments).toEqual([]);
  expect(d.projects).toEqual([]);
  expect(d.pull.labels).toEqual([]);
  expect(d.timeline?.items[0]).toMatchObject({ kind: "comment", actor: "", review_id: null, body: "" });
  expect(d.timeline?.threads[0]).toMatchObject({ comments: [], line: null, resolved: false, more: 0 });
  expect(normalizeDetail({ pull: pullFixture } as PullDetail).timeline).toBeNull();
});

it("words times relative to now", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  expect(timeAgo("2026-10-15T09:00:00Z", now)).toBe("3 hours ago");
  expect(timeAgo("2026-10-15T11:59:50Z", now)).toBe("just now");
  expect(timeAgo("nonsense", now)).toBe("");
});

const call = vi.fn();
beforeEach(() => {
  call.mockReset();
  useReviews.setState({ inbox: inboxFixture, reviewId: null });
  useStore.setState({ prSelection: pullFixture, reviewHistoryOpen: false, client: { call, onNotification: () => () => {}, onState: () => () => {} } as unknown as RpcClient });
});
afterEach(cleanup);

it("renders the conversation of an older daemon's reply", async () => {
  call.mockImplementation(async (method: string) => method === "pulls.get"
    ? { pull: pullFixture, comments: [{ id: 1, body: "First!", html_url: "u", created_at: "2026-09-21T11:00:00Z", user: { login: "carol" } }], reviews: [{ id: 5, body: "Please fix", html_url: "u", submitted_at: "2026-09-21T12:00:00Z", state: "CHANGES_REQUESTED", user: { login: "bob" } }], threads: [{ id: 7, body: "Typo here", html_url: "u", created_at: "2026-09-21T12:00:00Z", path: "service.ts", line: 1, pull_request_review_id: 5, user: { login: "bob" } }] }
    : null);
  render(<PullWorkspace />);
  const timeline = await screen.findByRole("list", { name: "Conversation" });
  await waitFor(() => expect(within(timeline).getByText("First!")).toBeTruthy());
  expect(within(timeline).getByText(/requested changes/)).toBeTruthy();
  const review = within(timeline).getByText("Please fix").closest("li")!;
  expect(within(review as HTMLElement).getByText("Typo here")).toBeTruthy();
  expect(screen.getByText(/wants to merge/).textContent).toBe("colleague wants to merge into main from fix-empty");
});

it("renders the timeline, resolved threads collapsed, and the commit count", async () => {
  const timeline: PullTimeline = {
    items: [item("commit", "abcdef1234", "2026-09-21T10:30:00Z", { subject: "Guard against empty data" }), item("review", "r", "2026-09-21T12:00:00Z", { review_id: 3, state: "APPROVED", actor: "bob" }), item("merged", "m", "2026-09-21T13:00:00Z", { actor: "dana", subject: "main", sha: "fedcba9876" })],
    threads: [thread("t", 3, "2026-09-21T11:59:00Z", { resolved: true, resolved_by: "ann" })],
    commits: 1,
  };
  call.mockImplementation(async (method: string) => method === "pulls.get" ? { pull: { ...pullFixture, state: "merged" }, timeline, comments: [], reviews: [], threads: [], projects: [], project_error: null } : null);
  render(<PullWorkspace />);
  await screen.findByText("Guard against empty data");
  expect(screen.getByText(/merged 1 commit/).textContent).toBe("dana merged 1 commit into main from fix-empty");
  expect(screen.getByText("Merged")).toBeTruthy();
  const details = screen.getByText("Resolved by ann").closest("details")!;
  expect(details.open).toBe(false);
  expect(screen.getByText(/approved these changes/)).toBeTruthy();
});
