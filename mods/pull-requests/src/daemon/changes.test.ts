import { describe, expect, it } from "vitest";
import { createTestHost } from "@aura/mod-sdk/testing";
import type { PullEvent, PullRequest } from "@aura/github-client";
import { detect, diff, entries, leavers, load, markRead, record, save, snapshot, summary, type Snapshots } from "./changes";
import type { LatestReview, Note, PullActivity, ReadPull } from "./github";
import { clone, nowIso } from "./util";

const ME = "me";
type Pr = PullRequest & { activity: PullActivity };

const note = (id: number, author: string): Note => ({ id, author, bot: author.endsWith("[bot]") });
const latest = (id: number, reviewer: string, state: string): LatestReview => ({ id, reviewer, bot: reviewer.endsWith("[bot]"), state });

/** An open PR by `author`, quiet so far: one commit, checks passing, mergeable. */
function pr(number: number, author: string): Pr {
  return {
    id: `o/r#${number}`,
    account: "github.com:me",
    repo: "o/r",
    number,
    title: `PR ${number}`,
    body: "",
    url: "",
    author,
    state: "open",
    draft: false,
    base_ref: "",
    head_ref: "",
    base_sha: "",
    head_sha: "h1",
    updated_at: "",
    created_at: "",
    additions: 0,
    deletions: 0,
    changed_files: 0,
    checks: "SUCCESS",
    review_decision: "",
    hidden: false,
    can_edit: false,
    assignees: [],
    labels: [],
    milestone: null,
    milestone_title: "",
    my_review: null,
    reviews: [],
    requested: [],
    unanswered_threads: 0,
    review_requested_at: null,
    merge_state: "CLEAN",
    merge_methods: [],
    default_merge_method: "",
    can_merge: false,
    can_delete_branch: false,
    auto_delete_branch: false,
    merge_blocked_by: null,
    activity: {
      commits: 1,
      pushed_by: [author],
      comments: [note(10, "alice")],
      thread_comments: [note(20, "alice")],
      reviews: [latest(30, "alice", "COMMENTED")],
      state_actor: "",
    },
  };
}
const kinds = (events: PullEvent[]) => events.map((e) => [e.kind, e.actor, e.detail, e.count]);
const ev = (kind: string, actor: string, detail: string, count: number) => [kind, actor, detail, count];
/** The events between `before` and `after`, for a PR followed as `role`. */
const between = (before: ReadPull, after: ReadPull, role: string) => kinds(diff(snapshot(before, role, null), after, role, ME));
const store = () => createTestHost({ id: "pull-requests" }).api.storage;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("pull request changes", () => {
  it("counts new commits by others and not your own pushes", () => {
    const before = pr(1, "me");
    const after = clone(before);
    after.head_sha = "h2";
    after.activity.commits = 3;
    after.activity.pushed_by = ["bob"];
    expect(between(before, after, "authored")).toEqual([ev("commits", "bob", "", 2)]);
    after.activity.pushed_by = ["bob", "Me"];
    expect(between(before, after, "authored")).toEqual([]);
    after.activity.pushed_by = [];
    after.activity.commits = 1;
    expect(between(before, after, "reviewed")).toEqual([ev("commits", "", "", 1)]);
  });

  it("counts submitted reviews by others with bots marked", () => {
    const before = pr(1, "me");
    const after = clone(before);
    after.activity.reviews = [
      latest(31, "bob", "APPROVED"),
      latest(32, "carol", "CHANGES_REQUESTED"),
      latest(33, "copilot[bot]", "COMMENTED"),
      latest(34, "me", "COMMENTED"),
      latest(35, "dave", "PENDING"),
      latest(36, "erin", "DISMISSED"),
      latest(30, "alice", "COMMENTED"),
    ];
    const events = diff(snapshot(before, "authored", null), after, "authored", ME);
    expect(kinds(events)).toEqual([
      ev("review", "bob", "APPROVED", 1),
      ev("review", "carol", "CHANGES_REQUESTED", 1),
      ev("review", "copilot[bot]", "COMMENTED", 1),
    ]);
    expect([events[2].bot, events[2].review_id]).toEqual([true, 33]);
    expect(summary(events)).toBe("bob approved · carol requested changes · copilot[bot] (bot) reviewed");
  });

  it("takes the author's replies to your review as comments, not reviews", () => {
    const before = pr(1, "bob");
    const after = clone(before);
    after.activity.reviews.push(latest(31, "bob", "COMMENTED"));
    after.activity.thread_comments.push(note(21, "bob"));
    expect(between(before, after, "reviewed")).toEqual([ev("comment", "bob", "", 1)]);
  });

  it("counts comments and thread replies by others per person", () => {
    const before = pr(1, "me");
    const after = clone(before);
    after.activity.comments.push(note(11, "bob"), note(12, "ci[bot]"), note(13, "me"), note(14, "bob"));
    after.activity.thread_comments.push(note(21, "carol"), note(22, "me"));
    expect(between(before, after, "authored")).toEqual([ev("comment", "bob", "", 2), ev("comment", "carol", "", 1)]);
    // The inline comments of a new review are part of that review.
    after.activity.reviews.push(latest(31, "carol", "COMMENTED"));
    expect(between(before, after, "authored")).toEqual([ev("review", "carol", "COMMENTED", 1), ev("comment", "bob", "", 2)]);
  });

  it("counts a new request for your review", () => {
    const before = pr(1, "bob");
    before.review_requested_at = "2026-10-01T10:00:00Z";
    const after = clone(before);
    expect(between(before, after, "requested")).toEqual([]);
    after.review_requested_at = "2026-10-02T10:00:00Z";
    expect(between(before, after, "requested")).toEqual([ev("review_requested", "", "", 1)]);
    expect(between(before, after, "reviewed")).toEqual([]);
  });

  it("counts finished checks when they fail, or pass after failing", () => {
    const before = pr(1, "me");
    before.checks = "PENDING";
    const after = clone(before);
    after.checks = "FAILURE";
    expect(between(before, after, "authored")).toEqual([ev("checks", "", "FAILURE", 1)]);
    expect(between(before, after, "reviewed")).toEqual([]);
    expect(between(before, after, "linked")).toEqual([ev("checks", "", "FAILURE", 1)]);

    // Failed, then fixed: missing the run in between does not matter.
    const failed = snapshot(after, "authored", null);
    const fixed = clone(after);
    fixed.head_sha = "h2";
    fixed.activity.pushed_by = ["me"];
    fixed.checks = "PENDING";
    expect(diff(failed, fixed, "authored", ME)).toEqual([]);
    const running = snapshot(fixed, "authored", failed);
    fixed.checks = "SUCCESS";
    expect(kinds(diff(running, fixed, "authored", ME))).toEqual([ev("checks", "", "SUCCESS", 1)]);
    const passed = snapshot(fixed, "authored", running);
    expect(diff(passed, fixed, "authored", ME)).toEqual([]);

    // Passing all along is not news; failing again on a new head is.
    const quiet = pr(1, "me");
    quiet.checks = "PENDING";
    const ok = clone(quiet);
    ok.checks = "SUCCESS";
    expect(between(quiet, ok, "authored")).toEqual([]);
    const again = clone(after);
    again.head_sha = "h3";
    again.activity.pushed_by = ["me"];
    expect(kinds(diff(failed, again, "authored", ME))).toEqual([ev("checks", "", "FAILURE", 1)]);
  });

  it("counts merged, closed and reopened unless you did it", () => {
    const before = pr(1, "me");
    for (const [state, actor, expected] of [
      ["merged", "bob", "merged"],
      ["closed", "carol", "closed"],
    ]) {
      const after = clone(before);
      after.state = state;
      after.activity.state_actor = actor;
      expect(between(before, after, "authored")).toEqual([ev("state", actor, expected, 1)]);
      after.activity.state_actor = "ME";
      expect(between(before, after, "authored")).toEqual([]);
    }
    const closed = clone(before);
    closed.state = "closed";
    const reopened = clone(before);
    reopened.activity.state_actor = "bob";
    expect(between(closed, reopened, "reviewed")).toEqual([ev("state", "bob", "reopened", 1)]);
    const merged = clone(before);
    merged.state = "merged";
    merged.activity.state_actor = "bob";
    merged.checks = "FAILURE";
    merged.merge_state = "DIRTY";
    expect(between(before, merged, "authored")).toEqual([ev("state", "bob", "merged", 1)]);
    expect(summary(diff(snapshot(before, "authored", null), merged, "authored", ME))).toBe("merged by bob");
  });

  it("counts conflicts and becoming mergeable", () => {
    const before = pr(1, "me");
    const after = clone(before);
    after.merge_state = "DIRTY";
    expect(between(before, after, "authored")).toEqual([ev("mergeable", "", "conflicts", 1)]);
    const unknown = clone(after);
    unknown.merge_state = "UNKNOWN";
    const dirty = snapshot(after, "authored", null);
    const still = snapshot(unknown, "authored", dirty);
    expect(still.merge_state).toBe("DIRTY");
    const clean = clone(after);
    clean.merge_state = "CLEAN";
    expect(kinds(diff(still, clean, "authored", ME))).toEqual([ev("mergeable", "", "clean", 1)]);
    const blocked = clone(before);
    blocked.merge_state = "BLOCKED";
    expect(between(blocked, before, "authored")).toEqual([ev("mergeable", "", "clean", 1)]);
    const unstable = clone(before);
    unstable.merge_state = "UNSTABLE";
    expect(between(unstable, before, "authored")).toEqual([]);
    expect(between(before, after, "requested")).toEqual([]);
  });

  it("takes a baseline on the first refresh and reports nothing twice after a restart", async () => {
    const s = store();
    const a = pr(1, "me");
    const b = pr(2, "bob");
    b.review_requested_at = "2020-01-01T00:00:00Z";
    let [snaps, found] = detect(await load(s, "github.com:me"), [
      [a, "authored"],
      [b, "requested"],
    ], [], ME);
    expect(found).toEqual([]);
    await save(s, "github.com:me", snaps);

    const pushed = clone(a);
    pushed.head_sha = "h2";
    pushed.activity.pushed_by = ["bob"];
    const read: Array<[ReadPull, string]> = [
      [pushed, "authored"],
      [b, "requested"],
    ];
    [snaps, found] = detect(await load(s, "github.com:me"), read, [], ME);
    expect(found.length).toBe(1);
    await save(s, "github.com:me", snaps);
    // The daemon restarts: the snapshot is read back and the same PRs show nothing new.
    [, found] = detect(await load(s, "github.com:me"), read, [], ME);
    expect(found).toEqual([]);
    expect(await load(s, "github.com:other")).toBeNull();
    await s.kv.set("pulls.snapshots.v1.github.com:other", "{broken");
    expect(await load(s, "github.com:other")).toBeNull();
  });

  it("reports a PR that arrives only when your review was requested since", async () => {
    const s = store();
    const [snaps] = detect(null, [], [], ME);
    await save(s, "github.com:me", snaps);
    await sleep(2);
    const asked = pr(2, "bob");
    asked.review_requested_at = nowIso();
    const old = pr(3, "bob");
    old.review_requested_at = "2020-01-01T00:00:00Z";
    const [, found] = detect(await load(s, "github.com:me"), [
      [asked, "requested"],
      [old, "requested"],
      [pr(4, "me"), "authored"],
      [pr(5, "carol"), "linked"],
    ], [], ME);
    expect(found.map((c) => [c.pull_id, c.summary])).toEqual([["o/r#2", "your review was requested"]]);
  });

  it("reads a PR that leaves the lists once more to see it merged", () => {
    const a = pr(1, "me");
    let [snaps] = detect(null, [[a, "authored"]], [], ME);
    const leaving = leavers(snaps, []);
    expect(leaving).toEqual([["o/r", 1]]);
    const merged = clone(a);
    merged.state = "merged";
    merged.activity.state_actor = "bob";
    let found;
    [snaps, found] = detect(snaps, [[merged, ""]], leaving, ME);
    expect(found.length).toBe(1);
    expect([found[0].role, found[0].summary]).toEqual(["authored", "merged by bob"]);
    expect(leavers(snaps, [])).toEqual([]);
    // GitHub could not read it: it is not tried again either.
    [snaps] = detect(null, [[a, "authored"]], [], ME);
    const gone = leavers(snaps, []);
    [snaps] = detect(snaps, [], gone, ME);
    expect(leavers(snaps, [])).toEqual([]);
  });

  it("keeps a burst in one refresh as one entry that later ones join until read", async () => {
    const s = store();
    const before = pr(1, "me");
    const after = clone(before);
    after.head_sha = "h2";
    after.activity.pushed_by = ["bob"];
    after.activity.commits = 2;
    after.activity.comments.push(note(11, "carol"), note(12, "carol"), note(13, "dave"));
    let snaps: Snapshots;
    let found;
    [snaps] = detect(null, [[before, "authored"]], [], ME);
    [snaps, found] = detect(snaps, [[after, "authored"]], [], ME);
    expect(found.length).toBe(1);
    expect(found[0].summary).toBe("bob pushed 1 commit · carol left 2 comments · dave commented");
    let news = await record(s, "github.com:me", found);
    let list = await entries(s, "github.com:me");
    expect([list.length, news[0].id]).toEqual([1, list[0].id]);

    const later = clone(after);
    later.activity.comments.push(note(14, "carol"));
    later.activity.reviews.push(latest(31, "dave", "APPROVED"));
    [snaps, found] = detect(snaps, [[later, "authored"]], [], ME);
    await sleep(2);
    news = await record(s, "github.com:me", found);
    expect(news[0].summary).toBe("dave approved · carol commented");
    list = await entries(s, "github.com:me");
    expect(list.length).toBe(1);
    expect(list[0].summary).toBe("bob pushed 1 commit · carol left 3 comments · dave commented · dave approved");

    expect(await markRead(s, "github.com:me", [list[0].id])).toBe(true);
    expect(await markRead(s, "github.com:me", null)).toBe(false);
    const again = clone(later);
    again.activity.comments.push(note(15, "erin"));
    await sleep(2);
    [, found] = detect(snaps, [[again, "authored"]], [], ME);
    await record(s, "github.com:me", found);
    list = await entries(s, "github.com:me");
    expect(list.map((e) => [e.summary, e.read])).toEqual([
      ["erin commented", false],
      ["bob pushed 1 commit · carol left 3 comments · dave commented · dave approved", true],
    ]);
  });

  it("reads entries from an older or newer daemon", async () => {
    const s = store();
    await s.collection("pull-changes:github.com:me").put("x", { id: "x", future: 1 });
    await s.collection("pull-changes:github.com:me").put("y", "not json");
    const list = await entries(s, "github.com:me");
    expect(list.length).toBe(1);
    expect(list[0].id).toBe("x");
    expect(list[0]).not.toHaveProperty("future");
    await s.kv.set("pulls.snapshots.v1.a", { pulls: { "o/r#1": { state: "open" } } });
    expect((await load(s, "a"))!.pulls["o/r#1"].state).toBe("open");
  });
});
