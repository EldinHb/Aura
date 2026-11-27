// The mod's own way to GitHub: the GitHub CLI run through `aura.process` (`gh api -i`), as a
// `Github` for the shared client's functions. It paces by the rate-limit headers GitHub sends,
// says plainly when gh is missing, signed out or its token expired, polls notifications
// conditionally, and checks the signed-in account right before a write made for one.
import type { DaemonApi } from "@aura/mod-sdk";
import { LOGIN_EXPIRED, NO_GH, Notified, pace, RateLimited, RejectedRequest, type Budget, type Github } from "@aura/github-client";

export const NOT_SIGNED_IN = "GitHub CLI is not signed in. Run `gh auth login`; Aura reconnects by itself.";
/** A missing gh or a sign-in problem is looked at again this often. */
export const RECHECK_MS = 60_000;
/** Notifications are asked for at most this often (or as GitHub's X-Poll-Interval says). */
export const NOTIFY_MS = 60_000;
/** Reads reuse the signed-in login this long; a merge write, and any 401 or 403, check it again. */
export const ACCOUNT_MS = 15 * 60_000;
const NOTIFY_PAGE = 50;

export interface GhReply {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string>;
  body: string;
}

/** `gh api -i` output: the status line, the headers, a blank line, the body. Null when gh printed no response. */
export function parseReply(stdout: string): GhReply | null {
  const text = stdout.replace(/\r\n/g, "\n");
  const m = /^HTTP\/[\d.]+ (\d{3})[^\n]*\n/.exec(text);
  if (!m) return null;
  const end = text.indexOf("\n\n", m[0].length - 1);
  const head = end < 0 ? text.slice(m[0].length) : text.slice(m[0].length, end);
  const headers: Record<string, string> = {};
  for (const line of head.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(m[1]), headers, body: end < 0 ? "" : text.slice(end + 2) };
}

const json = (body: string): any => {
  const t = body.trim();
  return t ? JSON.parse(t) : null;
};

/** What gh said when it did not get as far as a response. */
function noResponse(stderr: string): Error {
  if (/auth login|not logged|no oauth token|authentication required/i.test(stderr)) return new RejectedRequest(NOT_SIGNED_IN);
  return new Error(stderr.trim().split("\n").slice(-1)[0] || "GitHub CLI failed");
}

export class GhCli implements Github {
  private readonly now: () => number;
  private budgets = new Map<string, Budget>();
  /** Why gh cannot be used now (missing, signed out, expired), and when that was last checked. */
  private problem: { reason: string; at: number } | null = null;
  private login: { value: string; at: number } | null = null;
  private notes: { at: number; everyMs: number; lastModified: string | null; last: Notified | null } | null = null;

