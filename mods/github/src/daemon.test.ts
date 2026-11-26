import { beforeEach, describe, expect, it } from "vitest";
import { createTestHost, type TestHost } from "@aura/mod-sdk/testing";
import { RateLimited, RejectedRequest, remoteGithub, reviveError } from "@aura/github-client";
import { activate } from "./daemon";
import { parseGithubRemote } from "./daemon/repo";
import type { GhTransport } from "./daemon/transport";

let host: TestHost;
let gh: GhTransport;
const session = (id: string) => ({ id, title: id, cwd: `/work/${id}` }) as never;

beforeEach(() => {
  host = createTestHost({ id: "github" });
  host.process.route((bin) => (bin === "gh" ? { stdout: "gho_token\n" } : undefined));
  gh = activate(host.api);
  host.state.sessions = [session("a"), session("b"), session("c")];
});

describe("the transport over RPC", () => {
  it("serves requests, and refusals keep their kind", async () => {
    host.http.route((r) => (r.url.endsWith("/user") ? { body: { login: "me" } } : r.url.includes("missing") ? { status: 404, body: { message: "Not Found" } } : undefined));
    expect(await host.call("api.request", { method: "GET", path: "user" })).toEqual({ login: "me" });
    expect(await host.call("api.account")).toBe("github.com:me");
    expect(await host.call("api.blocked")).toBeNull();
    expect(await host.call("api.pace", { baseMs: 1000 })).toBe(1000);
    const e = await host.call("api.request", { method: "GET", path: "repos/o/missing" }).catch((e) => e);
    expect([e.code, e.data, e.message]).toEqual(["rejected", { kind: "rejected" }, "Not Found (HTTP 404)"]);
    expect(reviveError(e)).toBeInstanceOf(RejectedRequest);
    await expect(host.call("api.request", { path: "user" })).rejects.toMatchObject({ code: "invalid" });
  });

  it("is what remoteGithub talks to", async () => {
    host.http.route((r) => (r.url.endsWith("/graphql") ? { body: { data: { ok: JSON.parse(r.body!).variables.x } } } : { status: 404, body: { message: "Not Found" } }));
    const remote = remoteGithub((name, params) => host.call(name, params));
    expect(await remote.request("POST", "graphql", { query: "query{x}", variables: { x: 1 } })).toEqual({ data: { ok: 1 } });
    await expect(remote.request("GET", "repos/o/r")).rejects.toBeInstanceOf(RejectedRequest);
  });

  it("tells other mods about a rate limit and the pause after it", async () => {
    host.http.route(() => ({ status: 403, headers: { "retry-after": "60" }, body: { message: "You have exceeded a secondary rate limit" } }));
    const remote = remoteGithub((name, params) => host.call(name, params));
    const e = await remote.request("GET", "user").catch((e) => e);
    expect(e).toBeInstanceOf(RateLimited);
    expect([e.waitMs, e.resourceOnly]).toEqual([60_000, false]);
    expect(gh.gate.paused()).not.toBeNull();
    expect(await remote.blocked()).toMatch(/^GitHub rate limit reached; Aura resumes GitHub requests at \d\d:\d\d:\d\d$/);
    await expect(remote.request("GET", "user"), "refused unsent while paused").rejects.toBeInstanceOf(RejectedRequest);
    expect(host.record.http).toHaveLength(1);
  });

  it("passes notifications on as JSON", async () => {
    host.http.route(() => ({ body: [{ updated_at: "2026-10-26T10:00:00Z", subject: { type: "PullRequest", url: "https://api.github.com/repos/o/r/pulls/1" } }] }));
    const remote = remoteGithub((name, params) => host.call(name, params));
    const n = await remote.notified();
    expect(n?.changed("o/r", 1, "2026-10-26T09:00:00Z")).toBe(true);
  });
});

