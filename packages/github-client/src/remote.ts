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

export function remoteGithub(call: ModCall, host = "github.com"): Github {
  throw new Error("not ported yet: remoteGithub");
}

/** Turn an error that crossed RPC back into RejectedRequest / RateLimited where it was one. */
export function reviveError(e: unknown): unknown {
  throw new Error("not ported yet: reviveError");
}

/** The inverse of `reviveError`: what the github mod throws so the kind survives RPC. */
export function errorData(e: unknown): { kind: "rejected" | "rate_limited"; waitMs?: number | null; resourceOnly?: boolean } | null {
  throw new Error("not ported yet: errorData");
}

// Referenced so the interface stays obvious to readers of this file.
export type { Memo, Notified, RateLimited, RejectedRequest };
