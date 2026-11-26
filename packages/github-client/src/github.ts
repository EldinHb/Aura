// The transport interface (former `trait Github`) and its errors.
import type { Memo, Notified } from "./activity";

export interface Github {
  /** A REST path ("repos/o/r/pulls/1"), "graphql", or a full https URL. Resolves with the parsed JSON body. */
  request(method: string, path: string, body?: unknown): Promise<any>;
  /** Like `request`, but refuses with `RejectedRequest` when the signed-in account is not `account`. */
  requestFor(account: string, method: string, path: string, body?: unknown): Promise<any>;
  /** The unified diff between `base` and `head` in `repo`. */
  diff(repo: string, base: string, head: string): Promise<string>;
  host(): string;
  /** "host:login" of the signed-in account. */
  account(): Promise<string>;
  /** Why GitHub is left alone for now (expired login, rate limit), or null. */
  blocked(): Promise<string | null>;
  /** How long a loop that polls every `baseMs` waits now (longer as the rate limit runs low). */
  pace(baseMs: number): Promise<number>;
  /** PRs with recent notification activity, or null when that cannot be told. */
  notified(): Promise<Notified | null>;
  /** Answers shared between loops in the same runtime, or null. */
  memo(): Memo | null;
}

/** GitHub refused the request as such (not a transient failure). Former `RejectedRequest`. */
export class RejectedRequest extends Error {
  readonly rejected = true;
  constructor(message: string) {
    super(message);
    this.name = "RejectedRequest";
  }
}

/** A rate limit was hit. Former `RateLimited`. */
export class RateLimited extends Error {
  readonly rateLimited = true;
  constructor(
    message: string,
    public waitMs: number | null,
    public resourceOnly: boolean,
  ) {
    super(message);
    this.name = "RateLimited";
  }
}

export const LOGIN_EXPIRED = "GitHub login expired. Run `gh auth login` to sign in again.";
export const NO_GH = "GitHub CLI is not installed or not signed in. Install `gh` and run `gh auth login`.";

/** Whether `e` means GitHub refused (former `transport::rejected`). Survives RPC: checks `name`/flags and messages. */
export function rejected(e: unknown): boolean {
  throw new Error("not ported yet: rejected");
}

export function validateRepo(repo: string): void {
  throw new Error("not ported yet: validateRepo");
}

export function validateSha(sha: string): void {
  throw new Error("not ported yet: validateSha");
}

/** Every page of a REST list (100 per page). */
export async function pages(gh: Github, path: string): Promise<any[]> {
  throw new Error("not ported yet: pages");
}

/** Former `database_id`. */
export function databaseId(n: any): number | null {
  throw new Error("not ported yet: databaseId");
}

/** Former `s(v, key)`: the string at `key`, or "". */
export function s(v: any, key: string): string {
  const x = v?.[key];
  return typeof x === "string" ? x : "";
}
