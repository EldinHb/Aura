import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHost, type TestHost } from "@aura/mod-sdk/testing";
import type { PreReview, PullChange, PullRequest, ReviewAgent, ReviewComment } from "@aura/github-client";
import { start } from "../daemon";
import { Links } from "./links";
import { orchestratorMethods } from "./orchestrated";
import { ReviewService, buildPreview, mergeBlocker, payload, signature } from "./reviews";
import { comment, type ReviewRunner, type RunOutput } from "./runner";
import { LOGIN_EXPIRED, TestGithub, TestLinks, TestNotified, pullRequest, refusal, session, testLib } from "./testing";
import { NAMES } from "./tools";
import { Tasks, clone, nowIso } from "./util";
import type { ReviewWorkspace } from "./workspace";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const DIFF = "diff --git a/test.rs b/test.rs\n--- a/test.rs\n+++ b/test.rs\n@@ -1 +1 @@\n-before\n+after\n";

function draft(): PreReview {
  return {
    id: "review-1",
    pull: pullRequest({ id: "o/r#1", repo: "o/r", number: 1, account: "github.com:alice", head_sha: A, base_sha: B, state: "open" }),
    config: { provider: "codex", model: null, effort: null, prompt_mode: "default", prompt: "" },
    instructions: "Review",
    status: "ready",
    phase: "done",
    error: null,
    created_at: "2026-10-01T10:00:00.000Z",
    updated_at: "2026-10-01T10:00:00.000Z",
    revision: 0,
    reviewed_sha: A,
    merge_base: B,
    context_mode: "worktree",
    context_note: null,
    diff: DIFF,
    log_tail: [],
    result: {
      summary: "A useful summary",
      verdict: "comment",
      risk: "low",
      confidence: 0.8,
      comments: [comment({ id: "c1", path: "test.rs", line: 1, side: "RIGHT", body: "Fix this", severity: "major", rationale: "Private thought" })],
    },
    submitted_url: null,
    submission: null,
    agent: null,
    source: null,
  };
}
const claudeAgent = (): ReviewAgent => ({ provider: "Claude Code", model: "opus", model_id: null, effort: "high" });

/** GitHub as the Rust tests' MockGithub answered it: PRs in o/r by bob, changing together. */
function world() {
  const w = {
    head: A,
    uncertain: false,
    reject: false,
    posts: 0,
    posted: [] as any[],
    mergeState: "CLEAN",
    writes: [] as string[],
    merged: [] as Array<[string, string]>,
    searches: { requested: [] as number[], reviewed: [] as number[], authored: [1] },
    unreadable: [] as number[],
    state: ["OPEN", ""] as [string, string],
    reads: 0,
  };
  const gh = new TestGithub((method, path, body: any) => {
    if (path.includes("/compare/")) return { merge_base_commit: { sha: B } };
    if (method === "POST" && path.endsWith("/reviews")) {
      w.posts++;
      if (w.reject) throw refusal("HTTP 422 invalid comment");
      const v = { ...body, html_url: "https://github.com/o/r/pull/1#review-1" };
      w.posted.push(v);
      if (w.uncertain) throw new Error("network timeout");
      return v;
    }
    if (path.includes("/reviews?")) return [...w.posted];
  });
  gh.login = "alice";
  gh.diff = async () => DIFF;
  const pull = (n: number): PullRequest => {
    const [state, mergedBy] = w.state;
    const p = pullRequest({
      id: `o/r#${n}`,
      account: `github.com:${gh.login}`,
      repo: "o/r",
      number: n,
      title: `PR ${n}`,
      url: `https://github.com/o/r/pull/${n}`,
      author: "bob",
      state: state.toLowerCase(),
      head_sha: w.head,
      head_ref: "feature",
      base_sha: B,
      base_ref: "main",
      can_edit: true,
      review_decision: "REVIEW_REQUIRED",
      merge_state: w.mergeState,
      merge_methods: ["squash", "rebase"],
      default_merge_method: "squash",
      can_merge: true,
      can_delete_branch: true,
      my_review: w.posted.length ? { reviewer: gh.login, bot: false, state: "COMMENTED", submitted_at: "2026-10-05T10:00:00Z", commit_sha: A } : null,
    });
    p.merge_blocked_by = mergeBlocker(p);
    return Object.assign(p, { activity: { commits: 0, pushed_by: [], comments: [], thread_comments: [], reviews: [], state_actor: mergedBy } });
  };
  const listed = (key: keyof typeof w.searches) => async () => {
    gh.requests++;
    // GitHub bumps a PR's updated_at when it changes; these PRs change together.
    const updated = `${w.head}${w.state.join()}${w.posted.length}${w.mergeState}`;
    return w.searches[key].map((n) => [["o/r", n], updated] as [[string, number], string]);
  };
  const lib = testLib({
    requested: listed("requested"),
    reviewed: listed("reviewed"),
    authored: listed("authored"),
    pulls: async (_gh, _account, ids) => {
      w.reads++;
      gh.requests++;
      return ids.map(([repo, n]) => (w.unreadable.includes(n) ? new Error(`Unable to read ${repo}#${n}: Something went wrong`) : pull(n)));
    },
    pull: async (_gh, _account, repo, n) => {
      w.reads++;
      gh.requests++;
      if (w.unreadable.includes(n)) throw new Error(`Unable to read ${repo}#${n}: Something went wrong`);
      return pull(n);
    },
    timeline: async () => ({
      commits: 2,
      items: [
        { kind: "comment", id: "IC_1", at: "2026-10-05T09:00:00Z", actor: "carol", body: "Nice", url: "u1", state: "", review_id: null, subject: "", previous: "", color: "", sha: "", before: "" },
        { kind: "review", id: "PRR_1", at: "2026-10-05T10:00:00Z", actor: "dave", body: "", url: "u", state: "APPROVED", review_id: 7, subject: "", previous: "", color: "", sha: "", before: "" },
      ],
      threads: [
        { id: "T1", path: "src/lib.rs", line: 2, original_line: 2, resolved: false, outdated: false, resolved_by: "", diff_hunk: "@@", review_id: 7, comments: [], more: 0 },
      ],
    }),
    legacyLists: (t) => [
      t.items.filter((i) => i.kind === "comment").map((i) => ({ id: i.id, body: i.body, html_url: i.url, created_at: i.at, user: { login: i.actor } })),
      t.items.filter((i) => i.kind === "review").map((i) => ({ id: i.id, body: i.body, html_url: i.url, submitted_at: i.at, state: i.state, user: { login: i.actor } })),
      t.threads.map((th) => ({ id: th.id, path: th.path, line: th.line })),
    ],
    projects: async () => [],
    merge: async (_gh, _account, p, method) => {
      w.writes.push(`PUT repos/${p.repo}/pulls/${p.number}/merge`);
      w.merged.push([method, p.head_sha]);
      return { merged: true };
    },
    deleteBranch: async (_gh, _account, p) => {
      w.writes.push(`DELETE repos/${p.repo}/git/refs/heads/${p.head_ref}`);
    },
  });
  return { w, gh, lib };
}

