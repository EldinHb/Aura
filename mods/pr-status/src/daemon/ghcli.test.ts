import { describe, expect, it } from "vitest";
import { createTestHost } from "@aura/mod-sdk/testing";
import { LOGIN_EXPIRED, NO_GH, RateLimited, RejectedRequest } from "@aura/github-client";
import { ghReply, rate, type Canned } from "../test/gh";
import { GhCli, NOT_SIGNED_IN, NOTIFY_MS, parseReply, RECHECK_MS } from "./ghcli";

/** A GhCli on a test host whose gh answers from `answer` (args after `gh api -i`). */
function setup(answer: (args: string[], stdin?: string) => Canned | { raw: { code: number; stdout: string; stderr: string } } | "missing") {
  const host = createTestHost({ id: "pr-status" });
  let now = Date.parse("2026-11-27T10:00:00Z");
  const calls: string[][] = [];
  host.process.route((bin, args, o) => {
    if (bin !== "gh") return undefined;
    calls.push(args);
    if (args[0] === "auth") return authStatus;
    const a = answer(args.slice(2), o.stdin);
    if (a === "missing") throw new Error("gh: not found");
    return "raw" in a ? a.raw : ghReply(a);
  });
  let authStatus = { code: 0, stdout: "github.com\n  ✓ Logged in to github.com account sam", stderr: "" };
  const gh = new GhCli(host.api, { now: () => now });
  return { host, gh, calls, advance: (ms: number) => (now += ms), setAuth: (a: typeof authStatus) => (authStatus = a) };
}

describe("parseReply", () => {
  it("reads gh api -i output", () => {
    expect(parseReply("HTTP/2.0 200 OK\r\nX-RateLimit-Remaining: 4999\r\nETag: \"x\"\r\n\r\n{\"a\":1}")).toEqual({ status: 200, headers: { "x-ratelimit-remaining": "4999", etag: "\"x\"" }, body: "{\"a\":1}" });
    expect(parseReply("HTTP/2.0 304 Not Modified\nLast-Modified: x\n")).toEqual({ status: 304, headers: { "last-modified": "x" }, body: "" });
    expect(parseReply("gh: To get started with GitHub CLI, please run:  gh auth login")).toBeNull();
  });
});

