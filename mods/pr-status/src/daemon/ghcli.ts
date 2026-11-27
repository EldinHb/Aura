// The mod's own way to GitHub: the GitHub CLI run through `aura.process` (`gh api -i`), as a
// `Github` for the shared client's functions. It paces by the rate-limit headers GitHub sends,
// says plainly when gh is missing, signed out or its token expired, polls notifications
// conditionally, and checks the signed-in account right before a write made for one.
import type { DaemonApi } from "@aura/mod-sdk";
import type { ProcessResult } from "@aura/mod-sdk/daemon";
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

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const json = (body: string): any => {
  const t = body.trim();
  return t ? JSON.parse(t) : null;
};

/** What gh said when it did not get as far as a response. */
function noResponse(stderr: string): Error {
  if (/auth login|not logged|no oauth token|authentication required/i.test(stderr)) return new RejectedRequest(NOT_SIGNED_IN);
  return new Error(stderr.trim().split("\n").slice(-1)[0] || "GitHub CLI failed");
}

/** The only host this mod talks to; gh is told so on every call, whatever GH_HOST says. */
export const HOST = "github.com";
/** gh calls at once, at most. */
export const MAX_CONCURRENT = 4;
/** What could send gh to another host or have it use another identity: removed from its environment. */
const PINNED_ENV: Record<string, string | null> = { GH_HOST: null, GH_ENTERPRISE_TOKEN: null, GITHUB_ENTERPRISE_TOKEN: null };

/** Something that can run a merge as one account: with one token, read once, for every request. */
export interface Pinning {
  pinned<T>(account: string, fn: (gh: Github) => Promise<T>): Promise<T>;
}

export class GhCli implements Github, Pinning {
  private readonly now: () => number;
  private budgets = new Map<string, Budget>();
  /** Why gh cannot be used now (missing, signed out, expired), and when that was last checked. */
  private problem: { reason: string; at: number } | null = null;
  private login: { value: string; at: number } | null = null;
  /** gh answered at least once (or `gh auth status` said it works): no check needed before reading. */
  private verified = false;
  private notes: { at: number; everyMs: number; lastModified: string | null; last: Notified | null } | null = null;
  /** No request before this (ms): a Retry-After, or a spent primary limit until its reset. */
  private pausedUntil = 0;
  private running = 0;
  private waiting: Array<() => void> = [];

