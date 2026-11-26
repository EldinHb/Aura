import { expect, it } from "vitest";
import { pace } from "./pace";
import { LOGIN_EXPIRED, RateLimited, RejectedRequest, rejected } from "./github";
import { errorData, remoteGithub, reviveError } from "./remote";

it("slows polls down as the budget runs low", () => {
  const base = 60_000;
  const budget = (resource: string, remaining: number) => ({ resource, limit: 5000, remaining, reset: 1_000 + 1_800 });
  const at = (remaining: number) => pace(base, [budget("core", remaining)], 1_000);
  expect(at(4000)).toBe(base);
  expect(at(2000)).toBe(base * 2);
  expect(at(1000)).toBe(base * 4);
  expect(at(100)).toBe(base * 8);
  expect(at(0), "until the reset").toBe(1_800_000);
  expect(pace(base, [budget("search", 0)], 1_000), "search has its own short limit").toBe(base);
  expect(pace(base, [budget("core", 4000), budget("graphql", 1000)], 1_000), "the lowest budget decides").toBe(base * 4);
  expect(pace(base, [budget("core", 0)], 5_000), "a budget past its reset is full again").toBe(base);
});

/** What an error looks like after crossing RPC: a plain Error with code, message and data. */
function overRpc(e: unknown): Error {
  const data = errorData(e);
  return Object.assign(new Error((e as Error).message), { code: data?.kind ?? "failed", data: data ?? undefined });
}

it("keeps refusals and rate limits apart across RPC", () => {
  const refused = reviveError(overRpc(new RejectedRequest("Not Found (HTTP 404)")));
  expect(refused).toBeInstanceOf(RejectedRequest);
  expect((refused as Error).message).toBe("Not Found (HTTP 404)");
  const limited = reviveError(overRpc(new RateLimited("secondary rate limit (HTTP 403)", 30_000, false)));
  expect(limited).toBeInstanceOf(RateLimited);
  expect([(limited as RateLimited).waitMs, (limited as RateLimited).resourceOnly]).toEqual([30_000, false]);
  const failed = reviveError(overRpc(new Error("Server Error (HTTP 502)")));
  expect(failed).not.toBeInstanceOf(RejectedRequest);
  expect(rejected(failed)).toBe(false);
  expect(errorData(new Error("x"))).toBeNull();
  // A refusal passed on by another mod keeps its kind.
  expect(errorData(overRpc(new RejectedRequest("x")))).toEqual({ kind: "rejected" });
});

it("tells refusals by flags, names and the expired login", () => {
  expect(rejected(new RejectedRequest("x"))).toBe(true);
  expect(rejected(new RateLimited("x", null, true))).toBe(true);
  expect(rejected({ name: "RejectedRequest", message: "x" })).toBe(true);
  expect(rejected({ data: { kind: "rate_limited" } })).toBe(true);
  expect(rejected(new Error(LOGIN_EXPIRED))).toBe(true);
  expect(rejected(new Error("timeout"))).toBe(false);
  expect(rejected(null)).toBe(false);
});

it("forwards every call to the github mod", async () => {
  const calls: Array<[string, unknown]> = [];
  const answers: Record<string, unknown> = {
    "api.request": { ok: 1 },
    "api.diff": "diff",
    "api.account": "github.com:me",
    "api.blocked": null,
    "api.pace": 120_000,
    "api.notified": { pulls: { "o/r#1": "2026-10-26T10:00:00.000Z" }, completeSince: null },
  };
  const gh = remoteGithub(async (name, params) => {
    calls.push([name, params]);
    if (name === "api.request" && (params as { path: string }).path === "boom") {
      throw Object.assign(new Error("Not Found (HTTP 404)"), { code: "rejected", data: { kind: "rejected" } });
    }
    return answers[name];
  });
  expect(await gh.request("GET", "user")).toEqual({ ok: 1 });
  await gh.requestFor("github.com:me", "POST", "graphql", { query: "q" });
  expect(await gh.diff("o/r", "a", "b")).toBe("diff");
  expect(await gh.account()).toBe("github.com:me");
  expect(await gh.blocked()).toBeNull();
  expect(await gh.pace(60_000)).toBe(120_000);
  expect((await gh.notified())?.changed("o/r", 1, "2026-10-26T09:00:00Z")).toBe(true);
  expect(gh.host()).toBe("github.com");
  expect(gh.memo()).toBe(remoteGithub(async () => null).memo());
  await expect(gh.request("GET", "boom")).rejects.toBeInstanceOf(RejectedRequest);
  expect(calls.slice(0, 3)).toEqual([
    ["api.request", { method: "GET", path: "user" }],
    ["api.request", { method: "POST", path: "graphql", body: { query: "q" }, account: "github.com:me" }],
    ["api.diff", { repo: "o/r", base: "a", head: "b" }],
  ]);
  expect(calls.find(([n]) => n === "api.pace")?.[1]).toEqual({ baseMs: 60_000 });
});