describe("GhCli", () => {
  it("sends GraphQL on stdin and REST by path, and reads the answers", async () => {
    const t = setup((args, stdin) => (args[0] === "graphql" ? { body: { data: { echo: JSON.parse(stdin!).variables } } } : { body: [{ filename: "a.ts" }] }));
    expect(await t.gh.request("POST", "graphql", { query: "q", variables: { n: 1 } })).toEqual({ data: { echo: { n: 1 } } });
    expect(await t.gh.request("GET", "repos/acme/api/pulls/7/files?per_page=100&page=1")).toEqual([{ filename: "a.ts" }]);
    expect(t.calls).toEqual([
      ["api", "-i", "graphql", "-X", "POST", "--input", "-"],
      ["api", "-i", "repos/acme/api/pulls/7/files?per_page=100&page=1", "-X", "GET"],
    ]);
    // A write sends its body on stdin.
    const w = setup(() => ({ body: { merged: true } }));
    await w.gh.request("PUT", "repos/acme/api/pulls/7/merge", { merge_method: "squash", sha: "f" });
    expect(w.host.record.processes.at(-1)).toMatchObject({ args: ["api", "-i", "repos/acme/api/pulls/7/merge", "-X", "PUT", "--input", "-"], stdin: "{\"merge_method\":\"squash\",\"sha\":\"f\"}" });
  });

  it("turns GitHub's refusals into the client's errors, keeping its message and status", async () => {
    const t = setup((args) => {
      if (args[0].endsWith("/405")) return { status: 405, body: { message: "Pull Request is not mergeable" } };
      if (args[0].endsWith("/409")) return { status: 409, body: { message: "Head branch was modified" } };
      if (args[0].endsWith("/403")) return { status: 403, headers: rate("core", 0), body: { message: "API rate limit exceeded" } };
      return { status: 502, body: "Bad gateway" };
    });
    const error = (path: string) => t.gh.request("PUT", path).catch((e) => e);
    expect(await error("x/405")).toMatchObject({ message: "Pull Request is not mergeable (HTTP 405)" });
    expect(await error("x/405")).toBeInstanceOf(RejectedRequest);
    expect(await error("x/409")).toMatchObject({ message: "Head branch was modified (HTTP 409)" });
    expect(await error("x/403")).toBeInstanceOf(RateLimited);
    expect(await error("x/502")).toMatchObject({ message: "Bad gateway (HTTP 502)" });
  });

  it("says plainly when gh is missing, signed out, or its token expired, and looks again later", async () => {
    let state: "missing" | "signed out" | "expired" | "ok" = "missing";
    const t = setup(() => (state === "missing" ? "missing" : state === "signed out"
      ? { raw: { code: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" } }
      : state === "expired" ? { status: 401, body: { message: "Bad credentials" } } : { body: { login: "sam" } }));
    await expect(t.gh.request("GET", "user")).rejects.toMatchObject({ message: NO_GH });
    expect(await t.gh.blocked()).toBe(NO_GH);
    state = "signed out";
    t.advance(RECHECK_MS);
    t.setAuth({ code: 1, stdout: "", stderr: "You are not logged into any GitHub hosts." });
    expect(await t.gh.blocked()).toBe(NOT_SIGNED_IN);
    await expect(t.gh.request("GET", "user")).rejects.toMatchObject({ message: NOT_SIGNED_IN });
    state = "expired";
    await expect(t.gh.request("GET", "user")).rejects.toMatchObject({ message: LOGIN_EXPIRED });
    expect(await t.gh.blocked()).toBe(LOGIN_EXPIRED);
    // Signed in again: within RECHECK_MS it still says why; after it, gh auth status clears it.
    state = "ok";
    t.setAuth({ code: 0, stdout: "✓ Logged in", stderr: "" });
    expect(await t.gh.blocked()).toBe(LOGIN_EXPIRED);
    t.advance(RECHECK_MS);
    expect(await t.gh.blocked()).toBeNull();
  });

  it("paces by the rate-limit headers, and is blocked while a budget is spent", async () => {
    let remaining = 4000;
    const t = setup(() => ({ headers: rate("graphql", remaining), body: { data: {} } }));
    await t.gh.request("POST", "graphql", { query: "q" });
    expect(await t.gh.pace(60_000)).toBe(60_000);
    remaining = 400;
    await t.gh.request("POST", "graphql", { query: "q" });
    expect(await t.gh.pace(60_000)).toBe(480_000);
    remaining = 0;
    await t.gh.request("POST", "graphql", { query: "q" });
    expect(await t.gh.blocked()).toMatch(/rate limit is reached/);
  });

  it("checks the signed-in login right before a write for an account, and refuses another", async () => {
    let login = "sam";
    const t = setup((args) => (args[0] === "user" ? { body: { login } } : { body: { merged: true } }));
    expect(await t.gh.account()).toBe("github.com:sam");
    expect(await t.gh.requestFor("github.com:sam", "PUT", "repos/acme/api/pulls/7/merge", {})).toEqual({ merged: true });
    login = "someone-else";
    // Even with a fresh cached login, the write checks again.
    await expect(t.gh.requestFor("github.com:sam", "PUT", "repos/acme/api/pulls/7/merge", {})).rejects.toBeInstanceOf(RejectedRequest);
    expect(t.calls.filter((c) => c[2] === "repos/acme/api/pulls/7/merge")).toHaveLength(1);
  });

  it("polls notifications at most once a minute, conditionally", async () => {
    const t = setup((args): Canned => {
      if (args.includes("-H")) return { status: 304, headers: { "Last-Modified": "Fri, 27 Nov 2026 09:00:00 GMT" } };
      return { headers: { "Last-Modified": "Fri, 27 Nov 2026 09:00:00 GMT", "X-Poll-Interval": 60 }, body: [
        { updated_at: "2026-11-27T09:59:00Z", subject: { type: "PullRequest", url: "https://api.github.com/repos/acme/api/pulls/7" } },
      ] };
    });
    const first = await t.gh.notified();
    expect(first?.pulls).toEqual({ "acme/api#7": "2026-11-27T09:59:00.000Z" });
    expect(await t.gh.notified()).toBe(first);
    expect(t.calls).toHaveLength(1);
    t.advance(NOTIFY_MS);
    expect(await t.gh.notified()).toBe(first);
    expect(t.calls.at(-1)).toEqual(["api", "-i", "notifications?per_page=50", "-H", "If-Modified-Since: Fri, 27 Nov 2026 09:00:00 GMT"]);
  });
});
