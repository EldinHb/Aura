// A `Github` that forwards to the `github` mod's transport over RPC.
//
// The github mod serves (all params/results JSON):
//   api.request   {method, path, body?, account?}  → body   (account set → requestFor)
//   api.diff      {repo, base, head}               → string
//   api.account   {}                               → "host:login"
//   api.blocked   {}                               → string | null
//   api.pace      {baseMs}                         → number
//   api.notified  {}                               → Notified.toJSON() | null
// Errors cross as {code, message, data?}; data.kind "rejected" / "rate_limited"
// is turned back into RejectedRequest / RateLimited here.
import { Memo, Notified } from "./activity";
import { RateLimited, RejectedRequest, type Github } from "./github";

export type ModCall = (name: string, params?: unknown) => Promise<any>;

/** One memo per runtime: every remote `Github` of a mod shares its answers, as loops of one daemon did. */
const sharedMemo = new Memo();

export function remoteGithub(call: ModCall, host = "github.com"): Github {
  const ask = async (name: string, params: unknown) => {
    try {
      return await call(name, params);
    } catch (e) {
      throw reviveError(e);
    }
  };
  return {
    request: (method, path, body) => ask("api.request", body === undefined ? { method, path } : { method, path, body }),
    requestFor: (account, method, path, body) =>
      ask("api.request", body === undefined ? { method, path, account } : { method, path, body, account }),
    diff: (repo, base, head) => ask("api.diff", { repo, base, head }),
    host: () => host,
    account: () => ask("api.account", {}),
    blocked: () => ask("api.blocked", {}),
    pace: (baseMs) => ask("api.pace", { baseMs }),
    notified: async () => Notified.fromJSON(await ask("api.notified", {})),
    memo: () => sharedMemo,
  };
}

/** Turn an error that crossed RPC back into RejectedRequest / RateLimited where it was one. */
export function reviveError(e: unknown): unknown {
  if (e instanceof RejectedRequest || e instanceof RateLimited) return e;
  if (!e || typeof e !== "object") return e;
  const data = (e as { data?: any }).data;
  const message = (e as { message?: unknown }).message;
  const text = typeof message === "string" ? message : String(e);
  if (data && typeof data === "object") {
    if (data.kind === "rejected") return new RejectedRequest(text);
    if (data.kind === "rate_limited") {
      const wait = typeof data.waitMs === "number" ? data.waitMs : null;
      return new RateLimited(text, wait, data.resourceOnly === true);
    }
  }
  return e;
}

/** The inverse of `reviveError`: what the github mod throws so the kind survives RPC. */
export function errorData(e: unknown): { kind: "rejected" | "rate_limited"; waitMs?: number | null; resourceOnly?: boolean } | null {
  if (!e || typeof e !== "object") return null;
  const x = e as { rateLimited?: unknown; rejected?: unknown; name?: unknown; waitMs?: unknown; resourceOnly?: unknown; data?: any };
  if (e instanceof RateLimited || x.rateLimited === true || x.name === "RateLimited") {
    return { kind: "rate_limited", waitMs: typeof x.waitMs === "number" ? x.waitMs : null, resourceOnly: x.resourceOnly === true };
  }
  if (e instanceof RejectedRequest || x.rejected === true || x.name === "RejectedRequest") return { kind: "rejected" };
  // Already carried over RPC once (a mod passing on what it got).
  if (x.data && typeof x.data === "object" && (x.data.kind === "rejected" || x.data.kind === "rate_limited")) return x.data;
  return null;
}

// Referenced so the interface stays obvious to readers of this file.
export type { Memo, Notified, RateLimited, RejectedRequest };
