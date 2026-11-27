import { describe, expect, it } from "vitest";
import { createTestHost } from "@aura/mod-sdk/testing";
import type { Github } from "@aura/github-client";
import { activate } from "../daemon";
import type { MergeResult, SessionView } from "../shared/types";
import { fakeGithub, prNode, session } from "../test/fixtures";
import { mergeDefaults, Merger, mergeRequest, type MergeRequest } from "./merge";

const SHA = "a".repeat(40);
const req = (over: Partial<MergeRequest> = {}): MergeRequest => ({
  repo: "acme/api", number: 7, sha: SHA, title: "Add limits (#7)", message: "* one\n\n* two", deleteBranch: false, ...over,
});
const same = { headRef: "feature/limits", sameRepo: true };

/** A transport that records writes and answers them from `answer`. Nothing reaches GitHub. */
function writes(answer: (method: string, path: string, body?: any) => unknown = () => ({ merged: true, sha: "b".repeat(40) })) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const gh = {
    request: async (method: string, path: string, body?: any) => {
      calls.push({ method, path, body });
      const out = answer(method, path, body);
      if (out instanceof Error) throw out;
      return out;
    },
  } as unknown as Github;
  return { gh, calls };
}

describe("Merger", () => {
  it("squash-merges at the head commit the card showed, with the title and message", async () => {
    const { gh, calls } = writes();
    const result = await new Merger(gh).merge(req(), same);
    expect(calls).toEqual([{
      method: "PUT", path: "repos/acme/api/pulls/7/merge",
      body: { merge_method: "squash", commit_title: "Add limits (#7)", commit_message: "* one\n\n* two", sha: SHA },
    }]);
    expect(result).toEqual({ merged: true, sha: "b".repeat(40), branchDeleted: false, branchError: null });
  });

  it.each([
    [405, "Pull Request is not mergeable", "not_mergeable", "GitHub refused the merge: Pull Request is not mergeable"],
    [409, "Head branch was modified. Review and try the merge again.", "head_moved", "New commits arrived since this card was read"],
    [403, "Resource not accessible by integration", "forbidden", "You don't have permission to merge"],
    [405, "Changes must be made through the merge queue", "merge_queue", "merges through a merge queue"],
    [422, "Invalid request.", "invalid", "GitHub did not accept the merge"],
    [502, "Bad gateway", "failed", "The merge failed: Bad gateway"],
  ])("maps HTTP %i (%s) to %s, keeping GitHub's message", async (status, said, code, text) => {
    const { gh } = writes(() => new Error(`${said} (HTTP ${status})`));
    const error = await new Merger(gh).merge(req(), same).catch((e) => e);
    expect(error).toMatchObject({ code });
    expect(error.message).toContain(text);
    expect(error.message).toContain(said);
  });

  it("does not take an answer without `merged: true` as a merge", async () => {
    const { gh } = writes(() => ({ merged: false, message: "Base branch was modified" }));
    await expect(new Merger(gh).merge(req(), same)).rejects.toMatchObject({ code: "not_mergeable", message: "GitHub did not merge: Base branch was modified" });
  });

  it("refuses a second merge of the same PR while one runs, and allows it after", async () => {
    const pending: Array<() => void> = [];
    const { gh, calls } = writes(() => new Promise((r) => pending.push(() => r({ merged: true, sha: "c" }))));
    const merger = new Merger(gh);
    const first = merger.merge(req(), same);
    await expect(merger.merge(req(), same)).rejects.toMatchObject({ code: "busy" });
    expect(calls).toHaveLength(1);
    // Another PR is not held up.
    void merger.merge(req({ number: 8 }), same);
    expect(calls).toHaveLength(2);
    pending.splice(0).forEach((release) => release());
    await first;
    const again = merger.merge(req(), same);
    pending.splice(0).forEach((release) => release());
    await again;
    expect(calls.filter((c) => c.path === "repos/acme/api/pulls/7/merge")).toHaveLength(2);
  });

  it("deletes the head branch only when asked, after a merge, and only in the same repository", async () => {
    const deletes = (calls: Array<{ method: string }>) => calls.filter((c) => c.method === "DELETE");

    let w = writes();
    expect(await new Merger(w.gh).merge(req({ deleteBranch: true }), same)).toMatchObject({ branchDeleted: true, branchError: null });
    expect(deletes(w.calls)).toEqual([{ method: "DELETE", path: "repos/acme/api/git/refs/heads/feature/limits", body: undefined }]);

    w = writes();
    await new Merger(w.gh).merge(req({ deleteBranch: false }), same);
    expect(deletes(w.calls)).toEqual([]);

    w = writes();
    expect(await new Merger(w.gh).merge(req({ deleteBranch: true }), { headRef: "feature/limits", sameRepo: false }))
      .toMatchObject({ branchDeleted: false, branchError: "The branch is in a fork; it was left alone" });
    expect(deletes(w.calls)).toEqual([]);

    w = writes();
    expect(await new Merger(w.gh).merge(req({ deleteBranch: true }), null)).toMatchObject({ branchDeleted: false });
    expect(deletes(w.calls)).toEqual([]);

    w = writes(() => new Error("Pull Request is not mergeable (HTTP 405)"));
    await new Merger(w.gh).merge(req({ deleteBranch: true }), same).catch(() => {});
    expect(deletes(w.calls)).toEqual([]);
  });

  it("counts a branch GitHub already deleted as deleted, and reports one it could not delete", async () => {
    let w = writes((m) => (m === "DELETE" ? new Error("Reference does not exist (HTTP 422)") : { merged: true, sha: "d" }));
    expect(await new Merger(w.gh).merge(req({ deleteBranch: true }), same)).toMatchObject({ branchDeleted: true });
    w = writes((m) => (m === "DELETE" ? new Error("Protected branch (HTTP 422)") : { merged: true, sha: "d" }));
    expect(await new Merger(w.gh).merge(req({ deleteBranch: true }), same)).toMatchObject({ merged: true, branchDeleted: false, branchError: "Protected branch" });
  });
});