describe("reads for the UI", () => {
  it("lists issues and the PR of a branch", async () => {
    host.http.route((r) => {
      const q: string = JSON.parse(r.body!).query;
      if (q.includes("issues(states:OPEN")) {
        return { body: { data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [{ number: 1, title: "Bug", url: "https://github.com/o/r/issues/1", repository: { nameWithOwner: "o/r" } }] } } } } };
      }
      return { body: { data: { repository: { pullRequests: { nodes: [{ number: 4, title: "PR", url: "https://github.com/o/r/pull/4", state: "OPEN", headRepository: { nameWithOwner: "o/r" } }] } } } } };
    });
    expect(await host.call("issues", { repo: "o/r" })).toEqual([{ number: 1, title: "Bug", url: "https://github.com/o/r/issues/1", assignees: [], sprint: null, updated_at: "" }]);
    expect(await host.call("branch_pull", { repo: "o/r", head_repo: "o/r", branch: "feature" })).toMatchObject({ number: 4, state: "open", reviews: [] });
    await expect(host.call("issues", {})).rejects.toMatchObject({ code: "invalid", message: "repo is required" });
  });

  it("finds a folder's GitHub repository the way gh does", async () => {
    host.api.git.remotes = async (cwd) =>
      cwd === "/fork"
        ? [{ name: "origin", url: "git@github.com:me/repo.git" }, { name: "upstream", url: "https://github.com/owner/repo.git" }]
        : [{ name: "origin", url: "https://gitlab.com/o/r.git" }];
    expect(await host.call("repo", { cwd: "/fork" })).toBe("owner/repo");
    expect(await host.call("repo", { cwd: "/elsewhere" })).toBeNull();
    host.api.git.repoRoot = async () => {
      throw Object.assign(new Error("not a git repository"), { code: "failed" });
    };
    expect(await host.call("repo", { cwd: "/fork" }), "not a repository").toBeNull();
  });
});

it("parses GitHub remotes in every form", () => {
  for (const url of [
    "https://github.com/owner/repo.git",
    "https://github.com/owner/repo",
    "https://github.com/owner/repo/",
    "https://token@github.com/owner/repo.git",
    "git@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo.git",
  ]) expect(parseGithubRemote(url), url).toBe("owner/repo");
  expect(parseGithubRemote("git@github.com:my.org/my-repo_2.git")).toBe("my.org/my-repo_2");
  for (const url of ["https://gitlab.com/owner/repo.git", "git@example.com:owner/repo.git", "https://github.com/owner", "https://github.com/owner/repo/extra", "/local/path/repo"]) {
    expect(parseGithubRemote(url), url).toBeNull();
  }
});