class MockRunner implements ReviewRunner {
  async run(_r: PreReview, _cwd: string, progress: (l: string) => void): Promise<RunOutput> {
    progress("Reading changed file");
    return { result: draft().result, model_id: "claude-opus-5-5" };
  }
}
class MockWorkspace implements ReviewWorkspace {
  removed: string[] = [];
  written: string[] = [];
  fails: string | null = null;
  path = () => "/data/workspaces/review-x";
  prepare = async (): Promise<[string, string]> => {
    if (this.fails) throw new Error(this.fails);
    return [DIFF, B];
  };
  writeDiff = async (cwd: string) => void this.written.push(cwd);
  empty = async () => "/data/workspaces/empty";
  remove = async (_p: PullRequest, cwd: string) => void this.removed.push(cwd);
}

const running: Tasks[] = [];
afterEach(() => running.splice(0).forEach((t) => t.stop()));

interface Made {
  svc: ReviewService;
  host: TestHost;
  w: ReturnType<typeof world>["w"];
  gh: TestGithub;
  links: TestLinks;
  workspace: MockWorkspace;
}
async function service(r: PreReview | null = draft(), o: { host?: TestHost; fake?: ReturnType<typeof world>; account?: boolean; runner?: ReviewRunner } = {}): Promise<Made> {
  const host = o.host ?? createTestHost({ id: "pull-requests" });
  const { w, gh, lib } = o.fake ?? world();
  const links = new TestLinks();
  host.provideMod("github", links.serve);
  if (r) await host.api.storage.collection("reviews").put(r.id, r);
  const tasks = new Tasks();
  running.push(tasks);
  const workspace = new MockWorkspace();
  const svc = new ReviewService({ aura: host.api, gh, lib, tasks, links: new Links(host.api), workspace, runner: o.runner ?? new MockRunner() });
  await svc.load();
  if (r && o.account !== false) svc.state.account = r.pull.account;
  return { svc, host, w, gh, links, workspace };
}
const call = (svc: ReviewService, method: string, p: unknown) => {
  const all = { ...svc.methods(), ...orchestratorMethods(svc) };
  return all[method](p);
};

