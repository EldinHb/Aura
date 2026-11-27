import { describe, expect, it } from "vitest";
import { createTestHost } from "@aura/mod-sdk/testing";
import { RateLimited, RejectedRequest } from "@aura/github-client";
import { activate } from "../daemon";
import type { MergeResult, SessionView } from "../shared/types";
import { fakeGithub, prNode, run, session } from "../test/fixtures";
import { mergeDefaults, Merger, mergeRequest, type MergeRequest } from "./merge";

const SHA = "f".repeat(40);
const ME = "github.com:eldin";
const req = (over: Partial<MergeRequest> = {}): MergeRequest => ({
  repo: "acme/api", number: 7, sha: SHA, account: ME, title: "Add limits (#7)", message: "* one\n\n* two", deleteBranch: false, ...over,
});
const approved = (over: Parameters<typeof prNode>[0] = {}) => prNode({ number: 7, reviewDecision: "APPROVED", ...over });

/**
 * A transport where every request of a merge must go through `requestFor` as the signed-in
 * account: the PR is read again from `node`, writes are answered by `write`. Nothing reaches GitHub.
 */
function transport(node = approved(), write: (method: string, path: string, body?: any) => unknown = () => ({ merged: true, sha: "b".repeat(40) })) {
  const fake = fakeGithub({ 7: node });
  const calls: Array<{ account: string; method: string; path: string; body?: any }> = [];
  const state = { signedIn: ME };
  const read = fake.gh.request.bind(fake.gh);
  fake.gh.request = async (method, path) => {
    throw new Error(`unpinned ${method} ${path}`);
  };
  fake.gh.requestFor = async (account, method, path, body) => {
    calls.push({ account, method, path, body });
    if (account !== state.signedIn) throw new RejectedRequest("GitHub account changed");
    if (method === "POST" && path === "graphql") return read(method, path, body);
    const out = await write(method, path, body);
    if (out instanceof Error) throw out;
    return out;
  };
  const writes = () => calls.filter((c) => c.method !== "POST").map((c) => `${c.method} ${c.path}`);
  return { gh: fake.gh, fake, calls, writes, state };
}