describe("session links", () => {
  const pr = (n: number, repo = "o/r") => `https://github.com/${repo}/pull/${n}`;
  const issue = (n: number) => `https://github.com/o/r/issues/${n}`;

  it("saves validated links per session and tells the UI", async () => {
    expect(await host.call("links.set", { sessionId: "a", links: { issues: [issue(1)], prs: [pr(2), pr(2, "O/R")] } })).toEqual({ issues: [issue(1)], prs: [pr(2)] });
    expect(await host.call("links.get", { sessionId: "a" })).toEqual({ links: { issues: [issue(1)], prs: [pr(2)] }, detected: null, pulls: [] });
    expect(host.record.emitted.at(-1)).toEqual({ name: "links.changed", payload: { sessionId: "a", links: { issues: [issue(1)], prs: [pr(2)] }, detected: null, pulls: [] } });
    await expect(host.call("links.set", { sessionId: "a", links: { issues: [pr(3)] } })).rejects.toMatchObject({ code: "invalid" });
    await expect(host.call("links.set", { sessionId: "a", links: { prs: ["javascript:alert(1)"] } })).rejects.toMatchObject({ code: "invalid" });
    expect(host.sessionData.get("a")?.get("links"), "a refused save leaves the links").toEqual({ issues: [issue(1)], prs: [pr(2)] });
    await expect(host.call("links.set", { links: {} })).rejects.toMatchObject({ code: "invalid" });
  });

  it("keeps detected links and tells the UI only of a change", async () => {
    expect(await host.call("detected.set", { sessionId: "a", urls: [issue(2), `${pr(3)}/files`] })).toEqual([issue(2), pr(3)]);
    const emitted = host.record.emitted.length;
    await host.call("detected.set", { sessionId: "a", urls: [issue(2), pr(3)] });
    expect(host.record.emitted.length).toBe(emitted);
    await expect(host.call("detected.set", { sessionId: "a", urls: ["https://example.com/x"] })).rejects.toMatchObject({ code: "invalid" });
    expect((await host.call("links.all"))).toEqual({ a: { links: null, detected: [issue(2), pr(3)], pulls: [] } });
  });

  it("records the PRs of a session's branch once", async () => {
    expect(await host.call("pulls.record", { sessionId: "a", url: pr(7) })).toEqual([pr(7)]);
    expect(await host.call("pulls.record", { sessionId: "a", url: pr(7, "O/R") })).toEqual([pr(7)]);
    expect(await host.call("pulls.record", { sessionId: "a", url: pr(9) })).toEqual([pr(7), pr(9)]);
    expect(await host.call("session.pulls", { sessionId: "a" })).toEqual([pr(7), pr(9)]);
    await expect(host.call("pulls.record", { sessionId: "a", url: "not a url" })).rejects.toMatchObject({ code: "invalid" });
    await expect(host.call("pulls.record", { sessionId: "missing", url: pr(7) })).rejects.toMatchObject({ code: "not_found" });
  });

  it("links PRs from the chosen list, else the detected ones", async () => {
    // As aura-review's follow.rs read the former settings.
    await host.call("detected.set", { sessionId: "a", urls: [issue(2), pr(3)] });
    expect(await host.call("session.prs", { sessionId: "a" })).toEqual([pr(3)]);
    await host.call("links.set", { sessionId: "a", links: { prs: [pr(4), pr(5, "x/y")] } });
    expect(await host.call("session.prs", { sessionId: "a" })).toEqual([pr(4), pr(5, "x/y")]);
    // The older one-PR form, copied over as it was saved.
    host.sessionData.get("a")!.set("links", { pr: null });
    expect(await host.call("session.prs", { sessionId: "a" }), "the older form's None").toEqual([]);
    host.sessionData.get("a")!.set("links", JSON.stringify({ pr: pr(6) }));
    expect(await host.call("session.prs", { sessionId: "a" }), "settings text copied verbatim").toEqual([pr(6)]);
    host.sessionData.get("a")!.set("links", { prs: [pr(4), pr(4).replace("o/r", "O/R")], reviews: false });
    expect(await host.call("session.prs", { sessionId: "a" })).toEqual([pr(4)]);
    expect(await host.call("session.prs", { sessionId: "a", following: true }), "follow-ups turned off").toEqual([]);
    expect(await host.call("session.followsReviews", { sessionId: "a" })).toBe(false);
    expect(await host.call("session.followsReviews", { sessionId: "b" })).toBe(true);
    expect(await host.call("session.prs", { sessionId: "b" })).toEqual([]);
  });

  it("lists the PRs of every session, and the sessions of a PR", async () => {
    await host.call("links.set", { sessionId: "a", links: { prs: [pr(1)] } });
    await host.call("detected.set", { sessionId: "b", urls: [pr(1), issue(4)] });
    await host.call("pulls.record", { sessionId: "c", url: pr(1).replace("o/r", "O/R") });
    await host.call("links.set", { sessionId: "c", links: { prs: [] } });
    expect(await host.call("sessions.prs")).toEqual({ a: [pr(1)], b: [pr(1)] });
    expect((await host.call<string[]>("pulls.sessions", { url: `${pr(1)}/files` })).sort()).toEqual(["a", "b", "c"]);
    expect(await host.call("pulls.sessions", { url: pr(2) })).toEqual([]);
    await expect(host.call("pulls.sessions", { url: issue(1) })).rejects.toMatchObject({ code: "invalid" });
  });
});