describe("pre-reviews", () => {
  it("submit exact positions and no private or deleted data", () => {
    const r = draft();
    r.result.comments.push({ ...r.result.comments[0], id: "deleted", body: "secret deleted", deleted: true });
    r.result.comments.push({ ...r.result.comments[0], id: "orphan", path: "missing.rs", body: "Kept unanchored" });
    const preview = buildPreview(r, C);
    expect(preview.stale).toBe(true);
    expect(preview.comments.length).toBe(1);
    const body = JSON.stringify(payload(preview));
    expect(body).not.toContain("Private thought");
    expect(body).not.toContain("secret deleted");
    expect(body).toContain("Kept unanchored");
    expect(payload(preview).commit_id).toBe(A);
  });

  it("require a preview and check the head again", async () => {
    const { svc, w } = await service();
    await expect(svc.submit("review-1", "absent")).rejects.toThrow();
    const p = await svc.preview("review-1");
    w.head = C;
    await expect(svc.submit("review-1", p.token)).rejects.toThrow("PR changed since preview");
    expect(w.posts).toBe(0);
  });

  it("serialize concurrent submits and send once", async () => {
    const { svc, w } = await service();
    const p = await svc.preview("review-1");
    const input = { id: "review-1", token: p.token };
    const [a, b] = await Promise.allSettled([call(svc, "reviews.submit", input), call(svc, "reviews.submit", input)]);
    expect([a.status, b.status]).toEqual(["fulfilled", "fulfilled"]);
    expect(w.posts).toBe(1);
  });

  it("update the pull list after submitting without waiting for the poll", async () => {
    const { svc } = await service();
    await svc.refresh();
    expect(svc.snapshot().mine[0].my_review).toBeNull();
    const p = await svc.preview("review-1");
    await call(svc, "reviews.submit", { id: "review-1", token: p.token });
    await vi.waitFor(() => expect(svc.snapshot().mine[0].my_review?.state).toBe("COMMENTED"));
  });

  it("reconcile an uncertain success without posting again", async () => {
    const { svc, w } = await service();
    w.uncertain = true;
    const p = await svc.preview("review-1");
    await expect(svc.submit("review-1", p.token)).rejects.toThrow("Submission outcome uncertain");
    expect(svc.get("review-1").status).toBe("uncertain");
    await expect(svc.submit("review-1", p.token)).rejects.toThrow();
    expect((await svc.reconcile("review-1")).status).toBe("submitted");
    expect(w.posts).toBe(1);
  });

  it("keep the draft editable after a definite rejection", async () => {
    const { svc, w } = await service();
    w.reject = true;
    const p = await svc.preview("review-1");
    await expect(svc.submit("review-1", p.token)).rejects.toThrow("HTTP 422");
    expect(svc.get("review-1").status).toBe("ready");
  });

  it("cannot post an old draft after an account switch", async () => {
    const { svc, w, gh } = await service();
    const p = await svc.preview("review-1");
    gh.login = "someone-else";
    await expect(svc.submit("review-1", p.token)).rejects.toThrow("GitHub account changed");
    expect(w.posts).toBe(0);
  });

  it("keep the original on a revision conflict", async () => {
    const { svc } = await service();
    const input = { id: "review-1", revision: 0, result: draft().result };
    await call(svc, "reviews.save", input);
    await expect(call(svc, "reviews.save", input)).rejects.toThrow("Reload before saving");
    expect(svc.get("review-1").revision).toBe(1);
  });

  it("keep history and hidden preferences across refreshes", async () => {
    const { svc, host } = await service();
    await call(svc, "pulls.hide", { id: "o/r#1", account: "github.com:alice" });
    await svc.refresh();
    expect(svc.snapshot().reviews.length).toBe(1);
    expect([...host.collections.get("hidden:github.com:alice")!.entries()]).toEqual([["o/r#1", true]]);
  });

  it("list authored pulls separately and hide them", async () => {
    const { svc } = await service();
    await svc.refresh();
    const inbox = svc.snapshot();
    expect(inbox.pulls).toEqual([]);
    expect(inbox.mine.length).toBe(1);
    expect(inbox.mine[0].id).toBe("o/r#1");
    expect(inbox.mine[0].review_decision).toBe("REVIEW_REQUIRED");
    expect(inbox.mine[0]).not.toHaveProperty("activity");
    await call(svc, "pulls.hide", { id: "o/r#1", account: "github.com:alice" });
    expect(svc.snapshot().mine[0].hidden).toBe(true);
    await svc.refresh();
    expect(svc.snapshot().mine[0].hidden).toBe(true);
  });

  it("show an expired login and ask nothing until it works", async () => {
    const { svc, host, gh } = await service();
    await svc.refresh();
    expect(svc.snapshot().mine.length).toBe(1);
    const before = gh.requests;
    gh.blockedBy = LOGIN_EXPIRED;
    await svc.refresh();
    await svc.refresh();
    expect(gh.requests).toBe(before);
    const inbox = svc.snapshot();
    expect(inbox.blocked).toBe(LOGIN_EXPIRED);
    expect(inbox.mine.length).toBe(1);
    expect(host.record.emitted.filter((e) => e.name === "reviews.changed").length).toBe(2);
    gh.blockedBy = null;
    await svc.refresh();
    expect(gh.requests).toBeGreaterThan(before);
    expect(svc.snapshot().blocked).toBeNull();
  });

  it("do not read an unchanged pull request again until a full refresh", async () => {
    const { svc, w } = await service();
    await svc.refresh();
    const reads = w.reads;
    await svc.refresh();
    expect(w.reads).toBe(reads);
    w.head = C;
    await svc.refresh();
    expect(w.reads).toBe(reads + 1);
    expect(svc.snapshot().mine[0].head_sha).toBe(C);
    await call(svc, "pulls.refresh", {});
    expect(w.reads).toBe(reads + 2);
  });

  it("read a closed linked pull request now and then to notice a reopen", async () => {
    const fake = world();
    const { w, gh } = fake;
    w.searches.authored = [];
    w.state = ["CLOSED", ""];
    const { svc, host, links } = await service(draft(), { fake });
    host.state.sessions = [session("linked")];
    links.prs.linked = ["https://github.com/o/r/pull/5"];
    await svc.refresh();
    expect(w.reads).toBe(1);
    await svc.refresh();
    expect(w.reads).toBe(1);

    gh.notifiedNow = new TestNotified({ "o/r#5": nowIso() });
    await svc.refresh();
    expect(w.reads).toBe(2);

    gh.notifiedNow = new TestNotified();
    const age = () => {
      for (const r of svc.reads.values()) r.time = new Date(Date.parse(r.time) - 31 * 60_000).toISOString();
    };
    age();
    w.state = ["OPEN", ""];
    await svc.refresh();
    expect(w.reads).toBe(3);
    expect(svc.reads.get("o/r#5")!.pull.state).toBe("open");

    w.state = ["MERGED", "bob"];
    gh.notifiedNow = null;
    await svc.refresh();
    expect(w.reads).toBe(4);
    age();
    await svc.refresh();
    expect(w.reads).toBe(4);
  });

  it("list requested, reviewed and authored pulls in one read", async () => {
    const fake = world();
    fake.w.searches = { requested: [2, 3], reviewed: [3, 4], authored: [1] };
    const { svc, w } = await service(draft(), { fake });
    await svc.refresh();
    expect(w.reads).toBe(1);
    const inbox = svc.snapshot();
    const numbers = (l: PullRequest[]) => l.map((p) => p.number);
    expect(numbers(inbox.pulls)).toEqual([2, 3]);
    expect(numbers(inbox.reviewed)).toEqual([4]);
    expect(numbers(inbox.mine)).toEqual([1]);
    await call(svc, "pulls.hide", { id: "o/r#4", account: "github.com:alice" });
    expect(svc.snapshot().reviewed[0].hidden).toBe(true);
  });

  it("keep the last copy of a pull request that fails to read", async () => {
    const fake = world();
    fake.w.searches = { requested: [2, 3], reviewed: [], authored: [1] };
    const { svc, w } = await service(draft(), { fake });
    await svc.refresh();
    w.unreadable = [3, 5];
    w.head = C;
    w.searches.requested = [2, 3, 5];
    await svc.refresh();
    const inbox = svc.snapshot();
    expect(inbox.pulls.map((p) => [p.number, p.head_sha])).toEqual([
      [2, C],
      [3, A],
    ]);
    expect(inbox.mine.length).toBe(1);
    expect(inbox.error).toBe("Unable to read o/r#3: Something went wrong\nUnable to read o/r#5: Something went wrong");
    w.unreadable = [];
    await svc.refresh();
    expect(svc.snapshot().pulls.length).toBe(3);
    expect(svc.snapshot().error).toBeNull();
  });

  it("review a frozen diff with the agent and remove the checkout", async () => {
    const { svc, workspace } = await service();
    await svc.change("review-1", (r) => void (r.status = "running"));
    await svc.execute("review-1");
    const r = svc.get("review-1");
    expect(r.status).toBe("ready");
    expect(r.diff).toBe(DIFF);
    expect(r.reviewed_sha).toBe(r.pull.head_sha);
    expect(r.result.comments[0].valid).toBe(true);
    expect(r.log_tail).toEqual(["Reading changed file"]);
    expect(workspace.written).toEqual(["/data/workspaces/review-x"]);
    expect(workspace.removed).toEqual(["/data/workspaces/review-x"]);
  });

  it("record the model that ran a finished review", async () => {
    const r = draft();
    r.agent = claudeAgent();
    const { svc } = await service(r);
    await svc.change("review-1", (r) => void (r.status = "running"));
    await svc.execute("review-1");
    const agent = svc.get("review-1").agent!;
    expect(agent.model_id).toBe("claude-opus-5-5");
    expect(signature(agent)).toBe("Claude Code · model opus (claude-opus-5-5) · effort high");
  });

  it("sign posted reviews and the agent's comments with the agent, model and effort", () => {
    const r = draft();
    r.agent = { ...claudeAgent(), model_id: "claude-opus-5-5" };
    r.result.comments.push({ ...r.result.comments[0], id: "mine", body: "My own note", user_authored: true });
    const preview = buildPreview(r, A);
    const sig = "Claude Code · model opus (claude-opus-5-5) · effort high";
    expect(preview.body).toContain(`Drafted by an AI agent with Aura and reviewed by a person before posting · ${sig}`);
    expect(preview.body.endsWith(`<!-- aura-review:${preview.token} -->`)).toBe(true);
    expect(preview.comments.find((c) => c.id === "c1")!.body).toBe(`Fix this\n\n<sub>🤖 AI agent · ${sig}</sub>`);
    expect(preview.comments.find((c) => c.id === "mine")!.body).toBe("My own note");
  });

  it("sign drafts from before agents were recorded from their config", () => {
    expect(buildPreview(draft(), A).body).toContain("Codex · model default model · effort default");
  });

  it("mark interrupted and uncertain jobs on restart", async () => {
    const r = draft();
    r.status = "running";
    expect((await service(r)).svc.get("review-1").status).toBe("failed");
    const s = draft();
    s.status = "submitting";
    expect((await service(s)).svc.get("review-1").status).toBe("uncertain");
  });

  it("do not let a cancelled review become ready after a late completion", async () => {
    let started!: () => void;
    let finish!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const finishP = new Promise<void>((r) => (finish = r));
    const runner: ReviewRunner = {
      run: async () => {
        started();
        await finishP;
        return { result: draft().result, model_id: null };
      },
    };
    const { svc, workspace } = await service(draft(), { runner });
    await svc.change("review-1", (r) => void (r.status = "running"));
    const task = svc.execute("review-1");
    await startedP;
    await call(svc, "reviews.cancel", { id: "review-1" });
    finish();
    await expect(task).rejects.toThrow("cancelled");
    expect(svc.get("review-1").status).toBe("cancelled");
    expect(workspace.removed.length).toBe(1);
  });

  it("review from the diff alone when the checkout fails, and say so", async () => {
    const { svc, workspace } = await service();
    workspace.fails = "Clone permission denied";
    await svc.change("review-1", (r) => void (r.status = "running"));
    await svc.execute("review-1");
    const r = svc.get("review-1");
    expect(r.context_mode).toBe("diff-only");
    expect(r.context_note).toContain("Clone permission denied");
    expect(r.status).toBe("ready");
  });

  it("do not fetch a new head under old findings when the review's diff is missing", async () => {
    const r = draft();
    r.diff = "";
    const { svc } = await service(r);
    const returned: any = await call(svc, "reviews.diff", { id: "review-1" });
    expect(returned.diff).toBe("");
    const preview = await svc.preview("review-1");
    expect(preview.comments).toEqual([]);
    expect(preview.body).toContain("Additional notes");
  });

  it("run a queued pre-review in a slot", async () => {
    const { svc } = await service();
    const r = await call(svc, "reviews.start", { repo: "o/r", number: 1, config: { provider: "claude", model: null, effort: null, prompt_mode: "default", prompt: "" } });
    expect((r as PreReview).status).toBe("queued");
    expect((r as PreReview).agent!.provider).toBe("Claude Code");
    expect(svc.state.defaults.provider).toBe("claude");
    await vi.waitFor(() => expect(svc.get((r as PreReview).id).status).toBe("ready"));
  });

  it("hold the timeline and the lists older apps read in a pull's detail", async () => {
    const { svc } = await service();
    const detail: any = await call(svc, "pulls.get", { repo: "o/r", number: 1, account: "github.com:alice" });
    expect(detail.timeline.commits).toBe(2);
    expect(detail.timeline.items[1].review_id).toBe(7);
    expect(detail.timeline.threads[0].review_id).toBe(7);
    expect(detail.comments[0].user.login).toBe("carol");
    expect(detail.reviews[0].state).toBe("APPROVED");
    expect(detail.threads[0].path).toBe("src/lib.rs");
    expect(detail.project_error).toBeNull();
    const cached = await call(svc, "pulls.cached", { id: "o/r#1", account: "github.com:alice" });
    expect(cached).toEqual(detail);
  });

  it("merge the shown head and delete the branch", async () => {
    const { svc, w } = await service();
    const merge = (method: string, sha: string, del: boolean) => ({ repo: "o/r", number: 1, account: "github.com:alice", method, sha, delete_branch: del });
    const pr = await svc.lookup({ repo: "o/r", number: 1 });
    expect(pr.merge_methods).toEqual(["squash", "rebase"]);
    expect(pr.default_merge_method).toBe("squash");
    expect(pr.can_merge && pr.can_delete_branch).toBe(true);
    expect(pr.merge_blocked_by).toBeNull();

    await expect(call(svc, "pulls.merge", merge("merge", A, true))).rejects.toThrow("does not allow merge");
    await expect(call(svc, "pulls.merge", merge("squash", C, true))).rejects.toThrow("New commits");
    w.mergeState = "BLOCKED";
    await expect(call(svc, "pulls.merge", merge("squash", A, true))).rejects.toThrow(/^A review is required$/);
    expect(w.writes).toEqual([]);

    w.mergeState = "CLEAN";
    const v: any = await call(svc, "pulls.merge", merge("squash", A, true));
    expect(v.branch_deleted).toBe(true);
    expect(w.writes).toEqual(["PUT repos/o/r/pulls/1/merge", "DELETE repos/o/r/git/refs/heads/feature"]);
    expect(w.merged).toEqual([["squash", A]]);
  });

  it("keep the branch unless asked", async () => {
    const { svc, w } = await service();
    const v: any = await call(svc, "pulls.merge", { repo: "o/r", number: 1, method: "squash", sha: A, delete_branch: false });
    expect(v.branch_deleted).toBe(false);
    expect(w.writes).toEqual(["PUT repos/o/r/pulls/1/merge"]);
  });

  it("put what changed in the inbox once, and mirror unread changes into Aura's inbox", async () => {
    const host = createTestHost({ id: "pull-requests" });
    const fake = world();
    const { w } = fake;
    w.searches = { requested: [2], reviewed: [], authored: [1] };
    const activity = () => {
      const out = host.record.emitted
        .filter((e) => e.name === "pulls.activity")
        .flatMap((e: any) => (e.payload.changes as PullChange[]).map((c) => [c.pull_id, c.summary]))
        .sort();
      host.record.emitted.length = 0;
      return out;
    };
    let { svc } = await service(null, { host, fake });
    await svc.refresh();
    expect(activity()).toEqual([]);
    expect(w.reads).toBe(1);

    w.head = C;
    await svc.refresh();
    expect(activity()).toEqual([
      ["o/r#1", "1 new commit"],
      ["o/r#2", "1 new commit"],
    ]);
    const entries = (await call(svc, "pulls.changes", {})) as PullChange[];
    expect(entries.length).toBe(2);
    expect(entries.map((e) => [e.number, e.role]).sort()).toEqual([
      [1, "authored"],
      [2, "requested"],
    ]);
    expect(host.record.inbox.map((i) => i.detail)).toEqual(["1 new commit", "1 new commit"]);
    expect(host.record.inbox[0]).toMatchObject({ unread: true, title: expect.stringMatching(/^o\/r#\d PR \d$/) });
    // Muted kinds stay in pulls.changes but leave Aura's inbox.
    await host.api.settings.set("pullChangesMuted", ["commits"]);
    await svc.publishInbox();
    expect(host.record.inbox).toEqual([]);
    await host.api.settings.set("pullChangesMuted", []);

    // A restarted daemon has nothing new to say.
    ({ svc } = await service(null, { host, fake }));
    await svc.refresh();
    expect(activity()).toEqual([]);

    await call(svc, "pulls.changes.read", { ids: [entries[0].id] });
    expect(((await call(svc, "pulls.changes", {})) as PullChange[]).filter((e) => e.read).length).toBe(1);
    expect(host.record.inbox.length).toBe(1);

    // #1 is merged by someone else: it leaves the search and is read once more in the same query.
    w.searches = { requested: [2], reviewed: [], authored: [] };
    w.state = ["MERGED", "bob"];
    const reads = w.reads;
    await svc.refresh();
    expect(w.reads).toBe(reads + 1);
    expect(activity()).toEqual([
      ["o/r#1", "merged by bob"],
      ["o/r#2", "merged by bob"],
    ]);
    await svc.refresh();
    expect(activity()).toEqual([]);
    await call(svc, "pulls.changes.read", {});
    expect(((await call(svc, "pulls.changes", {})) as PullChange[]).every((e) => e.read)).toBe(true);
    expect(host.record.inbox).toEqual([]);
  });
});

/** A service with an orchestrator, its Codex worker and a plain session. */
async function orchestrated(r = draft()) {
  const made = await service(r);
  const common = { model: "gpt-5.5", effort: "high" };
  made.host.state.sessions = [
    session("lead", { ...common, title: "Lead", orchestrator: true }),
    session("worker", { ...common, title: "Review 2730", provider: "codex", orchestrator_id: "lead" }),
    session("plain", { ...common, title: "Plain" }),
  ];
  return made;
}
const finding = (c: Partial<ReviewComment>) => comment(c);

describe("orchestrator reviews", () => {
  it("record a review ready for the user, signed by its worker", async () => {
    const { svc, host, w } = await orchestrated();
    const r = (await call(svc, "orchestrator.reviews.create", {
      orchestrator: "lead",
      pull: "o/r#1",
      worker: "Review 2730",
      verdict: "APPROVE",
      summary: "Looks right.",
      comments: [
        { path: "test.rs", line: 1, severity: "nit", body: "Name this better." },
        { path: "elsewhere.rs", line: 9, body: "Outside the diff." },
      ],
    })) as PreReview;
    expect([r.status, r.phase]).toEqual(["ready", "done"]);
    expect(r.result.verdict).toBe("approve");
    expect(r.result.risk).toBe("medium");
    expect(r.reviewed_sha).toBe(A);
    expect(r.context_mode).toBe("recorded");
    expect(r.diff).toBe(DIFF);
    const c = r.result.comments;
    expect([c[0].side, c[0].severity]).toEqual(["RIGHT", "nit"]);
    expect(c[0].valid && !c[0].user_authored && !c[0].edited && c[0].id !== "").toBe(true);
    expect(!c[1].valid && c[1].position_note !== null).toBe(true);
    expect([r.source!.orchestrator_title, r.source!.worker_title]).toEqual(["Lead", "Review 2730"]);
    expect(signature(r.agent!)).toBe("Codex · model gpt-5.5 · effort high");
    expect(host.record.emitted.map((e) => e.name)).toContain("reviews.changed");
    const listed: any = await call(svc, "orchestrator.reviews.list", { orchestrator: "lead" });
    expect([listed.reviews[0].id, listed.reviews[0].diff]).toEqual([r.id, ""]);
    expect(host.collections.get("reviews")!.has(r.id)).toBe(true);
    // Posting it stays the user's, through the same preview, signed by the worker's agent.
    const preview = await svc.preview(r.id);
    expect(preview.event).toBe("APPROVE");
    expect(preview.comments.length).toBe(1);
    expect(preview.body).toContain("Outside the diff.");
    expect(preview.body).toContain("Codex · model gpt-5.5 · effort high");
    expect(w.posts).toBe(0);
  });

  it("put the orchestrator's edits through the editor's checks and leave the user's findings alone", async () => {
    const { svc } = await orchestrated();
    const id = "review-1";
    const result = draft().result;
    result.comments.push(finding({ id: "mine", path: "test.rs", line: 1, side: "RIGHT", body: "My own note", severity: "minor" }));
    await call(svc, "reviews.save", { id, revision: 0, result });
    const edited = (await call(svc, "orchestrator.reviews.edit_comment", {
      orchestrator: "lead",
      review: id,
      comment: "c1",
      body: "Fix this, now",
      severity: "blocker",
    })) as PreReview;
    const c1 = edited.result.comments[0];
    expect([c1.body, c1.severity]).toEqual(["Fix this, now", "blocker"]);
    expect(c1.edited).toBe(false);
    expect(edited.revision).toBe(2);
    await expect(call(svc, "orchestrator.reviews.edit_comment", { orchestrator: "lead", review: id, comment: "mine", body: "Mine now" })).rejects.toThrow(
      "leave it to them",
    );
    await expect(call(svc, "orchestrator.reviews.delete_comment", { orchestrator: "lead", review: id, comment: "mine" })).rejects.toThrow();
    const deleted = (await call(svc, "orchestrator.reviews.delete_comment", { orchestrator: "lead", review: id, comment: "c1" })) as PreReview;
    expect(deleted.result.comments[0].deleted).toBe(true);
    const restored = (await call(svc, "orchestrator.reviews.delete_comment", { orchestrator: "lead", review: id, comment: "c1", restore: true })) as PreReview;
    expect(restored.result.comments[0].deleted).toBe(false);
    await expect(
      call(svc, "orchestrator.reviews.add_comment", { orchestrator: "lead", review: id, path: "test.rs", line: 1, body: "x", severity: "style" }),
    ).rejects.toThrow();
    const added: any = await call(svc, "orchestrator.reviews.add_comment", {
      orchestrator: "lead",
      review: id,
      path: "test.rs",
      line: 1,
      side: "left",
      body: "Was this needed?",
    });
    let r = added.review as PreReview;
    const fresh = r.result.comments.find((c) => c.id === added.comment)!;
    expect(fresh.valid && fresh.side === "LEFT" && fresh.severity === "minor").toBe(true);
    // A stale revision is refused rather than overwriting what changed since.
    await expect(call(svc, "orchestrator.reviews.update", { orchestrator: "lead", review: id, revision: 1, summary: "Stale" })).rejects.toThrow(
      "Read it again",
    );
    // New findings replace the agent's, never the user's.
    r = (await call(svc, "orchestrator.reviews.update", {
      orchestrator: "lead",
      review: id,
      revision: r.revision,
      verdict: "request_changes",
      risk: "high",
      comments: [{ path: "test.rs", line: 1, severity: "major", body: "Replaced" }],
    })) as PreReview;
    expect(r.result.comments.map((c) => c.body)).toEqual(["My own note", "Replaced"]);
    expect([r.result.verdict, r.result.risk]).toEqual(["request_changes", "high"]);
    // The user's window, still at the revision they saved, is told to reload.
    await expect(call(svc, "reviews.save", { id, revision: 1, result })).rejects.toThrow();
    // A finding of the agent's that the user deleted stays deleted.
    const mine = clone(r.result);
    const replaced = mine.comments.find((c) => c.body === "Replaced")!;
    replaced.deleted = true;
    r = (await call(svc, "reviews.save", { id, revision: r.revision, result: mine })) as PreReview;
    expect(r.result.comments.some((c) => c.id === replaced.id && c.deleted && c.edited)).toBe(true);
    await expect(
      call(svc, "orchestrator.reviews.delete_comment", { orchestrator: "lead", review: id, comment: replaced.id, restore: true }),
    ).rejects.toThrow();
  });

  it("let a draft being written reach the user once it is ready", async () => {
    const { svc } = await orchestrated();
    const r = (await call(svc, "orchestrator.reviews.create", {
      orchestrator: "lead",
      repo: "o/r",
      number: 1,
      verdict: "comment",
      summary: "Started",
      ready: false,
    })) as PreReview;
    expect(r.status).toBe("drafting");
    expect(r.agent!.provider).toBe("Claude Code");
    await expect(call(svc, "reviews.save", { id: r.id, revision: 0, result: r.result })).rejects.toThrow("not editable");
    await call(svc, "orchestrator.reviews.add_comment", { orchestrator: "lead", review: r.id, path: "test.rs", line: 1, body: "Second thought" });
    const ready = (await call(svc, "orchestrator.reviews.update", { orchestrator: "lead", review: r.id, summary: "Done", ready: true })) as PreReview;
    expect([ready.status, ready.result.summary]).toEqual(["ready", "Done"]);
    await expect(call(svc, "orchestrator.reviews.update", { orchestrator: "lead", review: r.id, ready: false })).rejects.toThrow();
    // The user can take over a draft an orchestrator left unfinished.
    const other = (await call(svc, "orchestrator.reviews.create", {
      orchestrator: "lead",
      pull: "o/r#1",
      verdict: "comment",
      summary: "Left",
      ready: false,
    })) as PreReview;
    expect(((await call(svc, "reviews.ready", { id: other.id })) as PreReview).status).toBe("ready");
    const discarded = (await call(svc, "orchestrator.reviews.discard", { orchestrator: "lead", review: other.id })) as PreReview;
    expect(discarded.status).toBe("discarded");
    await expect(call(svc, "orchestrator.reviews.update", { orchestrator: "lead", review: other.id, summary: "Too late" })).rejects.toThrow();
  });

  it("are for orchestrators only, and a review needs content", async () => {
    const { svc } = await orchestrated();
    for (const who of ["plain", "worker", "nobody"]) {
      await expect(call(svc, "orchestrator.reviews.list", { orchestrator: who })).rejects.toThrow();
    }
    await expect(call(svc, "orchestrator.reviews.list", {})).rejects.toThrow();
    await expect(call(svc, "orchestrator.reviews.create", { orchestrator: "lead", pull: "o/r#1", verdict: "approve" })).rejects.toThrow("summary");
    await expect(
      call(svc, "orchestrator.reviews.create", { orchestrator: "lead", pull: "o/r#1", verdict: "approve", summary: "x", worker: "Nobody" }),
    ).rejects.toThrow("no worker");
    const got: any = await call(svc, "orchestrator.reviews.get", { orchestrator: "lead", pull: "o/r#1" });
    expect(got.pull.id).toBe("o/r#1");
    expect(got.reviews[0].id).toBe("review-1");
    const full = (await call(svc, "orchestrator.reviews.get", { orchestrator: "lead", review: "review-1" })) as PreReview;
    expect(full.diff).toBe(DIFF);
  });

  it("start Aura's own pre-review without changing the user's defaults", async () => {
    const { svc, host } = await orchestrated();
    host.api.agents.providers = async () => [];
    await expect(call(svc, "orchestrator.reviews.start", { orchestrator: "lead", pull: "o/r#1", agent: "codex" })).rejects.toThrow(
      "Selected provider is unavailable",
    );
    expect(svc.state.defaults.provider).toBe("codex");
    const inbox = await call(svc, "orchestrator.reviews.hide", { orchestrator: "lead", pull: "o/r#1" });
    expect(typeof inbox).toBe("object");
    expect([...host.collections.get("hidden:github.com:alice")!.entries()]).toEqual([["o/r#1", true]]);
    await call(svc, "orchestrator.reviews.hide", { orchestrator: "lead", pull: "o/r#1", hidden: false });
    expect([...host.collections.get("hidden:github.com:alice")!.entries()]).toEqual([["o/r#1", false]]);
  });
});

describe("the daemon half", () => {
  it("serves every former method and tool, and stops its loops", async () => {
    const host = createTestHost({ id: "pull-requests" });
    host.provideMod("github", new TestLinks().serve);
    const { gh, lib } = world();
    host.state.sessions = [session("lead", { orchestrator: true })];
    const m = await start(host.api, { gh, lib, workspace: new MockWorkspace(), runner: new MockRunner(), loops: false });
    running.push(m.tasks);
    for (const name of [
      "github.status",
      "pulls.list",
      "reviews.list",
      "pulls.changes",
      "pulls.changes.read",
      "reviews.defaults",
      "pulls.refresh",
      "pulls.hide",
      "pulls.restore",
      "pulls.get",
      "pulls.cached",
      "pulls.diff",
      "pulls.options",
      "pulls.update",
      "pulls.addComment",
      "pulls.merge",
      "pulls.setField",
      "reviews.start",
      "reviews.get",
      "reviews.diff",
      "reviews.cancel",
      "reviews.discard",
      "reviews.ready",
      "reviews.save",
      "reviews.preview",
      "reviews.submit",
      "reviews.reconcile",
      "orchestrator.reviews.list",
      "orchestrator.reviews.get",
      "orchestrator.reviews.create",
      "orchestrator.reviews.update",
      "orchestrator.reviews.add_comment",
      "orchestrator.reviews.edit_comment",
      "orchestrator.reviews.delete_comment",
      "orchestrator.reviews.discard",
      "orchestrator.reviews.start",
      "orchestrator.reviews.hide",
      "watches.list",
      "watches.candidates",
      "watches.start",
      "watches.remove",
      "watches.check",
    ]) {
      expect(host.handled()).toContain(name);
    }
    expect(host.tools().map((t) => t.name)).toEqual([...NAMES]);
    const text = await host.tool("list_pull_requests", { refresh: true }, "lead");
    expect(text).toContain("The user's pull requests on GitHub as github.com:alice");
    expect(await host.call("reviews.defaults")).toMatchObject({ config: { provider: "codex" } });
    await expect(host.tool("list_pull_requests", {}, "nobody")).rejects.toThrow();
    m.stop();
    expect(host.handled()).toEqual([]);
  });
});