describe("Merger", () => {
  it("re-reads the PR and squash-merges as the account shown, at the head commit shown", async () => {
    const t = transport();
    const result = await new Merger(t.gh).merge(req());
    expect(t.calls.map((c) => [c.account, c.method])).toEqual([[ME, "POST"], [ME, "PUT"]]);
    expect(t.calls[1]).toEqual({
      account: ME, method: "PUT", path: "repos/acme/api/pulls/7/merge",
      body: { merge_method: "squash", commit_title: "Add limits (#7)", commit_message: "* one\n\n* two", sha: SHA },
    });
    expect(result).toEqual({ merged: true, sha: "b".repeat(40), branchDeleted: false, branchError: null });
  });

  it("refuses when GitHub's head moved since, read right before the write (review 4, item 1)", async () => {
    const node = approved();
    node.headRefOid = "e".repeat(40);
    const t = transport(node);
    await expect(new Merger(t.gh).merge(req())).rejects.toMatchObject({ code: "head_moved" });
    expect(t.writes()).toEqual([]);
  });

  it.each([
    ["blocked by branch protection", approved({ mergeStateStatus: "BLOCKED" }), "Blocked by branch protection"],
    ["checks failing", approved({ mergeStateStatus: "UNSTABLE", checks: [run("test", "FAILURE")] }), "Checks failing"],
    ["no longer approved", approved({ reviewDecision: "REVIEW_REQUIRED" }), "no longer open and approved"],
    ["mergeability unknown", approved({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }), "still checking"],
    ["closed", approved({ state: "CLOSED" }), "no longer open and approved"],
  ])("refuses a PR that is %s when re-read (review 4, item 2)", async (_what, node, why) => {
    const t = transport(node);
    const error = await new Merger(t.gh).merge(req()).catch((e) => e);
    expect(error).toMatchObject({ code: "not_eligible" });
    expect(error.message).toContain(why);
    expect(t.writes()).toEqual([]);
  });

  it("has no admin bypass: without write access it does not merge (review 4, item 2)", async () => {
    const t = transport();
    t.fake.state.repo = { squashMergeAllowed: true, viewerPermission: "READ" };
    await expect(new Merger(t.gh).merge(req())).rejects.toMatchObject({ code: "not_eligible", message: expect.stringContaining("permission") });
    expect(t.writes()).toEqual([]);
  });

  it("does not merge or delete as another account than the one shown (review 4, item 3)", async () => {
    let t = transport();
    t.state.signedIn = "github.com:someone-else";
    await expect(new Merger(t.gh).merge(req({ deleteBranch: true }))).rejects.toMatchObject({ code: "account" });
    expect(t.writes()).toEqual([]);
    // The account changes between the merge and the deletion: the branch stays.
    t = transport(approved(), () => {
      t.state.signedIn = "github.com:someone-else";
      return { merged: true, sha: "b" };
    });
    const result = await new Merger(t.gh).merge(req({ deleteBranch: true }));
    expect(result).toMatchObject({ merged: true, branchDeleted: false });
    expect(t.calls.filter((c) => c.method === "DELETE").map((c) => c.account)).toEqual([ME]);
  });

  it.each([
    [405, "Pull Request is not mergeable", "not_mergeable", "GitHub refused the merge: Pull Request is not mergeable"],
    [409, "Head branch was modified. Review and try the merge again.", "head_moved", "New commits were pushed — review again"],
    [403, "Resource not accessible by integration", "forbidden", "You don't have permission to merge"],
    [405, "Changes must be made through the merge queue", "merge_queue", "merges through a merge queue"],
    [422, "Invalid request.", "invalid", "GitHub did not accept the merge"],
    [502, "Bad gateway", "failed", "The merge failed: Bad gateway"],
  ])("maps HTTP %i (%s) to %s, keeping GitHub's message", async (status, said, code, text) => {
    const t = transport(approved(), () => new Error(`${said} (HTTP ${status})`));
    const error = await new Merger(t.gh).merge(req()).catch((e) => e);
    expect(error).toMatchObject({ code });
    expect(error.message).toContain(text);
    expect(error.message).toContain(said);
  });

  it("tells a rate limit from a missing permission, with when to retry (review 4, item 4)", async () => {
    let t = transport(approved(), () => new RateLimited("API rate limit exceeded for user (HTTP 403)", 150_000, true));
    let error = await new Merger(t.gh).merge(req()).catch((e) => e);
    expect(error).toMatchObject({ code: "rate_limited" });
    expect(error.message).toContain("try again in about 3 min");
    expect(error.message).not.toContain("permission");
    // As it arrives over RPC from the github mod: a plain error with data.kind.
    t = transport(approved(), () => Object.assign(new Error("You have exceeded a secondary rate limit (HTTP 403)"), { data: { kind: "rate_limited", waitMs: null } }));
    error = await new Merger(t.gh).merge(req()).catch((e) => e);
    expect(error).toMatchObject({ code: "rate_limited", message: expect.stringContaining("try again later") });
  });

  it("does not take an answer without `merged: true` as a merge", async () => {
    const t = transport(approved(), () => ({ merged: false, message: "Base branch was modified" }));
    await expect(new Merger(t.gh).merge(req())).rejects.toMatchObject({ code: "not_mergeable", message: "GitHub did not merge: Base branch was modified" });
  });

  it("refuses a second merge of the same PR while one runs, and allows it after", async () => {
    const pending: Array<() => void> = [];
    const t = transport(approved(), () => new Promise((r) => pending.push(() => r({ merged: true, sha: "c" }))));
    const merger = new Merger(t.gh);
    const first = merger.merge(req());
    await expect(merger.merge(req())).rejects.toMatchObject({ code: "busy" });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.writes()).toEqual(["PUT repos/acme/api/pulls/7/merge"]);
    pending.splice(0).forEach((release) => release());
    await first;
    const again = merger.merge(req());
    await new Promise((r) => setTimeout(r, 0));
    pending.splice(0).forEach((release) => release());
    await again;
    expect(t.writes()).toHaveLength(2);
  });

  it("deletes the head branch only when asked, after a merge, and only in the same repository", async () => {
    let t = transport();
    expect(await new Merger(t.gh).merge(req({ deleteBranch: true }))).toMatchObject({ branchDeleted: true, branchError: null });
    expect(t.writes()).toEqual(["PUT repos/acme/api/pulls/7/merge", "DELETE repos/acme/api/git/refs/heads/feature/news"]);

    t = transport();
    await new Merger(t.gh).merge(req({ deleteBranch: false }));
    expect(t.writes()).toEqual(["PUT repos/acme/api/pulls/7/merge"]);

    t = transport(approved({ fork: true }));
    expect(await new Merger(t.gh).merge(req({ deleteBranch: true }))).toMatchObject({ branchDeleted: false, branchError: "The branch is in a fork; it was left alone" });
    expect(t.writes()).toEqual(["PUT repos/acme/api/pulls/7/merge"]);

    t = transport(approved(), () => new Error("Pull Request is not mergeable (HTTP 405)"));
    await new Merger(t.gh).merge(req({ deleteBranch: true })).catch(() => {});
    expect(t.writes()).toEqual(["PUT repos/acme/api/pulls/7/merge"]);
  });

  it("counts a branch GitHub already deleted as deleted, and reports one it could not delete", async () => {
    let t = transport(approved(), (m) => (m === "DELETE" ? new Error("Reference does not exist (HTTP 422)") : { merged: true, sha: "d" }));
    expect(await new Merger(t.gh).merge(req({ deleteBranch: true }))).toMatchObject({ branchDeleted: true });
    t = transport(approved(), (m) => (m === "DELETE" ? new Error("Protected branch (HTTP 422)") : { merged: true, sha: "d" }));
    expect(await new Merger(t.gh).merge(req({ deleteBranch: true }))).toMatchObject({ merged: true, branchDeleted: false, branchError: "Protected branch" });
  });
});