describe("mergeRequest", () => {
  it("checks the parameters", () => {
    expect(mergeRequest({ ...req(), title: "  T  ", deleteBranch: "yes" })).toEqual({ ...req(), title: "T", deleteBranch: false });
    expect(() => mergeRequest({ ...req(), sha: "abc" })).toThrow(/sha/);
    expect(() => mergeRequest({ ...req(), repo: "acme" })).toThrow(/repo/);
    expect(() => mergeRequest({ ...req(), number: 0 })).toThrow(/number/);
    expect(() => mergeRequest({ ...req(), title: " " })).toThrow(/title/);
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
  it("deletes the head branch the daemon read, not one the caller names", async () => {
    const host = createTestHost({ id: "pr-status" });
    const fake = fakeGithub({ 1: prNode({ number: 1 }) });
    const writes: string[] = [];
    const request = fake.gh.request.bind(fake.gh);
    fake.gh.request = async (method, path, body) => {
      if (method === "POST") return request(method, path, body);
      writes.push(`${method} ${path}`);
      return method === "PUT" ? { merged: true, sha: "e" } : null;
    };
    host.state.sessions = [session("lead")];
    host.provideMod("github", (name) => (name === "sessions.prs" ? { lead: ["https://github.com/acme/api/pull/1"] } : name === "links.all" ? {} : null));
    const { dispose } = activate(host.api, { gh: fake.gh, loop: false });
    await host.call<SessionView>("watch", { viewer: "v", sessionId: "lead", refresh: true });
    const result = await host.call<MergeResult>("merge", { repo: "acme/api", number: 1, sha: "f".repeat(40), title: "T", message: "", deleteBranch: true, headRef: "main", sameRepo: true });
    expect(result).toMatchObject({ merged: true, branchDeleted: true });
    expect(writes).toEqual(["PUT repos/acme/api/pulls/1/merge", "DELETE repos/acme/api/git/refs/heads/feature/news"]);
    dispose();
  });
});
