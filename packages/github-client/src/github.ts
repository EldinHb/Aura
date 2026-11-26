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

export const LOGIN_EXPIRED = "GitHub login expired. Run `gh auth login`; Aura reconnects by itself.";
export const NO_GH = "Install GitHub CLI and run `gh auth login` to connect pull requests.";

/**
 * The parts of the former trait's default methods a hand-written `Github` can
 * reuse: `requestFor` that checks the account, and `account` read from `GET user`.
 */
export const defaults = {
  async requestFor(gh: Github, account: string, method: string, path: string, body?: unknown): Promise<any> {
    if ((await gh.account()) !== account) throw new RejectedRequest("GitHub account changed");
    return gh.request(method, path, body);
  },
  async account(gh: Github): Promise<string> {
    const user = await gh.request("GET", "user");
    const login = user?.login;
    if (typeof login !== "string") throw new Error("GitHub did not return an account");
    return `${gh.host()}:${login}`;
  },
};

/** Whether `e` means GitHub refused (former `transport::rejected`). Survives RPC: checks `name`/flags and messages. */
export function rejected(e: unknown): boolean {
  if (e instanceof RejectedRequest || e instanceof RateLimited) return true;
  if (!e || typeof e !== "object") return false;
  const x = e as { name?: unknown; rejected?: unknown; rateLimited?: unknown; data?: any; message?: unknown };
  if (x.rejected === true || x.rateLimited === true) return true;
  if (x.name === "RejectedRequest" || x.name === "RateLimited") return true;
  const kind = x.data && typeof x.data === "object" ? x.data.kind : undefined;
  if (kind === "rejected" || kind === "rate_limited") return true;
  // A refused login is always a refusal, whatever carried it.
  return x.message === LOGIN_EXPIRED;
}

const SAFE = /^[A-Za-z0-9_.-]+$/;

export function validateRepo(repo: string): void {
  const parts = repo.split("/");
  if (parts.length !== 2 || parts.some((p) => !p || p === "." || p === ".." || !SAFE.test(p))) {
    throw new Error("Invalid repository");
  }
}

export function validateSha(sha: string): void {
  if (sha.length !== 40 || !/^[0-9a-fA-F]+$/.test(sha)) throw new Error("Invalid commit SHA");
}

/** Every page of a REST list (100 per page). */
export async function pages(gh: Github, path: string): Promise<any[]> {
  const all: any[] = [];
  for (let page = 1; page <= 1000; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const data = await gh.request("GET", `${path}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(data)) throw new Error("Expected a GitHub list");
    all.push(...data);
    if (data.length < 100) return all;
  }
  throw new Error("GitHub pagination limit exceeded; previous cache retained");
}

/** Former `database_id`: a node's REST id, `fullDatabaseId` (a string, as the ids outgrew GraphQL's Int) or `databaseId`. */
export function databaseId(n: any): number | null {
  const full = n?.fullDatabaseId;
  if (typeof full === "string") {
    if (!/^\d+$/.test(full)) return null;
    const id = Number(full);
    return Number.isSafeInteger(id) ? id : null;
  }
  if (typeof full === "number") return u64(full);
  return u64(n?.databaseId);
}

/** Former `s(v, key)`: the string at `key`, or "". */
export function s(v: any, key: string): string {
  const x = v?.[key];
  return typeof x === "string" ? x : "";
}

/** Former `Value::as_u64`: a non-negative integer, or null. */
export function u64(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/** Former `Value::get(key).is_some()`: the object has `key`, whatever its value. */
export function has(v: unknown, key: string): boolean {
  return !!v && typeof v === "object" && !Array.isArray(v) && key in (v as object);
}

/** Former `Value::as_array().into_iter().flatten()`. */
export function list(v: unknown): any[] {
  return Array.isArray(v) ? v : [];
}

/** Compact JSON of a value, as Rust's `Value` displays it (`null` when missing). */
export function show(v: unknown): string {
  return JSON.stringify(v === undefined ? null : v);
}

export const sameText = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Run `fn` over `items` at most `limit` at a time, keeping their order (former `buffered(n)` + `try_collect`). */
export async function buffered<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** `items` in chunks of `size`. */
export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The message of anything thrown. */
export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