describe("mergeRequest", () => {
  it("checks the parameters, the account included", () => {
    expect(mergeRequest({ ...req(), title: "  T  ", deleteBranch: "yes" })).toEqual({ ...req(), title: "T", deleteBranch: false });
    expect(() => mergeRequest({ ...req(), sha: "abc" })).toThrow(/sha/);
    expect(() => mergeRequest({ ...req(), repo: "acme" })).toThrow(/repo/);
    expect(() => mergeRequest({ ...req(), number: 0 })).toThrow(/number/);
    expect(() => mergeRequest({ ...req(), title: " " })).toThrow(/title/);
    expect(() => mergeRequest({ ...req(), account: "" })).toThrow(/account/);
  });
});

describe("mergeDefaults", () => {
  const repo = (setting: string, commits: string[], body = "The PR body") =>
    ({ squashMergeCommitMessage: setting, pullRequest: { title: "Add limits", body, commits: { nodes: commits.map((message) => ({ commit: { message } })) } } });

  it("suggests GitHub's squash commit for the repository's setting", () => {
    expect(mergeDefaults(repo("COMMIT_MESSAGES", ["Add limiter", "Fix tests\n\nThey were flaky"]), 7))
      .toEqual({ title: "Add limits (#7)", message: "* Add limiter\n\n* Fix tests\n\nThey were flaky" });
    expect(mergeDefaults(repo("COMMIT_MESSAGES", ["Add limiter\n\nPer plan and key."]), 7)).toEqual({ title: "Add limits (#7)", message: "Per plan and key." });
    expect(mergeDefaults(repo("PR_BODY", ["x"]), 7).message).toBe("The PR body");
    expect(mergeDefaults(repo("BLANK", ["x"]), 7).message).toBe("");
  });
});

describe("the merge RPC", () => {
  it("merges at the head the daemon read, as the account that read it", async () => {
    const host = createTestHost({ id: "pr-status" });
    const t = transport(approved());
    t.state.signedIn = "github.com:me";
    t.gh.account = async () => "github.com:me";
    // The poller reads with plain requests (the fake's GraphQL); the merge must use requestFor.
    const pinned = t.gh.requestFor;
    const reader = fakeGithub({ 7: approved() });
    t.gh.request = reader.gh.request;
    host.state.sessions = [session("lead")];
    host.process.route((bin) => (bin === "git" ? { code: 128, stderr: "not a git repository" } : undefined));
    const { dispose } = activate(host.api, { gh: { ...t.gh, requestFor: pinned }, loop: false });
    await host.call("links.add", { sessionId: "lead", url: "https://github.com/acme/api/pull/7" });
    const view = await host.call<SessionView>("watch", { viewer: "v", sessionId: "lead", refresh: true });
    expect(view.pulls[0].status?.merge).toMatchObject({ account: "github.com:me", headSha: SHA });
    // A head GitHub does not have now is refused by the fresh read, not by the card's copy.
    await expect(host.call("merge", { ...req(), account: "github.com:me", sha: "e".repeat(40) })).rejects.toMatchObject({ code: "head_moved" });
    expect(t.writes()).toEqual([]);
    const result = await host.call<MergeResult>("merge", { ...req(), account: "github.com:me", deleteBranch: true });
    expect(result).toMatchObject({ merged: true, branchDeleted: true });
    expect(t.writes()).toEqual(["PUT repos/acme/api/pulls/7/merge", "DELETE repos/acme/api/git/refs/heads/feature/news"]);
    expect(new Set(t.calls.map((c) => c.account))).toEqual(new Set(["github.com:me"]));
    dispose();
  });

  it("lets the fresh read decide: an older card copy of the head does not refuse a confirmed merge (review 5, item 2)", async () => {
    const host = createTestHost({ id: "pr-status" });
    const NEW = "b".repeat(40);
    const fresh = approved();
    fresh.headRefOid = NEW;
    const t = transport(fresh);
    t.state.signedIn = "github.com:me";
    // The cards read head f… earlier; GitHub has b… now, and the user confirmed b… on the page.
    const reader = fakeGithub({ 7: approved() });
    const pinned = t.gh.requestFor;
    host.state.sessions = [session("lead")];
    host.process.route((bin) => (bin === "git" ? { code: 128, stderr: "not a git repository" } : undefined));
    const { dispose } = activate(host.api, { gh: { ...reader.gh, account: async () => "github.com:me", requestFor: pinned }, loop: false });
    await host.call("links.add", { sessionId: "lead", url: "https://github.com/acme/api/pull/7" });
    const view = await host.call<SessionView>("watch", { viewer: "v", sessionId: "lead", refresh: true });
    expect(view.pulls[0].status?.merge.headSha).toBe(SHA);
    const result = await host.call<MergeResult>("merge", { ...req(), account: "github.com:me", sha: NEW });
    expect(result).toMatchObject({ merged: true });
    expect(t.calls.find((c) => c.method === "PUT")?.body).toMatchObject({ sha: NEW });
    dispose();
  });
});