  constructor(private readonly aura: DaemonApi, opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  host(): string {
    return HOST;
  }

  memo(): null {
    return null;
  }

  async diff(): Promise<string> {
    throw new Error("diff is not read by this mod");
  }

  /** A rate-limit pause in force for `resource` (or for all), as the error a request gets. */
  private paused(resource: string | null): RateLimited | null {
    const now = this.now();
    if (now < this.pausedUntil) return new RateLimited(`GitHub asked to wait; paused until ${clock(this.pausedUntil)}`, this.pausedUntil - now, false);
    const b = resource ? this.budgets.get(resource) : undefined;
    if (b && b.remaining === 0 && b.reset * 1000 > now) return new RateLimited(`GitHub's ${resource} rate limit is spent until ${clock(b.reset * 1000)}`, b.reset * 1000 - now, true);
    return null;
  }

  /**
   * The gate every gh call goes through: refused while paused or while the call's rate-limit
   * resource is spent, at most MAX_CONCURRENT at once, pinned to github.com, with `token` (if
   * given) in the environment only.
   */
  private async gh(args: string[], o: { resource: string | null; stdin?: string; token?: string; settle?: (out: ProcessResult) => void }) {
    const early = this.paused(o.resource);
    if (early) throw early;
    while (this.running >= MAX_CONCURRENT) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running++;
    try {
      // Checked again right before sending: an answer that came in while this call waited may have paused all.
      const pause = this.paused(o.resource);
      if (pause) throw pause;
      const env = o.token ? { ...PINNED_ENV, GH_TOKEN: o.token, GITHUB_TOKEN: null } : PINNED_ENV;
      let out: ProcessResult;
      try {
        out = await this.aura.process.run("gh", args, { stdin: o.stdin, env, timeoutMs: 60_000 });
      } catch {
        this.problem = { reason: NO_GH, at: this.now() };
        throw new RejectedRequest(NO_GH);
      }
      // The answer's rate limits count before the slot goes to the next call.
      o.settle?.(out);
      return out;
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  /** Run `gh api -i <args>` against github.com; GitHub's answer, whatever its status. */
  async api(args: string[], stdin?: string, token?: string): Promise<GhReply> {
    const resource = args[0] === "graphql" ? "graphql" : "core";
    let reply: GhReply | null = null;
    const out = await this.gh(["api", "--hostname", HOST, "-i", ...args], {
      resource, stdin, token,
      settle: (o) => {
        reply = parseReply(o.stdout);
        if (reply) this.note(reply);
      },
    });
    // Set by `settle`, inside the gate.
    const answer = reply as GhReply | null;
    if (!answer) {
      const e = noResponse(out.stderr);
      if (e instanceof RejectedRequest) this.problem = { reason: e.message, at: this.now() };
      throw e;
    }
    // Refused: the login (or its rights) may have changed; ask who is signed in next time.
    if (answer.status === 401 || answer.status === 403) this.login = null;
    if (answer.status === 401) {
      this.problem = { reason: LOGIN_EXPIRED, at: this.now() };
      throw new RejectedRequest(LOGIN_EXPIRED);
    }
    this.problem = null;
    this.verified = true;
    return answer;
  }

  /** What an answer says of the rate limits: the budget it reports, and a pause it asks for. */
  private note(reply: GhReply): void {
    const h = reply.headers;
    this.budget(h);
    const spent = h["x-ratelimit-remaining"] === "0";
    if ((reply.status === 403 || reply.status === 429) && (spent || "retry-after" in h || /rate limit/i.test(reply.body))) {
      // A secondary limit without Retry-After: a minute, as GitHub's docs advise.
      const wait = "retry-after" in h ? Number(h["retry-after"]) * 1000 : spent ? Number(h["x-ratelimit-reset"]) * 1000 - this.now() : 60_000;
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + (Number.isFinite(wait) ? Math.max(0, wait) : 60_000));
    }
  }

  /**
   * Keep a resource's budget as an answer reports it. Answers can arrive out of order: within the
   * same reset window the lowest `remaining` stands, and an older window does not replace a newer.
   */
  private budget(h: Record<string, string>): void {
    const resource = h["x-ratelimit-resource"];
    const limit = Number(h["x-ratelimit-limit"]);
    const remaining = Number(h["x-ratelimit-remaining"]);
    const reset = Number(h["x-ratelimit-reset"]);
    if (!resource || ![limit, remaining, reset].every(Number.isFinite)) return;
    const known = this.budgets.get(resource);
    if (known && reset < known.reset) return;
    if (known && reset === known.reset && remaining >= known.remaining) return;
    this.budgets.set(resource, { resource, limit, remaining, reset });
  }

  /** An answer of 400 and up as the client's errors: rate limits (which pause the gate), refusals, failures. */
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
      // A secondary limit without Retry-After: a minute, as GitHub's docs advise.
      // The gate's pause was set when the answer came in (note); the error says how long.
      return new RateLimited(message, Math.max(0, this.pausedUntil - this.now()), spent && !("retry-after" in h));
    }
    if ([400, 403, 404, 405, 422, 429].includes(reply.status)) return new RejectedRequest(message);
    return new Error(message);
  }

  request(method: string, path: string, body?: unknown): Promise<any> {
    return this.send(method, path, body);
  }

