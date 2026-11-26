import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestHost, type HttpRequest } from "@aura/mod-sdk/testing";
import { LOGIN_EXPIRED, NO_GH, RateLimited, RejectedRequest, rejected } from "@aura/github-client";
import { Gate, GhTransport, LOGIN_RECHECK_MS, failure, fingerprint, graphqlFailure, isRead, isServerError, shouldRetry, Unauthorized } from "./transport";

afterEach(() => vi.useRealTimers());

const nowSec = () => Math.floor(Date.now() / 1000);
type Answer = { status?: number; headers?: Record<string, string>; body?: unknown };

/** A transport talking to `answer`, signed in with t1; every request and its fetch options are recorded. */
function server(answer: (req: HttpRequest) => Answer) {
  const host = createTestHost({ id: "github" });
  host.http.route(answer);
  const inits: Array<{ url: string; cache?: string; method?: string }> = [];
  const fetch = host.api.http.fetch;
  host.api.http.fetch = (url, init) => {
    inits.push({ url, cache: init?.cache, method: init?.method });
    return fetch(url, init);
  };
  const gh = new GhTransport({ aura: host.api });
  gh.primeToken("t1");
  return { gh, host, got: host.record.http, inits };
}
const auth = (req: HttpRequest) => req.headers.Authorization;