  constructor(private readonly aura: DaemonApi, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  host(): string {
    return "github.com";
  }

  memo(): null {
    return null;
  }

  async diff(): Promise<string> {
    throw new Error("diff is not read by this mod");
  }

  /** Run `gh api -i <args>`; GitHub's answer, whatever its status. */
  async api(args: string[], stdin?: string): Promise<GhReply> {
    let out;
    try {
      out = await this.aura.process.run("gh", ["api", "-i", ...args], { stdin, timeoutMs: 60_000 });
    } catch {
      this.problem = { reason: NO_GH, at: this.now() };
      throw new RejectedRequest(NO_GH);
    }
    const reply = parseReply(out.stdout);
    if (!reply) {
      const e = noResponse(out.stderr);
      if (e instanceof RejectedRequest) this.problem = { reason: e.message, at: this.now() };
      throw e;
    }
    this.budget(reply.headers);
    // Refused: the login (or its rights) may have changed; ask who is signed in next time.
    if (reply.status === 401 || reply.status === 403) this.login = null;
    if (reply.status === 401) {
      this.problem = { reason: LOGIN_EXPIRED, at: this.now() };
      throw new RejectedRequest(LOGIN_EXPIRED);
    }
    this.problem = null;
    return reply;
  }

  private budget(h: Record<string, string>): void {
    const resource = h["x-ratelimit-resource"];
    const limit = Number(h["x-ratelimit-limit"]);
    const remaining = Number(h["x-ratelimit-remaining"]);
    const reset = Number(h["x-ratelimit-reset"]);
    if (!resource || ![limit, remaining, reset].every(Number.isFinite)) return;
    this.budgets.set(resource, { resource, limit, remaining, reset });
  }

  /** An answer of 400 and up as the client's errors: rate limits, refusals, failures. */
  private failure(reply: GhReply): Error {
    let said: string | null = null;
    try {
      said = json(reply.body)?.message ?? null;
    } catch {
      // not JSON
    }
    const message = `${said ?? (reply.body.trim().slice(0, 300) || "GitHub refused")} (HTTP ${reply.status})`;
    const h = reply.headers;
    const spent = h["x-ratelimit-remaining"] === "0";
    if ((reply.status === 403 || reply.status === 429) && (spent || "retry-after" in h || /rate limit/i.test(message))) {
      const wait = "retry-after" in h ? Number(h["retry-after"]) * 1000 : spent ? Number(h["x-ratelimit-reset"]) * 1000 - this.now() : null;
      return new RateLimited(message, wait !== null && Number.isFinite(wait) ? Math.max(0, wait) : null, spent && !("retry-after" in h));
    }
    if ([400, 403, 404, 405, 422, 429].includes(reply.status)) return new RejectedRequest(message);
    return new Error(message);
  }

  async request(method: string, path: string, body?: unknown): Promise<any> {
    const endpoint = path.startsWith("https://") ? new URL(path).pathname.replace(/^\//, "") + new URL(path).search : path;
    const args = [endpoint, "-X", method];
    if (body !== undefined) args.push("--input", "-");
    const reply = await this.api(args, body === undefined ? undefined : JSON.stringify(body));
    if (reply.status >= 400) throw this.failure(reply);
    const data = json(reply.body);
    if (path === "graphql" && data && !data.data && Array.isArray(data.errors)) {
      const message = data.errors.map((e: any) => e?.message).filter(Boolean).join("; ");
      if (data.errors.some((e: any) => e?.type === "RATE_LIMITED")) throw new RateLimited(message, null, true);
      throw new Error(message || "GitHub did not answer the query");
    }
    return data;
  }

  /** "github.com:<login>" of gh's signed-in account. */
  async account(fresh = false): Promise<string> {
    if (!fresh && this.login && this.now() - this.login.at < ACCOUNT_MS) return this.login.value;
    const reply = await this.api(["user"]);
    if (reply.status >= 400) throw this.failure(reply);
    const login = json(reply.body)?.login;
    if (typeof login !== "string" || !login) throw new Error("GitHub did not say who is signed in");
    this.login = { value: `${this.host()}:${login}`, at: this.now() };
    return this.login.value;
  }

  /** As `request`, after checking right now that gh is signed in to `account`; refused otherwise. */
  async requestFor(account: string, method: string, path: string, body?: unknown): Promise<any> {
    const now = await this.account(true);
    if (now !== account) throw new RejectedRequest(`GitHub account changed: gh is signed in as ${now.split(":")[1]} now`);
    return this.request(method, path, body);
  }

  /** Why GitHub is left alone now: gh missing, signed out, an expired token, or a spent rate limit. */
  async blocked(): Promise<string | null> {
    if (this.problem) {
      if (this.now() - this.problem.at < RECHECK_MS) return this.problem.reason;
      // Looked at again: `gh auth status` tells whether it works now.
      try {
        const out = await this.aura.process.run("gh", ["auth", "status"], { timeoutMs: 30_000 });
        if (out.code === 0) this.problem = null;
        else this.problem = { reason: /expired|invalid/i.test(out.stderr + out.stdout) ? LOGIN_EXPIRED : NOT_SIGNED_IN, at: this.now() };
      } catch {
        this.problem = { reason: NO_GH, at: this.now() };
      }
      if (this.problem) return this.problem.reason;
    }
    const nowSec = this.now() / 1000;
    for (const b of this.budgets.values()) {
      if ((b.resource === "core" || b.resource === "graphql") && b.remaining === 0 && b.reset > nowSec) {
        return `GitHub's rate limit is reached; waiting until ${new Date(b.reset * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`;
      }
    }
    return null;
  }

  async pace(baseMs: number): Promise<number> {
    return pace(baseMs, [...this.budgets.values()], this.now() / 1000);
  }

  /**
   * PRs with recent notification activity: at most once per NOTIFY_MS (or X-Poll-Interval),
   * conditional on the last answer's Last-Modified. Null when they cannot be read.
   */
  async notified(): Promise<Notified | null> {
    const notes = this.notes;
    if (notes && this.now() - notes.at < notes.everyMs) return notes.last;
    try {
      const args = [`notifications?per_page=${NOTIFY_PAGE}`];
      if (notes?.lastModified) args.push("-H", `If-Modified-Since: ${notes.lastModified}`);
      const reply = await this.api(args);
      const everyMs = Math.max(NOTIFY_MS, (Number(reply.headers["x-poll-interval"]) || 0) * 1000);
      if (reply.status === 304) {
        this.notes = { ...notes!, at: this.now(), everyMs };
        return notes!.last;
      }
      if (reply.status >= 400) throw this.failure(reply);
      const last = Notified.parse(json(reply.body), NOTIFY_PAGE);
      this.notes = { at: this.now(), everyMs, lastModified: reply.headers["last-modified"] ?? null, last };
      return last;
    } catch {
      // No notifications scope, say: PRs are then read on their schedule only.
      this.notes = { at: this.now(), everyMs: NOTIFY_MS * 5, lastModified: null, last: null };
      return null;
    }
  }
}