  /** A request, with `token` (a pinned merge's) instead of gh's active login. */
  private async send(method: string, path: string, body: unknown, token?: string): Promise<any> {
    const url = path.startsWith("https://") ? new URL(path) : null;
    if (url && url.hostname !== HOST && url.hostname !== `api.${HOST}`) throw new RejectedRequest(`Not a ${HOST} URL`);
    const endpoint = url ? url.pathname.replace(/^\//, "") + url.search : path;
    const args = [endpoint, "-X", method];
    if (body !== undefined) args.push("--input", "-");
    const reply = await this.api(args, body === undefined ? undefined : JSON.stringify(body), token);
    if (reply.status >= 400) throw this.failure(reply);
    const data = json(reply.body);
    if (path === "graphql" && data && !data.data && Array.isArray(data.errors)) {
      const message = data.errors.map((e: any) => e?.message).filter(Boolean).join("; ");
      if (data.errors.some((e: any) => e?.type === "RATE_LIMITED")) {
        this.pausedUntil = Math.max(this.pausedUntil, this.now() + 60_000);
        throw new RateLimited(message, 60_000, true);
      }
      throw new Error(message || "GitHub did not answer the query");
    }
    return data;
  }

  /** "github.com:<login>" of the account gh uses (or `token` is for). */
  private async whoAmI(token?: string): Promise<string> {
    const reply = await this.api(["user"], undefined, token);
    if (reply.status >= 400) throw this.failure(reply);
    const login = json(reply.body)?.login;
    if (typeof login !== "string" || !login) throw new Error("GitHub did not say who is signed in");
    return `${HOST}:${login}`;
  }

  /** "github.com:<login>" of gh's signed-in account (kept for ACCOUNT_MS). */
  async account(fresh = false): Promise<string> {
    if (!fresh && this.login && this.now() - this.login.at < ACCOUNT_MS) return this.login.value;
    const value = await this.whoAmI();
    // Another account has budgets of its own.
    if (this.login && this.login.value !== value) this.budgets.clear();
    this.login = { value, at: this.now() };
    return this.login.value;
  }

  /** As `request`, after checking right now that gh is signed in to `account`; refused otherwise. */
  async requestFor(account: string, method: string, path: string, body?: unknown): Promise<any> {
    const now = await this.account(true);
    if (now !== account) throw new RejectedRequest(`GitHub account changed: gh is signed in as ${now.split(":")[1]} now`);
    return this.request(method, path, body);
  }

  /**
   * Run `fn` as `account`, with one token for all of it: read once (`gh auth token`), checked to
   * be `account`'s, and given to every request through the environment (GH_TOKEN), so switching
   * gh's account meanwhile changes nothing. The token is never in an argument, a log or storage,
   * and is let go when `fn` is done.
   */
  async pinned<T>(account: string, fn: (gh: Github) => Promise<T>): Promise<T> {
    const out = await this.gh(["auth", "token", "--hostname", HOST], { resource: null });
    let token: string | null = out.code === 0 ? out.stdout.trim() : "";
    if (!token) throw new RejectedRequest(NOT_SIGNED_IN);
    try {
      const login = await this.whoAmI(token);
      if (login !== account) {
        // The account kept for reads is stale too: the next read asks again, so the cards (and a
        // new confirmation) show who is signed in now.
        this.login = null;
        throw new RejectedRequest(`GitHub account changed: gh is signed in as ${login.split(":")[1]} now`);
      }
      const t = token;
      const view: Github = {
        request: (method, path, body) => this.send(method, path, body, t),
        requestFor: async (acc, method, path, body) => {
          if (acc !== account) throw new RejectedRequest("GitHub account changed");
          return this.send(method, path, body, t);
        },
        account: async () => account,
        diff: () => this.diff(),
        host: () => HOST,
        blocked: () => this.blocked(),
        pace: (base) => this.pace(base),
        notified: async () => null,
        memo: () => null,
      };
      return await fn(view);
    } finally {
      token = null;
    }
  }

  /** Why GitHub is left alone now: gh missing, signed out, an expired token, a pause, or a spent rate limit. */
  async blocked(): Promise<string | null> {
    // Before the first read, and a minute after a problem: `gh auth status` tells whether gh works,
    // so the first answer already says why nothing can be read.
    if (this.problem ? this.now() - this.problem.at >= RECHECK_MS : !this.verified) {
      try {
        // Only the active account: another (inactive) account's expired token is not this one's problem.
        const out = await this.gh(["auth", "status", "--active", "--hostname", HOST], { resource: null });
        if (out.code === 0) {
          this.problem = null;
          this.verified = true;
        } else this.problem = { reason: /expired|invalid/i.test(out.stderr + out.stdout) ? LOGIN_EXPIRED : NOT_SIGNED_IN, at: this.now() };
      } catch {
        this.problem = { reason: NO_GH, at: this.now() };
      }
    }
    if (this.problem) return this.problem.reason;
    if (this.now() < this.pausedUntil) return `GitHub asked to wait; paused until ${clock(this.pausedUntil)}.`;
    const nowSec = this.now() / 1000;
    for (const b of this.budgets.values()) {
      if ((b.resource === "core" || b.resource === "graphql") && b.remaining === 0 && b.reset > nowSec) {
        return `GitHub's rate limit is reached; waiting until ${clock(b.reset * 1000)}.`;
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