describe("requests", () => {
  it("asks the host's ETag cache for reads, per login", async () => {
    const { gh, got, inits } = server(() => ({ body: { a: 1 } }));
    expect(await gh.request("GET", "repos/o/r/labels")).toEqual({ a: 1 });
    await gh.request("POST", "graphql", { query: "mutation{x}" });
    await gh.diff("o/r", "a".repeat(40), "b".repeat(40)).catch(() => {});
    expect(got[0].url).toBe("https://api.github.com/repos/o/r/labels");
    expect(auth(got[0])).toBe("Bearer t1");
    expect(got[0].headers.Accept).toBe("application/vnd.github+json");
    expect(got[0].headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(inits.map((i) => i.cache)).toEqual(["etag", undefined, undefined]);
    expect(got[2].headers.Accept, "a diff asks for the diff").toBe("application/vnd.github.diff");
    gh.primeToken("t2");
    await gh.request("GET", "repos/o/r/labels");
    // The host keys its cache on the Authorization header too, so another login's answers are not reused.
    expect(auth(got[3])).toBe("Bearer t2");
  });

  it("does not hold back another login for one login's spent budget", async () => {
    const reset = String(nowSec() + 600);
    const { gh, got } = server((r) => ({
      headers: { "x-ratelimit-resource": "core", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": auth(r) === "Bearer spent" ? "0" : "4000", "x-ratelimit-reset": reset },
      body: {},
    }));
    gh.primeToken("spent");
    await gh.request("GET", "repos/o/r/labels");
    await expect(gh.request("GET", "repos/o/r/labels")).rejects.toBeInstanceOf(RejectedRequest);
    expect(got.length, "the spent login waits for its reset").toBe(1);
    expect(await gh.pace(60_000)).toBeGreaterThan(500_000);
    gh.primeToken("fresh");
    await gh.request("GET", "repos/o/r/labels");
    expect(got.length, "another login is not held back").toBe(2);
    expect(await gh.pace(60_000)).toBe(60_000);
  });

  it("reads notifications per login, once per poll interval", async () => {
    const { gh, got } = server(() => ({ headers: { "X-Poll-Interval": "60" }, body: [] }));
    gh.primeToken("n1");
    expect(await gh.notified()).not.toBeNull();
    expect(await gh.notified()).not.toBeNull();
    expect(got.length, "read once per poll interval").toBe(1);
    expect(got[0].url).toBe("https://api.github.com/notifications?all=true&per_page=50");
    gh.primeToken("n2");
    await gh.notified();
    expect(got.length, "another login's notifications are its own").toBe(2);
    expect(auth(got[1])).toBe("Bearer n2");
  });

  it("stops asking for notifications a token cannot read", async () => {
    const { gh, got } = server(() => ({ status: 403, body: { message: "Resource not accessible by integration" } }));
    expect(await gh.notified()).toBeNull();
    expect(await gh.notified()).toBeNull();
    expect(got.length).toBe(1);
  });

  it("stops requests on a refused login until a new one works", async () => {
    const { gh, got } = server((r) => (auth(r) === "Bearer t1" ? { status: 401, body: { message: "Bad credentials" } } : { body: { login: "me" } }));
    await expect(gh.request("GET", "user")).rejects.toThrow(LOGIN_EXPIRED);
    gh.primeToken("t1");
    expect(await gh.blocked()).toBe(LOGIN_EXPIRED);
    await expect(gh.request("GET", "repos/o/r/pulls/1")).rejects.toThrow();
    await expect(gh.account()).rejects.toThrow();
    expect(got.length, "nothing more is sent with the refused token").toBe(1);
    gh.primeToken("t2");
    expect(await gh.blocked(), "a new login is tried and works").toBeNull();
    expect(got.length, "with one request").toBe(2);
    expect(await gh.account(), "known from that check").toBe("github.com:me");
    expect(got.length).toBe(2);
  });

  it("looks the account up once per token", async () => {
    const { gh, got } = server(() => ({ body: { login: "me" } }));
    const [a, b] = await Promise.all([gh.account(), gh.account()]);
    expect([a, b]).toEqual(["github.com:me", "github.com:me"]);
    expect(got.length, "callers starting together ask once").toBe(1);
  });

  it("refuses GitHub's refusals and keeps partial GraphQL answers", async () => {
    const { gh } = server((r) =>
      r.url.endsWith("/graphql")
        ? { body: JSON.parse(r.body!).query === "partial" ? { data: { r0: null }, errors: [{ message: "x" }] } : { data: null, errors: [{ message: "Something went wrong" }] } }
        : { status: 404, body: { message: "Not Found" } },
    );
    const e = await gh.request("GET", "repos/o/r").catch((e) => e);
    expect(e).toBeInstanceOf(RejectedRequest);
    expect(e.message).toBe("Not Found (HTTP 404)");
    expect(await gh.request("POST", "graphql", { query: "partial" })).toEqual({ data: { r0: null }, errors: [{ message: "x" }] });
    await expect(gh.request("POST", "graphql", { query: "whole" })).rejects.toThrow("Something went wrong");
  });
});

describe("gh's token", () => {
  function signedIn(stdout: string | null, code = 0) {
    const host = createTestHost({ id: "github" });
    const runs: Array<{ args: string[]; env?: Record<string, string | null>; timeoutMs?: number }> = [];
    const run = host.api.process.run;
    host.api.process.run = (bin, args, opts) => {
      runs.push({ args, env: opts?.env, timeoutMs: opts?.timeoutMs });
      return run(bin, args, opts);
    };
    if (stdout !== null) host.process.route((bin) => (bin === "gh" ? { code, stdout } : undefined));
    host.http.route((r) => ({ body: { login: auth(r) === "Bearer gho_a" ? "alice" : "bob" } }));
    let now = 1_000_000;
    const gh = new GhTransport({ aura: host.api, now: () => now });
    return { gh, runs, host, later: (ms: number) => (now += ms) };
  }

  it("is read from gh and read again after a minute", async () => {
    const { gh, runs, later } = signedIn("gho_a\n");
    expect(await gh.account()).toBe("github.com:alice");
    expect(runs[0]).toEqual({ args: ["auth", "token", "--hostname", "github.com"], env: { GH_PROMPT_DISABLED: "1" }, timeoutMs: 15_000 });
    later(30_000);
    await gh.request("GET", "user");
    expect(runs.length).toBe(1);
    later(31_000);
    await gh.request("GET", "user");
    expect(runs.length).toBe(2);
  });

  it("says how to sign in when gh has no login or is missing", async () => {
    const out = signedIn("", 1);
    expect(await out.gh.blocked()).toContain("gh auth login");
    expect(rejected(await out.gh.request("GET", "user").catch((e) => e))).toBe(true);
    const missing = signedIn(null);
    expect(await missing.gh.blocked()).toBe(NO_GH);
  });

  it("pins writes to the reviewed account's own token", async () => {
    const { gh, runs, host } = signedIn("gho_a");
    await gh.requestFor("github.com:alice", "POST", "repos/o/r/pulls/1/reviews", { event: "COMMENT" });
    expect(runs[0].args).toEqual(["auth", "token", "--hostname", "github.com", "--user", "alice"]);
    expect(host.record.http.map((r) => [r.method, r.url.replace("https://api.github.com/", "")])).toEqual([["GET", "user"], ["POST", "repos/o/r/pulls/1/reviews"]]);
    await expect(gh.requestFor("github.com:bob", "POST", "x")).rejects.toThrow("GitHub credentials do not match the reviewed account");
    await expect(gh.requestFor("ghe.example.com:alice", "POST", "x")).rejects.toThrow("Wrong GitHub host");
    await expect(gh.requestFor("nobody", "POST", "x")).rejects.toBeInstanceOf(RejectedRequest);
  });
});

describe("the gate", () => {
  const counting = (failures: number, message: string) => {
    let calls = 0;
    const call = async () => {
      if (calls++ < failures) throw new Error(message);
      return "ok";
    };
    return { call, calls: () => calls };
  };

  it("retries reads that hit a server error", async () => {
    const gate = new Gate(4, 60_000, [0, 0]);
    const c = counting(2, "Server Error (HTTP 504)");
    expect(await gate.run(true, c.call)).toBe("ok");
    expect(c.calls()).toBe(3);
    const d = counting(9, "Bad Gateway (HTTP 502)");
    await expect(gate.run(true, d.call)).rejects.toThrow();
    expect(d.calls(), "gives up after the last delay").toBe(3);
  });

  it("never retries writes or client errors", async () => {
    const gate = new Gate(4, 60_000, [0, 0]);
    const w = counting(1, "Server Error (HTTP 504)");
    await expect(gate.run(false, w.call)).rejects.toThrow();
    expect(w.calls()).toBe(1);
    const c = counting(1, "Not Found (HTTP 404)");
    await expect(gate.run(true, c.call)).rejects.toThrow();
    expect(c.calls()).toBe(1);
  });

  it("pauses every request after a rate limit", async () => {
    const gate = new Gate(4, 50, [0, 0]);
    const c = counting(1, "You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)");
    await expect(gate.run(true, c.call)).rejects.toThrow();
    const refused = await gate.run(true, c.call).catch((e) => e);
    expect(refused, "refused unsent").toBeInstanceOf(RejectedRequest);
    expect(c.calls(), "nothing reaches GitHub while paused").toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(await gate.run(true, c.call)).toBe("ok");
  });

  it("honours Retry-After and leaves spent budgets to their resource", async () => {
    const gate = new Gate(4, 600_000, [0, 0]);
    const limited = (wait: number, resourceOnly: boolean) => async () => {
      throw new RateLimited("secondary rate limit (HTTP 403)", wait, resourceOnly);
    };
    await expect(gate.run(true, limited(40, false))).rejects.toThrow();
    expect(gate.paused(), "paused for Retry-After").not.toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(gate.paused(), "Retry-After replaces the default pause").toBeNull();
    await expect(gate.run(true, limited(10_000, true))).rejects.toThrow();
    expect(gate.paused(), "one spent budget does not stop the others").toBeNull();
  });

  it("runs at most four requests at a time", async () => {
    const gate = new Gate(4, 60_000, [0, 0]);
    let running = 0;
    let most = 0;
    const call = async () => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return 1;
    };
    await Promise.all(Array.from({ length: 10 }, () => gate.run(true, call)));
    expect(most).toBe(4);
  });

  it("follows the budget GitHub reports", () => {
    const gate = new Gate(4, 60_000, [0, 0]);
    const base = 60_000;
    const report = (remaining: number) => {
      gate.record("1", { "x-ratelimit-resource": "graphql", "x-ratelimit-limit": "5000", "x-ratelimit-remaining": String(remaining), "x-ratelimit-reset": String(nowSec() + 1800) });
      return gate.pace("1", base);
    };
    expect(report(4900)).toBe(base);
    expect(report(1500)).toBe(base * 2);
    expect(report(300)).toBe(base * 8);
    expect(report(0), "spent: wait for the reset").toBeGreaterThan(1_700_000);
    expect(gate.exhausted("1", "graphql")).not.toBeNull();
    expect(gate.exhausted("1", "core")).toBeNull();
    expect(gate.exhausted("2", "graphql"), "another login's budget is its own").toBeNull();
    expect(gate.pace("2", base)).toBe(base);
  });
});

it("tells rate limits, 401s and rejections apart", () => {
  expect(failure(401, {}, '{"message":"Bad credentials"}')).toBeInstanceOf(Unauthorized);
  const notFound = failure(404, {}, '{"message":"Not Found"}');
  expect(notFound.message).toBe("Not Found (HTTP 404)");
  expect(rejected(notFound)).toBe(true);
  const bad = failure(502, {}, "<html>");
  expect(!rejected(bad) && isServerError(bad.message)).toBe(true);
  const limited = failure(403, { "retry-after": "30" }, '{"message":"You have exceeded a secondary rate limit"}') as RateLimited;
  expect(limited).toBeInstanceOf(RateLimited);
  expect([limited.waitMs, limited.resourceOnly]).toEqual([30_000, false]);
  expect(rejected(limited), "a refused write was not applied").toBe(true);
  const spent = { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(nowSec() + 100) };
  const exhausted = failure(403, spent, '{"message":"API rate limit exceeded"}') as RateLimited;
  expect(exhausted.resourceOnly && exhausted.waitMs! >= 100_000).toBe(true);
  expect(() => graphqlFailure(spent, '{"data":null,"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}')).toThrow(RateLimited);
});

it("keeps partial GraphQL answers", () => {
  expect(() => graphqlFailure({}, '{"data":{"r0":null},"errors":[{"message":"x"}]}')).not.toThrow();
  expect(() => graphqlFailure({}, '{"data":null,"errors":[{"message":"Something went wrong"}]}')).toThrow("Something went wrong");
});

it("counts only reads as repeatable", () => {
  expect(isRead("GET", "repos/o/r/pulls/1")).toBe(true);
  expect(isRead("POST", "repos/o/r/pulls/1/reviews", {})).toBe(false);
  expect(isRead("POST", "graphql", { query: "query{viewer{login}}" })).toBe(true);
  expect(isRead("POST", "graphql", { query: " mutation($id:ID!){x}" })).toBe(false);
});

it("builds API URLs for GitHub and Enterprise hosts", () => {
  const aura = createTestHost({ id: "github" }).api;
  const gh = new GhTransport({ aura });
  expect(gh.url("user")).toBe("https://api.github.com/user");
  expect(gh.url("graphql")).toBe("https://api.github.com/graphql");
  const ghes = new GhTransport({ aura, host: "git.example.com" });
  expect(ghes.url("repos/o/r/pulls/1")).toBe("https://git.example.com/api/v3/repos/o/r/pulls/1");
  expect(ghes.url("graphql")).toBe("https://git.example.com/api/graphql");
  expect(new GhTransport({ aura, host: "acme.ghe.com" }).url("graphql")).toBe("https://api.acme.ghe.com/graphql");
});

it("tries a refused token again only when it changed or after a while", () => {
  const now = 5_000_000;
  const out = { reason: LOGIN_EXPIRED, token: fingerprint("a"), checked: now };
  expect(shouldRetry(out, fingerprint("a"), now), "the same token waits").toBe(false);
  expect(shouldRetry(out, fingerprint("b"), now), "a new login is tried at once").toBe(true);
  expect(shouldRetry(out, fingerprint("a"), now + LOGIN_RECHECK_MS)).toBe(true);
});
