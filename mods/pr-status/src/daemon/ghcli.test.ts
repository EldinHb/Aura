import { describe, expect, it } from "vitest";
import { createTestHost } from "@aura/mod-sdk/testing";
import { LOGIN_EXPIRED, NO_GH, RateLimited, RejectedRequest } from "@aura/github-client";
import { ghReply, rate, type Canned } from "../test/gh";
import { ACCOUNT_MS, GhCli, MAX_CONCURRENT, NOT_SIGNED_IN, NOTIFY_MS, parseReply, RECHECK_MS } from "./ghcli";

/** A GhCli on a test host whose gh answers from `answer` (args after `gh api -i`). */
function setup(answer: (args: string[], stdin?: string) => Canned | { raw: { code: number; stdout: string; stderr: string } } | "missing") {
  const host = createTestHost({ id: "pr-status" });
  let now = Date.parse("2026-11-27T10:00:00Z");
  const calls: string[][] = [];
  host.process.route((bin, args, o) => {
    if (bin !== "gh") return undefined;
    calls.push(args);
    if (args[0] === "auth") return authStatus;
    const a = answer(args.slice(4), o.stdin);
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
      ["api", "--hostname", "github.com", "-i", "graphql", "-X", "POST", "--input", "-"],
      ["api", "--hostname", "github.com", "-i", "repos/acme/api/pulls/7/files?per_page=100&page=1", "-X", "GET"],
    ]);
    // A write sends its body on stdin.
    const w = setup(() => ({ body: { merged: true } }));
    await w.gh.request("PUT", "repos/acme/api/pulls/7/merge", { merge_method: "squash", sha: "f" });
    expect(w.host.record.processes.at(-1)).toMatchObject({ args: ["api", "--hostname", "github.com", "-i", "repos/acme/api/pulls/7/merge", "-X", "PUT", "--input", "-"], stdin: "{\"merge_method\":\"squash\",\"sha\":\"f\"}" });
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
    expect(await error("x/502")).toMatchObject({ message: "Bad gateway (HTTP 502)" });
    expect(await error("x/403")).toBeInstanceOf(RateLimited);
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
    expect(t.calls.filter((c) => c[4] === "repos/acme/api/pulls/7/merge")).toHaveLength(1);
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
    expect(t.calls.at(-1)).toEqual(["api", "--hostname", "github.com", "-i", "notifications?per_page=50", "-H", "If-Modified-Since: Fri, 27 Nov 2026 09:00:00 GMT"]);
  });

  it("keeps the login for 15 minutes, asking again only before a merge write and after a 401 or 403", async () => {
    let status = 200;
    const t = setup((args) => (args[0] === "user" ? { body: { login: "sam" } } : { status, body: status === 200 ? { data: {} } : { message: "Forbidden" } }));
    const asked = () => t.calls.filter((c) => c[4] === "user").length;
    await t.gh.account();
    t.advance(ACCOUNT_MS - 1);
    await t.gh.account();
    expect(asked()).toBe(1);
    t.advance(1);
    await t.gh.account();
    expect(asked()).toBe(2);
    // A merge write always asks.
    await t.gh.requestFor("github.com:sam", "POST", "graphql", { query: "q" });
    expect(asked()).toBe(3);
    await t.gh.account();
    expect(asked()).toBe(3);
    // A 403 (or a 401) makes the next read ask again.
    status = 403;
    await t.gh.request("POST", "graphql", { query: "q" }).catch(() => {});
    await t.gh.account();
    expect(asked()).toBe(4);
    status = 401;
    await t.gh.request("POST", "graphql", { query: "q" }).catch(() => {});
    await t.gh.account().catch(() => {});
    expect(asked()).toBe(5);
  });

  describe("review of the rework", () => {
    it("merges on one token read for it, through the environment only, whatever gh switches to meanwhile (item 1)", async () => {
      const host = createTestHost({ id: "pr-status" });
      let active = "sam";
      const seen: Array<{ args: string[]; env?: Record<string, string | null> }> = [];
      host.process.route((bin, args, o) => {
        if (bin !== "gh") return undefined;
        seen.push({ args, env: o.env });
        if (args[0] === "auth" && args[1] === "token") return { stdout: `tok-${active}\n` };
        // Who a request acts as: the token given, else gh's active account.
        const as = o.env?.GH_TOKEN ? String(o.env.GH_TOKEN).slice(4) : active;
        if (args[4] === "user") return ghReply({ body: { login: as } });
        return ghReply({ body: { merged: true, as } });
      });
      const gh = new GhCli(host.api);
      const result = await gh.pinned("github.com:sam", async (pinned) => {
        // `gh auth switch` in the middle of the merge.
        active = "other";
        return pinned.requestFor("github.com:sam", "PUT", "repos/acme/api/pulls/7/merge", { sha: "f" });
      });
      expect(result).toEqual({ merged: true, as: "sam" });
      expect(seen.map((c) => c.args.slice(0, 2).join(" "))).toEqual(["auth token", "api --hostname", "api --hostname"]);
      for (const c of seen.slice(1)) expect(c.env).toMatchObject({ GH_TOKEN: "tok-sam", GH_HOST: null, GH_ENTERPRISE_TOKEN: null });
      // The token is never an argument, and is not in what the host records.
      expect(seen.flatMap((c) => c.args).join(" ")).not.toContain("tok-");
      expect(JSON.stringify(host.record.processes)).not.toContain("tok-");
      // A token of another account than the one confirmed: refused before any write.
      active = "other";
      await expect(gh.pinned("github.com:sam", async () => "wrote")).rejects.toBeInstanceOf(RejectedRequest);
    });

    it("pins every call to github.com, whatever GH_HOST says (item 2)", async () => {
      const t = setup(() => ({ body: { data: {} } }));
      await t.gh.request("POST", "graphql", { query: "q" });
      await t.gh.request("GET", "https://api.github.com/repos/acme/api");
      await expect(t.gh.request("GET", "https://ghe.example.com/api/v3/repos/acme/api")).rejects.toBeInstanceOf(RejectedRequest);
      t.advance(RECHECK_MS);
      for (const p of t.host.record.processes) expect(p.args.join(" ")).toMatch(/--hostname github\.com/);
      const env = (await (async () => {
        let got: Record<string, string | null> | undefined;
        const h = createTestHost({ id: "pr-status" });
        h.process.route((_bin, _args, o) => {
          got = o.env;
          return ghReply({ body: {} });
        });
        await new GhCli(h.api).request("GET", "user");
        return got;
      })())!;
      expect(env).toEqual({ GH_HOST: null, GH_ENTERPRISE_TOKEN: null, GITHUB_ENTERPRISE_TOKEN: null });
    });

    it("pauses every call while GitHub asks to wait, and says so (item 3)", async () => {
      let limited = true;
      const t = setup((args) => (limited && args[0] === "graphql" ? { status: 403, headers: { "Retry-After": 120 }, body: { message: "You have exceeded a secondary rate limit" } } : { body: [] }));
      await expect(t.gh.request("POST", "graphql", { query: "q" })).rejects.toBeInstanceOf(RateLimited);
      limited = false;
      const before = t.calls.length;
      // Nothing goes out meanwhile: reads, notifications (which then answer null), pages.
      await expect(t.gh.request("GET", "repos/acme/api/pulls/7/files?per_page=100&page=1")).rejects.toBeInstanceOf(RateLimited);
      expect(await t.gh.notified()).toBeNull();
      expect(t.calls.length).toBe(before);
      expect(await t.gh.blocked()).toMatch(/paused until/);
      t.advance(120_000);
      expect(await t.gh.blocked()).toBeNull();
      await t.gh.request("GET", "repos/acme/api/pulls/7/files?per_page=100&page=1");
      expect(t.calls.length).toBe(before + 1);
    });

    it("waits for a spent resource's reset, and runs at most four gh calls at once (item 3)", async () => {
      const reset = Math.floor(Date.parse("2026-11-27T10:30:00Z") / 1000);
      const t = setup((args) => ({ headers: rate(args[0] === "graphql" ? "graphql" : "core", args[0] === "graphql" ? 0 : 4000, 5000, reset), body: { data: {} } }));
      await t.gh.request("POST", "graphql", { query: "q" });
      await expect(t.gh.request("POST", "graphql", { query: "q" })).rejects.toBeInstanceOf(RateLimited);
      // The core budget is another resource: still allowed.
      await t.gh.request("GET", "repos/acme/api");

      const host = createTestHost({ id: "pr-status" });
      let inFlight = 0;
      let most = 0;
      const pending: Array<() => void> = [];
      host.process.route(() => {
        inFlight++;
        most = Math.max(most, inFlight);
        return new Promise((resolve) => pending.push(() => {
          inFlight--;
          resolve(ghReply({ body: {} }));
        }));
      });
      const gh = new GhCli(host.api);
      let done = false;
      const all = Promise.all(Array.from({ length: 7 }, (_, i) => gh.request("GET", `repos/acme/api/pulls/${i}`))).then(() => (done = true));
      while (!done) {
        await new Promise((r) => setTimeout(r, 0));
        pending.splice(0).forEach((release) => release());
      }
      await all;
      expect(most).toBe(MAX_CONCURRENT);
    });
  });

  describe("re-review", () => {
    /** A host whose gh calls wait until released, answering what `answer` says for each, in order. */
    function held() {
      const host = createTestHost({ id: "pr-status" });
      const pending: Array<(reply: ReturnType<typeof ghReply>) => void> = [];
      host.process.route((bin, args) => (bin === "gh" && args[0] === "api" ? new Promise((resolve) => pending.push(resolve)) : undefined));
      return { host, gh: new GhCli(host.api), pending, sent: () => host.record.processes.length };
    }
    const tick = () => new Promise((r) => setTimeout(r, 0));

    it("does not send queued calls after an answer paused the gate (item 1)", async () => {
      const t = held();
      const calls = Array.from({ length: 16 }, (_, i) => t.gh.request("GET", `repos/acme/api/pulls/${i}`).then(() => "ok", (e) => e));
      await tick();
      expect(t.sent()).toBe(MAX_CONCURRENT);
      // The first answer: a 429 with Retry-After. The 12 waiting calls must not go out.
      t.pending.shift()!(ghReply({ status: 429, headers: { "Retry-After": 120 }, body: { message: "Too many requests" } }));
      await tick();
      for (const release of t.pending.splice(0)) release(ghReply({ body: {} }));
      const results = await Promise.all(calls);
      expect(t.sent()).toBe(MAX_CONCURRENT);
      expect(results.filter((r) => r instanceof RateLimited)).toHaveLength(13);
      expect(await t.gh.blocked()).toMatch(/paused until/);
    });

    it("keeps the lowest remaining of a reset window, whatever order answers arrive in (item 2)", async () => {
      const t = held();
      const reset = 1_900_000_000;
      const first = t.gh.request("POST", "graphql", { query: "q" });
      const second = t.gh.request("POST", "graphql", { query: "q" });
      await tick();
      // The newer answer (0 left) arrives first, the older (1 left) after it.
      t.pending.shift()!(ghReply({ headers: rate("graphql", 0, 5000, reset), body: { data: {} } }));
      await tick();
      t.pending.shift()!(ghReply({ headers: rate("graphql", 1, 5000, reset), body: { data: {} } }));
      await Promise.all([first, second]);
      expect(await t.gh.blocked()).toMatch(/rate limit is reached/);
      await expect(t.gh.request("POST", "graphql", { query: "q" })).rejects.toBeInstanceOf(RateLimited);
      // A new window replaces it; an older one does not.
      const next = t.gh.request("GET", "repos/acme/api");
      await tick();
      t.pending.shift()!(ghReply({ headers: rate("graphql", 4999, 5000, reset + 3600), body: {} }));
      await next;
      expect(await t.gh.blocked()).toBeNull();
    });

    it("asks who is signed in again once a merge found another account (item 3)", async () => {
      const host = createTestHost({ id: "pr-status" });
      let active = "sam";
      host.process.route((bin, args, o) => {
        if (bin !== "gh") return undefined;
        if (args[0] === "auth") return { stdout: `tok-${active}\n` };
        const as = o.env?.GH_TOKEN ? String(o.env.GH_TOKEN).slice(4) : active;
        return ghReply({ body: { login: as } });
      });
      const gh = new GhCli(host.api);
      expect(await gh.account()).toBe("github.com:sam");
      active = "other";
      await expect(gh.pinned("github.com:sam", async () => "wrote")).rejects.toBeInstanceOf(RejectedRequest);
      // Not the old account for another 15 minutes: the cards now show who is signed in.
      expect(await gh.account()).toBe("github.com:other");
    });
  });

  it("asks gh about the active account only, so another account's expired token does not block (review)", async () => {
    const host = createTestHost({ id: "pr-status" });
    host.process.route((bin, args) => {
      if (bin !== "gh") return undefined;
      // `gh auth status` exits 1 when any account has a problem; with --active only the active one counts.
      if (args[0] === "auth") return args.includes("--active") ? { code: 0, stdout: "✓ Logged in to github.com account sam" } : { code: 1, stderr: "X Failed to log in to github.com account old (keyring)\n  - The token in keyring is invalid." };
      return ghReply({ body: {} });
    });
    const gh = new GhCli(host.api);
    expect(await gh.blocked()).toBeNull();
    expect(host.record.processes[0].args).toEqual(["auth", "status", "--active", "--hostname", "github.com"]);
  });
});
